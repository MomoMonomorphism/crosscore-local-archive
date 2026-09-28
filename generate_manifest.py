from __future__ import annotations

import argparse
import gc
import hashlib
import json
import re
import time
from pathlib import Path, PurePosixPath
from typing import Any

import UnityPy

from asset_cache import (
    DEFAULT_CACHE,
    DEFAULT_CENSUS,
    DEFAULT_SOURCE,
    allocate_output_name,
    atlas_pages,
    folder_for_package,
    load_catalog,
    text_bytes,
    unwrap_bundle,
)


DEFAULT_OUTPUT = DEFAULT_CACHE / "assets.generated.json"
EFFECT_PATTERN = re.compile(r"(effect|efect|effec|effet|effcet)", re.I)
MANIFEST_SCHEMA_VERSION = "s16-source-character-identity-v1"


def stem(path: str) -> str:
    return PurePosixPath(path).name.rsplit(".", 1)[0]


def normalize(value: str) -> str:
    return re.sub(
        r"character|charact|chara|spine|skin|break|berak|synchro|[^a-z0-9]",
        "",
        value.lower(),
    )


def display_name(value: str) -> str:
    return re.sub(r"[_-]+", " ", value).strip().title()


def shared_prefix_score(left: str, right: str) -> int:
    a = normalize(stem(left))
    b = normalize(stem(right))
    score = 0
    while score < len(a) and score < len(b) and a[score] == b[score]:
        score += 1
    return score


def atlas_regions(content: bytes) -> set[str]:
    """Return attachment region names, excluding atlas page headers."""
    text = content.decode("utf-8", "surrogateescape")
    return {
        match.group(1).strip().lower()
        for match in re.finditer(
            r"(?m)^([^\s:][^\r\n:]*)\r?\n"
            r"(?:[ \t]*rotate:[^\r\n]*\r?\n)?[ \t]*(?:bounds|xy):",
            text,
        )
    }


def skeleton_regions(content: bytes) -> set[str]:
    """Collect the image region requested by every Spine skin attachment."""
    try:
        payload = json.loads(content)
    except (UnicodeDecodeError, json.JSONDecodeError):
        return set()

    found: set[str] = set()

    def collect_attachments(attachments: Any) -> None:
        if not isinstance(attachments, dict):
            return
        for slot in attachments.values():
            if not isinstance(slot, dict):
                continue
            for attachment_name, attachment in slot.items():
                if not isinstance(attachment, dict):
                    continue
                region = attachment.get("path") or attachment.get("name") or attachment_name
                if isinstance(region, str):
                    found.add(region.lower())

    skins = payload.get("skins", {}) if isinstance(payload, dict) else {}
    if isinstance(skins, list):
        for skin in skins:
            if isinstance(skin, dict):
                collect_attachments(skin.get("attachments"))
    elif isinstance(skins, dict):
        for skin in skins.values():
            collect_attachments(skin)
    return found


def skeleton_metrics(content: bytes) -> dict[str, int]:
    try:
        payload = json.loads(content)
    except (UnicodeDecodeError, json.JSONDecodeError):
        return {"boneCount": 0, "slotCount": 0, "animationCount": 0, "setupOpaqueSlotCount": 0}
    slots = payload.get("slots", []) if isinstance(payload, dict) else []
    animations = payload.get("animations", {}) if isinstance(payload, dict) else {}
    bones = payload.get("bones", []) if isinstance(payload, dict) else []
    opaque = sum(
        1
        for slot in slots
        if isinstance(slot, dict) and not str(slot.get("color", "ffffffff")).lower().endswith("00")
    )
    return {
        "boneCount": len(bones),
        "slotCount": len(slots),
        "animationCount": len(animations),
        "setupOpaqueSlotCount": opaque,
    }


def is_effect(path: str) -> bool:
    return bool(EFFECT_PATTERN.search(stem(path)))


