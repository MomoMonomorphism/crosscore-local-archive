"""Extract the game's multi-picture touch contract without guessing from animation names.

CfgArchiveMultiPicture supplies the displayed Spine/static image. RoleSpineItem2
reads CfgSpineMultiImageAction for dynamic pictures; RoleSpineItem1 reads
CfgMultiImageAction for static ones. CfgSound connects each configured audioId
back to a picture ACB, including banks whose ACB stem differs from archive.img.

Output: cache/multi_picture_action.generated.json. Game files are read-only.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import time
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any

from asset_cache import DEFAULT_SOURCE
from lua_bundle import DEFAULT_LUA_BUNDLE, get_bundle
from luatable import parse_config
from spine_action import audio_ids_of, interlude_default_of, pose_contracts, pose_space_of, remap_rects, touches_of
from voice_semantics import fold_label, load_sound_book
from interaction_corrections import apply_corrections


ROOT = Path(__file__).resolve().parent
from runtime_paths import PATHS
DEFAULT_OUT = PATHS['cache'] / "multi_picture_action.generated.json"


def key(value: str | None) -> str:
    return re.sub(r"spine$", "", re.sub(r"[^a-z0-9]", "", (value or "").lower()))


def image_key(value: str | None) -> str:
    return re.sub(r"[^a-z0-9]", "", (value or "").lower())


def matching_variant(gallery: dict[str, Any], name: str | None) -> list[tuple[str, str]]:
    wanted = key(name)
    if not wanted:
        return []
    matches: list[tuple[str, str]] = []
    for entry in gallery["entries"]:
        # Archive pictures can reference a skeleton catalogued as a character
        # (for example Katina), as well as a CG. Match the configured exact
        # folder/source name rather than assuming its catalog category.
        if entry["category"] not in ("cg", "character"):
            continue
        for variant in entry["variants"]:
            main = variant["main"]
            if wanted in (key(main["folder"]), key(main["sourceName"])):
                matches.append((entry["id"], variant["id"]))
    return matches


def build(
    gallery: dict[str, Any], voices: dict[str, Any], source: Path = DEFAULT_SOURCE
) -> dict[str, Any]:
    bundle = get_bundle()
    archive_rows = parse_config(bundle.read("cfgCfgArchiveMultiPicture.lua"))
    illustration_rows = parse_config(bundle.read("cfgCfgArchiveIllustration.lua"))
    dynamic_rows = parse_config(bundle.read("cfgCfgSpineMultiImageAction.lua"))
    static_rows = parse_config(bundle.read("cfgCfgMultiImageAction.lua"))
    archive = {int(row["id"]): row for row in archive_rows}
    if len(archive) != len(archive_rows):
        raise ValueError("duplicate CfgArchiveMultiPicture id")

    dynamic_rows, corrections = apply_corrections('cfgCfgSpineMultiImageAction.lua', dynamic_rows, archive)

    models = {str(row["id"]): touches_of(row) for row in dynamic_rows}
    display = {str(row["id"]): row for row in archive_rows}
    poses = pose_contracts(models, display, source)
    space_memo: dict[str, Any] = {}
    for model_id, contract in poses.items():
        for role, pose in contract["poses"].items():
            space = pose_space_of(source, pose, space_memo)
            pose["touchSpace"] = space
            remap_rects(
                [row for row in models[model_id] if row["pose"] == int(role)], space
            )
    interlude_defaults = {}
    for name in sorted({row["poseSwitch"]["interludeSpine"]
                        for rows in models.values() for row in rows
                        if row.get("poseSwitch") and row["poseSwitch"].get("interludeSpine")}):
        default = interlude_default_of(source / ("prefabs_spine_" + name.lower()))
        if default:
            interlude_defaults[name] = default

    entry_by_model: dict[str, str] = {}
    variant_by_model: dict[str, str] = {}
    unmapped_models: list[dict[str, Any]] = []
    for row in dynamic_rows:
        model_id = str(row["id"])
        matches = matching_variant(gallery, archive[row["id"]].get("l2dName"))
        if len(matches) == 1:
            entry_by_model[model_id], variant_by_model[model_id] = matches[0]
        else:
            unmapped_models.append({
                "modelId": row["id"], "l2dName": archive[row["id"]].get("l2dName"),
                "matches": matches,
            })

    # CfgSound is keyed by cue sheet + cue name. A touch audioId can therefore
    # identify an archive row even when its img token differs from the ACB name.
    sound_by_id: dict[int, list[tuple[str, str]]] = defaultdict(list)
    for (sheet, cue), row in load_sound_book().items():
        if isinstance(row.get("audioId"), int):
            sound_by_id[row["audioId"]].append((sheet.lower(), cue))
    sheet_by_archive: dict[str, Counter[int]] = defaultdict(Counter)
    for row in [*dynamic_rows, *static_rows]:
        for item in row.get("item", []):
            for audio_id in audio_ids_of(item.get("audioId")):
                for sheet, _cue in sound_by_id.get(audio_id, []):
                    sheet_by_archive[sheet][row["id"]] += 1

    direct_by_img: dict[str, list[int]] = defaultdict(list)
    for row in archive_rows:
        direct_by_img[image_key(row.get("img"))].append(row["id"])

    picture_links: dict[str, dict[str, Any]] = {}
    unresolved_pictures: list[str] = []
    stream_by_cue: dict[tuple[str, str], tuple[str, int]] = {}
    for bank in voices.get("pictureEntries", {}).values():
        sheet = "picture/" + bank["sourceFile"].lower()
        stem = Path(bank["sourceFile"]).stem
        direct = direct_by_img.get(image_key(stem), [])
        via_audio = list(sheet_by_archive.get(sheet, {}))
        candidates = direct if len(direct) == 1 else via_audio
        if len(candidates) != 1 or (direct and via_audio and set(direct) != set(via_audio)):
            unresolved_pictures.append(bank["id"])
        else:
            cfg = archive[candidates[0]]
            picture_links[bank["id"]] = {
                "archiveId": cfg["id"], "l2dName": cfg.get("l2dName") or "",
                "img": cfg.get("img") or "", "icon": cfg.get("icon") or "",
                "evidence": "archive-img" if direct else "touch-audio",
                "entryMatches": matching_variant(gallery, cfg.get("l2dName")),
            }
        for stream in bank["streams"]:
            stream_by_cue[(sheet, stream["name"])] = (bank["id"], stream["index"])

    used_audio = {
        audio_id for rows in [*dynamic_rows, *static_rows]
        for item in rows.get("item", []) for audio_id in audio_ids_of(item.get("audioId"))
    }
    audio_lookup: dict[str, dict[str, Any]] = {}
    for audio_id in sorted(used_audio):
        destinations = {
            stream_by_cue[(sheet, cue)]
            for sheet, cue in sound_by_id.get(audio_id, [])
            if (sheet, cue) in stream_by_cue
        }
        if len(destinations) == 1:
            bank_id, index = destinations.pop()
            audio_lookup[str(audio_id)] = {"bankId": bank_id, "streamIndex": index}

    # Several current cfgSound blocks are damaged. In surviving picture banks,
    # the touch audio ID ends in the numeric ACB cue suffix. Recover only when
    # the archive has a unique bank and all surviving pairs agree on its base.
    # A bank with no surviving pairs additionally needs an exact archive.img
    # link and one unambiguous hundred-ID group in its touch configuration.
    used_by_archive: dict[int, set[int]] = defaultdict(set)
    for row in [*dynamic_rows, *static_rows]:
        for item in row.get("item", []):
            used_by_archive[row["id"]].update(audio_ids_of(item.get("audioId")))
    banks_by_archive: dict[int, list[str]] = defaultdict(list)
    for bank_id, link in picture_links.items():
        banks_by_archive[link["archiveId"]].append(bank_id)
    banks = voices.get("pictureEntries", {})
    inferred_audio = 0
    for archive_id, audio_ids in used_by_archive.items():
        linked = banks_by_archive.get(archive_id, [])
        if len(linked) != 1:
            continue
        bank_id = linked[0]
        bank = banks[bank_id]
        stem = Path(bank["sourceFile"]).stem
        cues: dict[int, list[int]] = defaultdict(list)
        suffix_by_index: dict[int, int] = {}
        for stream in bank["streams"]:
            match = re.fullmatch(r"(.+)_(\d+)", stream["name"])
            if match and image_key(match[1]) == image_key(stem):
                suffix = int(match[2])
                cues[suffix].append(stream["index"])
                suffix_by_index[stream["index"]] = suffix
        bases = {
            audio_id - suffix_by_index[location["streamIndex"]]
            for audio_id in audio_ids
            if (location := audio_lookup.get(str(audio_id)))
            and location["bankId"] == bank_id
            and location["streamIndex"] in suffix_by_index
        }
        if len(bases) > 1:
            continue
        if bases:
            base = next(iter(bases))
        else:
            if picture_links[bank_id]["evidence"] != "archive-img":
                continue
            groups = {audio_id // 100 for audio_id in audio_ids}
            if len(groups) != 1:
                continue
            base = next(iter(groups)) * 100
        if base % 100 or any(
            location["bankId"] == bank_id
            and audio_id - suffix_by_index.get(location["streamIndex"], -1) != base
            for audio_id in audio_ids
            if (location := audio_lookup.get(str(audio_id)))
        ):
            continue
        for audio_id in sorted(audio_ids):
            if str(audio_id) in audio_lookup or audio_id // 100 != base // 100:
                continue
            suffix = audio_id - base
            if len(cues.get(suffix, [])) != 1:
                continue
            index = cues[suffix][0]
            # Do not override a surviving cfgSound row that points elsewhere.
            if sound_by_id.get(audio_id) and any(
                sheet != "picture/" + bank["sourceFile"].lower()
                or cue != next(s["name"] for s in bank["streams"] if s["index"] == index)
                for sheet, cue in sound_by_id[audio_id]
            ):
                continue
            audio_lookup[str(audio_id)] = {
                "bankId": bank_id, "streamIndex": index, "evidence": "archive-cue-suffix"
            }
            inferred_audio += 1

    group_ids_by_picture: dict[int, list[int]] = defaultdict(list)
    groups: list[dict[str, Any]] = []
    for group in illustration_rows:
        board_ids = [item["board_id"] for item in group.get("infos", [])]
        groups.append({
            "id": group["id"], "name": fold_label(group.get("name") or ""),
            "icon": group.get("small") or "", "boardIds": board_ids,
        })
        for board_id in board_ids:
            if board_id not in archive:
                raise ValueError(f"illustration group refers to unknown board {board_id}")
            group_ids_by_picture[board_id].append(group["id"])

    banks_by_picture: dict[int, list[str]] = defaultdict(list)
    for bank_id, link in picture_links.items():
        banks_by_picture[link["archiveId"]].append(bank_id)
    static_model_ids = {str(item["id"]) for item in static_rows}

    compact_archive = {
        str(row["id"]): {
            "id": row["id"], "img": row.get("img"), "icon": row.get("icon"),
            "title": fold_label(row.get("sName") or ""),
            "l2dName": row.get("l2dName"), "l2dPos": row.get("l2dPos"),
            "imgPos": row.get("imgPos"), "show": row.get("show"),
            "sort": row.get("sort"), "groupIds": group_ids_by_picture.get(row["id"], []),
            "entryMatches": matching_variant(gallery, row.get("l2dName")),
            "pictureBankIds": sorted(banks_by_picture.get(row["id"], [])),
            "hasDynamicTouch": str(row["id"]) in models,
            "hasStaticTouch": str(row["id"]) in static_model_ids,
        }
        for row in archive_rows
    }
    return {
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "luaSha256": hashlib.sha256(DEFAULT_LUA_BUNDLE.read_bytes()).hexdigest(),
        "sources": ["cfgCfgArchiveMultiPicture.lua", "cfgCfgSpineMultiImageAction.lua",
                    "cfgCfgArchiveIllustration.lua", "cfgCfgMultiImageAction.lua", "cfgSound.lua", "RoleSpineItem2.lua",
                    "RoleSpineItem1.lua"],
        "summary": {
            "archiveRows": len(archive_rows), "dynamicModels": len(dynamic_rows),
            "illustrationGroups": len(groups),
            "illustrationBoards": len(group_ids_by_picture),
            "staticModels": len(static_rows),
            "dynamicHotspots": sum(len(rows) for rows in models.values()),
            "mappedCgModels": sum(
                gallery_entry.startswith("cg:")
                for gallery_entry in entry_by_model.values()
            ),
            "mappedCharacterPictureModels": sum(
                gallery_entry.startswith("character:")
                for gallery_entry in entry_by_model.values()
            ),
            "pictureLinks": len(picture_links),
            "unresolvedPictures": len(unresolved_pictures),
            "audioCues": len(used_audio), "resolvedAudioCues": len(audio_lookup),
            "inferredAudioCues": inferred_audio,
        },
        "archive": compact_archive,
        "groups": groups,
        "entryByModel": entry_by_model,
        "variantByModel": variant_by_model,
        "unmappedModels": unmapped_models,
        "pictureLinks": picture_links,
        "unresolvedPictures": unresolved_pictures,
        "audioLookup": audio_lookup,
        "staticModels": {str(row["id"]): row.get("item", []) for row in static_rows},
        "interludeDefaults": interlude_defaults,
        "poses": poses,
        "models": models,
        "corrections": corrections,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Extract source-backed multi-picture interactions")
    parser.add_argument("--source", type=Path, default=DEFAULT_SOURCE)
    parser.add_argument("--gallery", type=Path, default=PATHS['cache'] / "assets.generated.json")
    parser.add_argument("--voices", type=Path, default=PATHS['cache'] / "voices.generated.json")
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    parser.add_argument("--corrected-models-only", action="store_true", help="update only reviewed corrected models/poses in an existing manifest")
    args = parser.parse_args()
    payload = build(
        json.loads(args.gallery.read_text(encoding="utf-8")),
        json.loads(args.voices.read_text(encoding="utf-8")), args.source,
    )
    if args.corrected_models_only:
        payload = merge_corrected_models(json.loads(args.out.read_text(encoding='utf-8')), payload)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    temporary = args.out.with_suffix(".tmp")
    temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(args.out)
    print(json.dumps(payload["summary"], ensure_ascii=False))


def merge_corrected_models(existing: dict, generated: dict) -> dict:
    """Keep unrelated runtime cache stable when applying reviewed source corrections."""
    import copy
    if existing['luaSha256'] != generated['luaSha256']:
        raise ValueError('Source version changed; a reviewed full rebuild is required')
    output = copy.deepcopy(existing)
    for correction in generated['corrections']:
        mid = str(correction['modelId'])
        if len(existing['models'][mid]) != len(generated['models'][mid]):
            raise ValueError(f'Correction changes row counts; review full manifest: {mid}')
        output['models'][mid] = copy.deepcopy(generated['models'][mid])
        output['poses'][mid] = copy.deepcopy(generated['poses'][mid])
    output['corrections'] = generated['corrections']
    output['correctionAppliedAt'] = generated['generatedAt']
    return output


if __name__ == "__main__":
    main()