def effect_layer(path: str) -> str:
    compact = re.sub(r"[^a-z0-9]", "", stem(path).lower())
    return "front" if re.search(r"f\d*$", compact) else "back"


def effect_base(path: str) -> str:
    return re.sub(
        r"[_\s-]*(?:effect|efect|effec|effet|effcet)[_\s-]*[bf]?\d*$",
        "",
        stem(path),
        flags=re.I,
    )


def parse_character_folder(folder_name: str) -> dict[str, str | None]:
    cleaned = re.sub(r"_spine$", "", folder_name, flags=re.I).strip()
    character_match = re.match(r"^\d+", cleaned)
    character_id = character_match.group(0) if character_match else None
    name = cleaned
    kind = "default"
    code = ""

    match = re.match(r"^\d+_(break|berak)_(.+)$", cleaned, re.I)
    if match:
        kind, name = "break", match.group(2)
    elif match := re.match(r"^\d+_synchro_(.+)$", cleaned, re.I):
        kind, name = "synchro", match.group(1)
    elif match := re.match(r"^\d+_skin(\d+[a-z]?)_(.+)$", cleaned, re.I):
        kind, code, name = "skin", match.group(1), match.group(2)
    elif match := re.match(r"^\d+_skin_(.+)$", cleaned, re.I):
        kind = "skin"
        detail = re.sub(r"_asmr$", "", match.group(1), flags=re.I)
        code_match = re.search(r"(sp)?(\d{2}[a-z]?)$", detail, re.I)
        if code_match:
            code = f"{code_match.group(1) or ''}{code_match.group(2)}"
            name = detail[: -len(code_match.group(0))]
        else:
            name = detail
        if re.search(r"_asmr$", match.group(1), re.I):
            code = f"{code or 'ASMR'} · ASMR"
    elif match := re.match(r"^half(\d+)_(.+)$", cleaned, re.I):
        kind, code, name = "variant", f"半身 {match.group(1)}", match.group(2)
    elif match := re.match(r"^\d+_(.+?)(\d{2}[a-z]?)$", cleaned, re.I):
        kind, name, code = "skin", match.group(1), match.group(2)
    else:
        name = re.sub(r"_[12]$", "", cleaned, flags=re.I)
        suffix = re.search(r"_([12])$", cleaned, re.I)
        if suffix:
            kind, code = "variant", f"形态 {suffix.group(1)}"

    name = re.sub(r"_spine$", "", name, flags=re.I)
    name = re.sub(r"^ijensp$", "ijen", name, flags=re.I)
    name = re.sub(r"^zues$", "zeus", name, flags=re.I)
    key = re.sub(r"[^a-z0-9]", "", name.lower()) or cleaned.lower()
    return {
        "key": key,
        "title": display_name(name),
        "characterId": character_id,
        "kind": kind,
        "code": code,
    }


def kind_from_main(identity: dict[str, Any], main: dict[str, Any]) -> str:
    main_stem = stem(main["jsonPath"])
    if re.search(r"(^|_)(break|berak)(_|$)", main_stem, re.I):
        return "break"
    if re.search(r"(^|_)synchro(_|$)", main_stem, re.I):
        return "synchro"
    if re.search(r"(^|_)skin(_|$)", main_stem, re.I):
        return "skin"
    return identity["kind"]


def variant_label(identity: dict[str, Any], main: dict[str, Any], main_count: int) -> str:
    if main_count > 1:
        main_stem = re.sub(r"^\d+[_-]?", "", stem(main["jsonPath"]))
        main_stem = re.sub(r"(?:character|charact|chara)$", "", main_stem, flags=re.I)
        main_stem = re.sub(r"^skin[_-]?", "", main_stem, flags=re.I)
        code_match = re.search(r"(?:sp)?\d{2}[a-z]?$", main_stem, re.I)
        if identity["kind"] == "skin" and code_match:
            return f"皮肤 {code_match.group(0).upper()}"
        return display_name(main_stem) or identity["code"] or "默认"
    if identity["kind"] == "break":
        return "突破"
    if identity["kind"] == "skin":
        return f"皮肤 {(identity['code'] or '特别版').upper()}"
    if identity["kind"] == "synchro":
        return "同步形态"
    if identity["kind"] == "variant":
        return identity["code"] or "特别形态"
    return "默认"


def variant_rank(variant: dict[str, Any]) -> int:
    return {"default": 0, "break": 1, "synchro": 2, "skin": 3, "variant": 4}.get(
        variant["kind"], 9
    )


def dedupe_variants(variants: list[dict[str, Any]]) -> list[dict[str, Any]]:
    unique: dict[str, dict[str, Any]] = {}
    for variant in variants:
        # Only collapse duplicate TextAsset objects inside the same Unity bundle.
        # Different folders may intentionally expose the same skeleton name (for
        # example an ASMR package) and must remain separate viewer variants.
        key = (
            f"{variant['kind']}:{variant['main']['folder'].lower()}:"
            f"{stem(variant['main']['jsonPath']).lower()}"
        )
        current = unique.get(key)
        if current is None or shared_prefix_score(
            variant["main"]["folder"], variant["main"]["jsonPath"]
        ) > shared_prefix_score(current["main"]["folder"], current["main"]["jsonPath"]):
            unique[key] = variant
    return list(unique.values())


def unique_variant_labels(variants: list[dict[str, Any]]) -> None:
    counts: dict[str, int] = {}
    for variant in variants:
        counts[variant["label"]] = counts.get(variant["label"], 0) + 1
    for variant in variants:
        if counts[variant["label"]] < 2:
            continue
        asset = variant["main"]
        suffix = asset["characterId"] if asset["characterId"] != "—" else asset["folder"]
        variant["label"] = f"{variant['label']} · {suffix}"


def scan_package(source: Path, folder: str) -> tuple[list[dict[str, Any]], list[dict[str, Any]], str]:
    raw, _, bundle = unwrap_bundle(source)
    environment = UnityPy.load(bundle)
    skeletons: list[dict[str, Any]] = []
    atlases: list[dict[str, Any]] = []
    text_names_seen: dict[str, int] = {}

    for obj in environment.objects:
        if obj.type.name != "TextAsset":
            continue
        asset = obj.read()
        name = (asset.m_Name or "").strip()
        content = text_bytes(asset)
        if name.lower().endswith(".atlas"):
            output_name = allocate_output_name(name, text_names_seen)
            atlases.append(
                {
                    "name": output_name,
                    "sourceName": name,
                    "path": f"spine/{folder}/{output_name}",
                    "bytes": len(content),
                    "pages": atlas_pages(content),
                    "regions": atlas_regions(content),
                }
            )
            continue
        head = content[:1600]
        if b'"skeleton"' not in head and b'"bones"' not in head:
            continue
        version_match = re.search(
            r'"spine"\s*:\s*"([^"]+)"', head.decode("utf-8", "surrogateescape")
        )
        filename = allocate_output_name(name, text_names_seen, ".json")
        skeletons.append(
            {
                "name": PurePosixPath(filename).stem,
                "sourceName": name.removesuffix(".json"),
                "path": f"spine/{folder}/{filename}",
                "bytes": len(content),
                "contentSha256": hashlib.sha256(content).hexdigest(),
                "spineVersion": version_match.group(1) if version_match else None,
                "regions": skeleton_regions(content),
                **skeleton_metrics(content),
            }
        )
    return skeletons, atlases, hashlib.sha256(raw).hexdigest()


def pick_atlas(skeleton: dict[str, Any], atlases: list[dict[str, Any]]) -> dict[str, Any]:
    if len(atlases) == 1:
        return atlases[0]
    requested = skeleton.get("regions", set())
    return max(
        atlases,
        key=lambda atlas: (
            len(requested & atlas.get("regions", set())),
            shared_prefix_score(skeleton["path"], atlas["path"]),
        ),
    )


def asset_for(
    skeleton: dict[str, Any],
    folder: str,
    atlases: list[dict[str, Any]],
    bundle_bytes: int,
) -> dict[str, Any]:
    atlas = pick_atlas(skeleton, atlases)
    return {
        "id": f"{folder}/{stem(skeleton['path'])}",
        "characterId": (re.match(r"^\d+", folder) or ["—"])[0],
        "title": display_name(re.sub(r"^\d+[_-]?", "", stem(skeleton["path"]))),
        "sourceName": skeleton["sourceName"],
        "folder": folder,
        "jsonPath": skeleton["path"],
        "atlasPath": atlas["path"],
        "texturePaths": [f"spine/{folder}/{page}" for page in atlas["pages"]],
        "bytes": skeleton["bytes"] + atlas["bytes"],
        "contentSha256": skeleton["contentSha256"],
        "sourceBundleBytes": bundle_bytes,
        "spineVersion": skeleton["spineVersion"],
        "boneCount": skeleton["boneCount"],
        "slotCount": skeleton["slotCount"],
        "animationCount": skeleton["animationCount"],
        "setupOpaqueSlotCount": skeleton["setupOpaqueSlotCount"],
    }


CHARACTER_PART_RE = re.compile(r"^(皮肤 (?:SP)?\d{2})([A-E])(?: ·.*)?$", re.I)


def character_part(label: str) -> tuple[str, int] | None:
    match = CHARACTER_PART_RE.match(label)
    if not match:
        return None
    return match.group(1), ord(match.group(2).upper()) - ord("A") + 1


def auxiliary_candidate(variant: dict[str, Any]) -> bool:
    asset = variant["main"]
    return asset["slotCount"] <= 100 and (
        asset["animationCount"] <= 2 or asset["setupOpaqueSlotCount"] == 0
    )


def attach_auxiliary(target: dict[str, Any], auxiliary: dict[str, Any], layer: str) -> None:
    asset = {**auxiliary["main"], "title": f"辅助层 · {auxiliary['main']['title']}"}
    target["effects"].append({"layer": layer, "asset": asset, "origin": "auxiliary"})
    target["bytes"] += auxiliary["main"]["sourceBundleBytes"]


def group_character_auxiliaries(
    entry: dict[str, Any], variant_aliases: dict[str, str] | None = None
) -> int:
    variants = entry["variants"]
    moved: set[str] = set()
    for auxiliary in variants:
        part = character_part(auxiliary["label"])
        if not part or not auxiliary_candidate(auxiliary):
            continue
        base, order = part
        candidates: list[tuple[int, int, dict[str, Any]]] = []
        for candidate in variants:
            if candidate is auxiliary or auxiliary_candidate(candidate):
                continue
            candidate_part = character_part(candidate["label"])
            if candidate["label"] == base:
                candidates.append((0, 0, candidate))
            elif candidate_part and candidate_part[0] == base:
                candidates.append((abs(candidate_part[1] - order), candidate_part[1], candidate))
        if not candidates:
            continue
        _, target_order, target = min(candidates, key=lambda item: (item[0], item[1]))
        attach_auxiliary(target, auxiliary, "back" if order < target_order else "front")
        if variant_aliases is not None:
            variant_aliases[auxiliary["id"]] = target["id"]
        moved.add(auxiliary["id"])
    entry["variants"] = [variant for variant in variants if variant["id"] not in moved]
    return len(moved)


def group_localized_character_entries(
    entries: list[dict[str, Any]], entry_aliases: dict[str, str],
    entry_default_variants: dict[str, str] | None = None,
) -> int:
    """Keep language-specific bundles under their original character entry.

    A suffix alone is insufficient evidence: only join a localized model when
    the unsuffixed folder contains the same named skeleton in exactly one other
    entry. Keep both model IDs so their textures and old variant URLs survive.
    """
    by_model: dict[tuple[str, str], list[tuple[dict[str, Any], dict[str, Any]]]] = {}
    for entry in entries:
        for variant in entry["variants"]:
            main = variant["main"]
            by_model.setdefault(
                (main["folder"].lower(), main["sourceName"].lower()), []
            ).append((entry, variant))

    removed: set[str] = set()
    moved = 0
    for entry in entries:
        matches: list[tuple[dict[str, Any], dict[str, Any], str, dict[str, Any]]] = []
        for variant in entry["variants"]:
            main = variant["main"]
            suffix = re.search(r"_(kr|jp)$", main["folder"], re.I)
            if not suffix:
                break
            base_folder = main["folder"][:suffix.start()].lower()
            candidates = [
                pair for pair in by_model.get((base_folder, main["sourceName"].lower()), [])
                if pair[0] is not entry
            ]
            if len(candidates) != 1:
                break
            target, base_variant = candidates[0]
            matches.append((target, base_variant, suffix.group(1).lower(), variant))
        else:
            targets = {target["id"] for target, _, _, _ in matches}
            if len(targets) != 1:
                continue
            target = matches[0][0]
            for _, base_variant, locale, variant in matches:
                variant["kind"] = base_variant["kind"]
                variant["label"] = f"{base_variant['label']} · {locale.upper()} 资源"
                target["variants"].append(variant)
                moved += 1
            for character_id in entry["characterIds"]:
                if character_id not in target["characterIds"]:
                    target["characterIds"].append(character_id)
            entry_aliases[entry["id"]] = target["id"]
            if entry_default_variants is not None:
                entry_default_variants[entry["id"]] = entry["variants"][0]["id"]
            removed.add(entry["id"])

    entries[:] = [entry for entry in entries if entry["id"] not in removed]
    return moved


def cg_part(folder: str) -> tuple[str, int] | None:
    value = re.sub(r"^cg\d+[_-]?", "", folder.lower())
    value = re.sub(r"_spine$", "", value)
    match = re.match(r"^(.*?)(?:[_-]?([abc])|(0[1-9]))$", value)
    if not match:
        return None
    suffix = match.group(2) or match.group(3)
    order = ord(suffix) - ord("a") + 1 if suffix.isalpha() else int(suffix)
    return re.sub(r"[^a-z0-9]", "", match.group(1)), order


def group_cg_auxiliaries(
    entries: list[dict[str, Any]],
    variant_aliases: dict[str, str] | None = None,
    entry_aliases: dict[str, str] | None = None,
) -> int:
    indexed: dict[str, list[tuple[int, dict[str, Any]]]] = {}
    for entry in entries:
        part = cg_part(entry["variants"][0]["main"]["folder"])
        if part:
            indexed.setdefault(part[0], []).append((part[1], entry))
    moved: set[str] = set()
    for family in indexed.values():
        for order, entry in family:
            auxiliary = entry["variants"][0]
            if not auxiliary_candidate(auxiliary):
                continue
            candidates = [
                (abs(candidate_order - order), candidate_order, candidate)
                for candidate_order, candidate in family
                if candidate is not entry and not auxiliary_candidate(candidate["variants"][0])
            ]
            if not candidates:
                continue
            _, target_order, target_entry = min(candidates, key=lambda item: (item[0], item[1]))
            attach_auxiliary(
                target_entry["variants"][0], auxiliary, "back" if order < target_order else "front"
            )
            if variant_aliases is not None:
                variant_aliases[auxiliary["id"]] = target_entry["variants"][0]["id"]
            if entry_aliases is not None:
                entry_aliases[entry["id"]] = target_entry["id"]
            moved.add(entry["id"])
    entries[:] = [entry for entry in entries if entry["id"] not in moved]
    return len(moved)


def build_manifest(source_root: Path, census_path: Path) -> dict[str, Any]:
    catalog = load_catalog(census_path)
    character_entries: dict[str, dict[str, Any]] = {}
    cg_entries: list[dict[str, Any]] = []
    skipped: list[dict[str, str]] = []
    revision = hashlib.sha256()
    revision.update(f"schema:{MANIFEST_SCHEMA_VERSION}\n".encode())
    model_count = 0
    main_model_count = 0
    effect_model_count = 0
    duplicate_source_models: list[dict[str, Any]] = []
    started = time.perf_counter()

    for index, item in enumerate(catalog, 1):
        package = item["package"]
        folder = folder_for_package(package)
        source = source_root / package
        skeletons, atlases, package_hash = scan_package(source, folder)
        revision.update(f"{package}:{package_hash}\n".encode())
        if not skeletons or not atlases:
            skipped.append({"package": package, "reason": "missing skeleton or atlas"})
            continue

        duplicate_groups: dict[str, list[dict[str, Any]]] = {}
        for skeleton in skeletons:
            duplicate_groups.setdefault(skeleton["sourceName"].lower(), []).append(skeleton)
        for duplicates in duplicate_groups.values():
            if len(duplicates) < 2:
                continue
            hashes = sorted({item["contentSha256"] for item in duplicates})
            duplicate_source_models.append(
                {
                    "package": package,
                    "name": duplicates[0]["sourceName"],
                    "objectCount": len(duplicates),
                    "uniqueContentCount": len(hashes),
                    "contentSha256": hashes,
                }
            )

        main_files = [asset for asset in skeletons if not is_effect(asset["sourceName"])]
        effect_files = [asset for asset in skeletons if is_effect(asset["sourceName"])]
        if not main_files:
            skipped.append({"package": package, "reason": "effect-only package"})
            continue
        model_count += len(skeletons)
        main_model_count += len(main_files)
        effect_model_count += len(effect_files)

        mains = [asset_for(asset, folder, atlases, item["bundleBytes"]) for asset in main_files]
        effects = [asset_for(asset, folder, atlases, item["bundleBytes"]) for asset in effect_files]
        effects_by_main: dict[str, list[dict[str, Any]]] = {main["id"]: [] for main in mains}
        for effect in effects:
            target = max(
                mains,
                key=lambda main: shared_prefix_score(
                    effect_base(effect["sourceName"]), main["sourceName"]
                ),
            )
            effects_by_main[target["id"]].append(
                {"layer": effect_layer(effect["sourceName"]), "asset": effect}
            )

        if re.match(r"^cg", folder, re.I):
            variants = []
            for main in mains:
                attached = effects_by_main[main["id"]]
                variants.append(
                    {
                        "id": main["id"],
                        "label": "CG 主画面" if len(mains) == 1 else main["title"],
                        "kind": "variant",
                        "main": main,
                        "effects": attached,
                        "bytes": item["bundleBytes"],
                    }
                )
            raw_title = re.sub(r"^cg\d*[_-]?", "", folder, flags=re.I)
            raw_title = re.sub(r"_spine$", "", raw_title, flags=re.I) or folder
            cg_entries.append(
                {
                    "id": f"cg:{folder.lower()}",
                    "title": display_name(raw_title),
                    "category": "cg",
                    "characterIds": [],
                    "variants": variants,
                }
            )
        else:
            identity = parse_character_folder(folder)
            entry = character_entries.setdefault(
                str(identity["key"]),
                {
                    "id": f"character:{identity['key']}",
                    "title": identity["title"],
                    "category": "character",
                    "characterIds": [],
                    "variants": [],
                },
            )
            character_id = identity["characterId"]
            if character_id and character_id not in entry["characterIds"]:
                entry["characterIds"].append(character_id)
            for main in mains:
                attached = effects_by_main[main["id"]]
                kind = kind_from_main(identity, main)
                variant_identity = {**identity, "kind": kind}
                entry["variants"].append(
                    {
                        "id": main["id"],
                        "label": variant_label(variant_identity, main, len(mains)),
                        "kind": kind,
                        "main": main,
                        "effects": attached,
                        "bytes": item["bundleBytes"],
                    }
                )

        if index % 50 == 0 or index == len(catalog):
            elapsed = time.perf_counter() - started
            print(f"  scanned {index}/{len(catalog)} packages in {elapsed:.1f}s", flush=True)
        del skeletons, atlases
        if index % 25 == 0:
            gc.collect()

    characters = list(character_entries.values())
    auxiliary_model_count = 0
    variant_aliases: dict[str, str] = {}
    entry_aliases: dict[str, str] = {}
    entry_default_variants: dict[str, str] = {}
    group_localized_character_entries(characters, entry_aliases, entry_default_variants)
    from character_identity import regroup_characters
    identity_report = regroup_characters(characters, entry_aliases, entry_default_variants)
    for entry in characters:
        entry["variants"] = dedupe_variants(entry["variants"])
        auxiliary_model_count += group_character_auxiliaries(entry, variant_aliases)
        unique_variant_labels(entry["variants"])
        entry["characterIds"].sort(key=lambda value: (int(value) if value.isdigit() else 10**12, value))
        entry["variants"].sort(key=lambda variant: (variant_rank(variant), variant["label"]))
    characters.sort(
        key=lambda entry: (
            int(entry["characterIds"][0]) if entry["characterIds"] else 10**12,
            entry["title"],
        )
    )
    auxiliary_model_count += group_cg_auxiliaries(cg_entries, variant_aliases, entry_aliases)
    cg_entries.sort(key=lambda entry: entry["id"])
    from character_catalog import enrich_characters
    enrich_characters(characters, entry_aliases, entry_default_variants)
    entries = [*characters, *cg_entries]
    variant_count = sum(len(entry["variants"]) for entry in entries)
    referenced_assets: dict[str, dict[str, Any]] = {}
    for entry in entries:
        for variant in entry["variants"]:
            referenced_assets[variant["main"]["id"]] = variant["main"]
            for effect in variant["effects"]:
                referenced_assets[effect["asset"]["id"]] = effect["asset"]
    unique_main_count = sum(
        1
        for entry in entries
        for variant in entry["variants"]
        if variant["main"]["id"] in referenced_assets
    )
    unique_effect_count = len(referenced_assets) - unique_main_count
    return {
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "source": str(source_root),
        "revision": f"local-sha256:{revision.hexdigest()}",
        "folderCount": len(catalog),
        "modelCount": len(referenced_assets),
        "mainModelCount": unique_main_count,
        "effectModelCount": unique_effect_count,
        "auxiliaryModelCount": auxiliary_model_count,
        "variantAliases": variant_aliases,
        "entryAliases": entry_aliases,
        "entryDefaultVariants": entry_default_variants,
        "identityReport": identity_report,
        "sourceModelObjectCount": model_count,
        "sourceMainModelObjectCount": main_model_count,
        "sourceEffectModelObjectCount": effect_model_count,
        "entryCount": len(entries),
        "characterCount": len(characters),
        "cgCount": len(cg_entries),
        "variantCount": variant_count,
        "skippedFolders": skipped,
        "duplicateSourceModels": duplicate_source_models,
        "entries": entries,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate the local CrossCore viewer manifest")
    parser.add_argument("--source", type=Path, default=DEFAULT_SOURCE)
    parser.add_argument("--census", type=Path, default=DEFAULT_CENSUS)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    args = parser.parse_args()

    args.output.parent.mkdir(parents=True, exist_ok=True)
    temporary = args.output.with_name("manifest-out.json")
    try:
        with temporary.open("w", encoding="utf-8") as handle:
            manifest = build_manifest(args.source, args.census)
            json.dump(manifest, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
        temporary.replace(args.output)
    except Exception:
        temporary.unlink(missing_ok=True)
        raise
    print(
        f"generated {manifest['characterCount']} characters, {manifest['cgCount']} CG, "
        f"{manifest['variantCount']} variants, {manifest['modelCount']} models -> {args.output}"
    )
    if manifest["skippedFolders"]:
        print(f"skipped folders: {len(manifest['skippedFolders'])}")


if __name__ == "__main__":
    main()
