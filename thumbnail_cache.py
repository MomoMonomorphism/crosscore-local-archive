from __future__ import annotations

import argparse
import json
import re
import time
from pathlib import Path
from typing import Any

import UnityPy
from PIL import Image

from asset_cache import extract_archive_image, unwrap_bundle
from lua_bundle import get_bundle
from voice_semantics import parse_characters, load_asmr_albums


ROOT = Path(__file__).resolve().parents[1]
from runtime_paths import PATHS
DEFAULT_SOURCE = PATHS['source']
DEFAULT_CACHE = PATHS['cache']
DEFAULT_SPINE_MANIFEST = DEFAULT_CACHE / "assets.generated.json"
DEFAULT_OUTPUT = DEFAULT_CACHE / "thumbnails.generated.json"
DEFAULT_MULTI_MANIFEST = DEFAULT_CACHE / "multi_picture_action.generated.json"
ICON_PACKAGES = (
    "textures_uis_icons_rolehead_normal_head_normal2",
    "textures_uis_icons_rolehead_normal_head_normal",
)
NAMED_ICON_PACKAGES = (
    "textures_uis_icons_rolehead_card_head",
    "textures_uis_icons_rolehead_list_head",
)
# The archive gallery (CG / multi-picture recollections) uses a separate icon sheet:
# 117 sprites, all 424x198, named `arch_<snake_case_title>`.
ARCHIVE_PACKAGE = "textures_uis_icons_archive_mulpic"
ARCHIVE_PREFIX = "arch_"
# CG0073 is absent from the archive identity table. Its extracted atlas and
# this static image depict the same check-up scene; this is a thumbnail-only
# visual fallback, not an archive-ID or interaction mapping.
CG_VISUAL_FALLBACKS = {
    "cg:cg0073_requiredcare_spine": "the_care_in_check-ups",
}


def normalize(value: str) -> str:
    return re.sub(r"[^a-z0-9]", "", value.lower())


def figure_key(value: str) -> str:
    return re.sub(r"spine$", "", normalize(value))


def configured_image(
    entry: dict, archive: dict[str, dict], poses: dict[str, dict] | None = None
) -> str | None:
    """Use the game's l2dName -> img join, including unrelated English art names."""
    figure_names = {
        figure_key(value)
        for variant in entry["variants"]
        for value in (variant["main"]["folder"], variant["main"]["sourceName"])
    }
    matches = [row.get("img") for row in archive.values()
               if figure_key(row.get("l2dName") or "") in figure_names and row.get("img")]
    if not matches:
        # A/B CG packs may be separate gallery entries while the game treats B
        # as a pose of the same archive row. Use that row's authored static art.
        for model_id, contract in (poses or {}).items():
            if any(figure_key(pose.get("l2dName") or "") in figure_names
                   for pose in contract.get("poses", {}).values()):
                img = archive.get(model_id, {}).get("img")
                if img:
                    matches.append(img)
    return matches[0] if len(matches) == 1 else None


def strip_index(value: str) -> str:
    """Drop a leading `cg`/`picture` index and a trailing `spine`.

    Source names carry an index (`CG00031_AlleyCornerCrisis_spine`) while the archive art
    does not (`arch_alley_corner_crisis`), so the index must come off before the two can
    be compared at all.
    """
    text = (value or "").strip()
    text = re.sub(r"^(?:cg|picture)\d{2,5}[_\-]*", "", text, flags=re.IGNORECASE)
    text = re.sub(r"^(?:cg|picture)[_\-]+", "", text, flags=re.IGNORECASE)
    text = re.sub(r"[_\-]*spine$", "", text, flags=re.IGNORECASE)
    return text


def fold_i_l(value: str) -> str:
    """Fold `i`/`l` onto one glyph after normalizing.

    The shipped archive sheet spells `arch_fireworks_IoIent` where the source says
    `CG03_FireworksLoIent`; punctuation-free, the two only line up under this fold.
    Applied to both sides and used strictly as a fallback, never to overwrite a strict hit.
    """
    return normalize(value).replace("i", "l")


def icon_rank(name: str, title: str) -> tuple[int, int, str]:
    kind = re.search(r"_(Common|Break|Synchro|Skin\d+)_", name, re.I)
    rank = {"common": 0, "break": 1, "synchro": 2}.get(kind.group(1).lower() if kind else "", 3)
    title_match = 0 if normalize(title) in normalize(name) else 1
    return rank, title_match, name.lower()


def collect_sprites(source_root: Path) -> tuple[dict[str, list[tuple[str, Any]]], list[tuple[str, Any]]]:
    sprites: dict[str, list[tuple[str, Any]]] = {}
    all_sprites: list[tuple[str, Any]] = []
    for package in ICON_PACKAGES:
        _, _, bundle = unwrap_bundle(source_root / package)
        environment = UnityPy.load(bundle)
        for obj in environment.objects:
            if obj.type.name != "Sprite":
                continue
            data = obj.read()
            name = (data.m_Name or "").strip()
            match = re.match(r"^(\d+)_", name)
            if match and name.lower().endswith("_n"):
                sprites.setdefault(match.group(1), []).append((name, data))
                all_sprites.append((name, data))
    return sprites, all_sprites


def collect_named_portraits(source_root: Path) -> tuple[
    dict[str, list[tuple[str, Any]]], dict[str, list[tuple[str, Any]]]
]:
    """Find official card/list portraits for Spine folders without a numeric role ID.

    The two sheets name sprites `<role ID>_<variant>_<English name>_C/L`.
    Match the complete English name, never a substring (`Echo` must not select
    `RationalEcho`). The role ID cannot be inferred safely from a bare folder.
    """
    portraits: dict[str, list[tuple[str, Any]]] = {}
    by_role: dict[str, list[tuple[str, Any]]] = {}
    for package in NAMED_ICON_PACKAGES:
        _, _, bundle = unwrap_bundle(source_root / package)
        environment = UnityPy.load(bundle)
        for obj in environment.objects:
            if obj.type.name != "Sprite":
                continue
            sprite = obj.read()
            name = (sprite.m_Name or "").strip()
            parts = name.split("_", 2)
            if len(parts) != 3 or not parts[0].isdigit() or not name.endswith(("_C", "_L")):
                continue
            label = parts[2].rsplit("_", 1)[0]
            portraits.setdefault(normalize(label), []).append((name, sprite))
            by_role.setdefault(parts[0], []).append((name, sprite))
    return portraits, by_role


def configured_role_ids_by_spine() -> dict[str, set[str]]:
    """Join standalone Spine names to role icons through cfgcharacter.l2dName."""
    rows = parse_characters(get_bundle().read("cfgcharacter.lua"))
    result: dict[str, set[str]] = {}
    for model_id, row in rows.items():
        if not model_id.isdigit() or len(model_id) < 6:
            continue
        spine = row.get("l2dName") or ""
        if spine:
            result.setdefault(figure_key(spine), set()).add(model_id[:-2])
    return result


def portrait_spine_key(value: str) -> str:
    return re.sub(r"(?:character|charact|chara|spine)$", "", normalize(value))


def named_portrait_rank(item: tuple[str, Any]) -> tuple[int, int, str]:
    name = item[0]
    variant = name.split("_", 2)[1].lower()
    return (
        0 if variant in ("common", "comon") else 1 if variant == "break" else 2,
        # The list portrait is an authored face close-up; the card portrait is
        # full-height art and loses the face when shown in the compact list.
        0 if name.endswith("_L") else 1,
        name.lower(),
    )


def collect_archive_sprites(source_root: Path) -> dict[str, list[tuple[str, Any]]]:
    """Collect the archive icon sheet, keyed on the normalized name without `arch_`.

    A key can map to several names, and a genuine collision must stay visible rather than
    being silently reduced to one -- see `resolve_archive_sprite`.
    """
    sprites: dict[str, list[tuple[str, Any]]] = {}
    _, _, bundle = unwrap_bundle(source_root / ARCHIVE_PACKAGE)
    environment = UnityPy.load(bundle)
    for obj in environment.objects:
        if obj.type.name != "Sprite":
            continue
        data = obj.read()
        name = (data.m_Name or "").strip()
        if not name.startswith(ARCHIVE_PREFIX):
            continue
        sprites.setdefault(normalize(name.removeprefix(ARCHIVE_PREFIX)), []).append((name, data))
    return sprites


def fold_archive_index(
    sprites: dict[str, list[tuple[str, Any]]]
) -> dict[str, list[tuple[str, Any]]]:
    """Secondary index keyed on the `i`/`l`-folded spelling, used only as a fallback."""
    out: dict[str, list[tuple[str, Any]]] = {}
    for key, items in sprites.items():
        folded = fold_i_l(key)
        if folded == key:
            continue
        out.setdefault(folded, []).extend(items)
    return out


def archive_tokens(*values: str | None) -> list[str]:
    """Ordered candidate tokens for one gallery entry: raw form then index-stripped form."""
    out: list[str] = []
    seen: set[str] = set()
    for value in values:
        if not value:
            continue
        for token in (value, strip_index(value)):
            token = token.strip()
            key = normalize(token)
            if token and key not in seen:
                seen.add(key)
                out.append(token)
    return out


def resolve_archive_sprite(
    tokens: list[str],
    sprites: dict[str, list[tuple[str, Any]]],
    folded: dict[str, list[tuple[str, Any]]],
) -> tuple[str, Any] | None:
    """Return the single matching sprite, or None when missing or ambiguous.

    Ambiguity returns None on purpose: showing one of several equally plausible images is
    exactly the "wrong picture" failure this must avoid, so the entry is left to the
    caller's fallback instead.
    """
    for token in tokens:
        key = normalize(token)
        items = sprites.get(key)
        if not items:
            items = folded.get(fold_i_l(token))
        if not items:
            continue
        return items[0] if len(items) == 1 else None
    return None


def archive_tokens_for(entry: dict, claimed: dict[str, str] | None = None) -> list[str]:
    """Candidate tokens for one gallery entry, from the first variant that has a main asset.

    When `claimed` is given, variants whose `sourceName` is already taken by another entry
    are skipped before the *whole variant* is taken. This matters because the archive sheet
    can spell one skeleton two ways: `cg00011_starrynight_spine` and `cg0067_starrynight_spine`
    both reduce to `arch_starry_night` on the normalized key, so if the index-stripped form
    is exhausted on the first variant the second one is left with no token and reported
    missing -- the right outcome, but for the wrong reason. Preferring an unclaimed variant
    keeps the bookkeeping honest: the entry is only allowed to fall back to the shared token
    when no unclaimed variant exists at all.
    """
    claimed = claimed or {}
    fallback: list[str] = []
    for index, variant in enumerate(entry.get("variants", [])):
        main = variant.get("main") or {}
        if not main:
            continue
        tokens = archive_tokens(
            main.get("sourceName"),
            main.get("folder"),
            entry["id"].split(":", 1)[-1],
        )
        if not tokens:
            continue
        if not fallback:
            fallback = tokens
        taken = main.get("sourceName") in claimed and claimed[main["sourceName"]] != entry["id"]
        if not taken:
            return tokens
    return fallback


def build_thumbnails(
    source_root: Path, spine_manifest: Path, cache_root: Path,
    multi_manifest: Path = DEFAULT_MULTI_MANIFEST,
) -> dict[str, Any]:
    gallery = json.loads(spine_manifest.read_text(encoding="utf-8"))
    multi = json.loads(multi_manifest.read_text(encoding="utf-8")) if multi_manifest.is_file() else {}
    archive = multi.get("archive", {})
    sprites, all_sprites = collect_sprites(source_root)
    named_portraits, portraits_by_role = collect_named_portraits(source_root)
    configured_roles = configured_role_ids_by_spine()
    archive_sprites = collect_archive_sprites(source_root)
    archive_folded = fold_archive_index(archive_sprites)
    big_images: dict[str, list[str]] = {}
    prefix = "textures_bigs_uis_multiimg_"
    for package in source_root.glob(f"{prefix}*"):
        if package.is_file():
            name = package.name[len(prefix):]
            big_images.setdefault(normalize(name), []).append(name)
    output_dir = cache_root / "thumbnails"
    output_dir.mkdir(parents=True, exist_ok=True)
    entries: dict[str, dict[str, Any]] = {}
    missing: list[str] = []

    # Two distinct gallery entries can collapse onto one archive sprite once the index is
    # stripped (`cg00011_starrynight_spine` and `cg0067_starrynight_spine` both reduce to
    # `arch_starry_night`) while being different assets on disk. The sprite may only be
    # given to the first claimant; the rest fall through to `missing` rather than being
    # shown someone else's picture.
    claimed: dict[str, str] = {}
    conflicts: dict[str, list[str]] = {}

    for entry in gallery["entries"]:
        candidates: list[tuple[str, Any]] = []
        fallback_image: Image.Image | None = None
        fallback_name = ""
        if entry["category"] == "character" and entry["characterIds"]:
            for character_id in entry["characterIds"]:
                candidates.extend(sprites.get(character_id, []))
            if not candidates:
                title_key = normalize(entry["title"])
                candidates = [
                    item for item in all_sprites if title_key and title_key in normalize(item[0])
                ]
        elif entry["category"] == "character":
            # Standalone story/legacy Spine packs lack a numeric folder ID even
            # when the shipped game has an official card portrait for the name.
            candidates = named_portraits.get(normalize(entry["title"]), [])
            if candidates:
                candidates = [min(candidates, key=named_portrait_rank)]
            else:
                role_ids = set().union(*(
                    configured_roles.get(portrait_spine_key(value), set())
                    for variant in entry["variants"]
                    for value in (variant["main"]["folder"], variant["main"]["sourceName"])
                ))
                if len(role_ids) == 1:
                    role_id = next(iter(role_ids))
                    candidates = sprites.get(role_id, []) or portraits_by_role.get(role_id, [])
                    if candidates:
                        candidates = [min(candidates, key=named_portrait_rank)]
            if not candidates:
                configured = configured_image(entry, archive, multi.get("poses"))
                match = resolve_archive_sprite([configured], archive_sprites, archive_folded) if configured else None
                if match:
                    candidates = [match]
                elif configured:
                    big_matches = big_images.get(normalize(configured), [])
                    if len(big_matches) == 1:
                        image_path, _ = extract_archive_image(big_matches[0], source_root, cache_root)
                        with Image.open(image_path) as original:
                            scaled = original.convert("RGBA")
                            scaled.thumbnail((100, 100), Image.Resampling.LANCZOS)
                            fallback_image = Image.new("RGBA", (100, 100), (20, 20, 22, 255))
                            fallback_image.alpha_composite(scaled, ((100 - scaled.width) // 2, (100 - scaled.height) // 2))
                        fallback_name = f"archive:{big_matches[0]}"
        elif entry["category"] == "cg":
            configured = configured_image(entry, archive, multi.get("poses"))
            if not configured:
                configured = CG_VISUAL_FALLBACKS.get(entry["id"])
            match = resolve_archive_sprite([configured], archive_sprites, archive_folded) if configured else None
            if not match:
                match = resolve_archive_sprite(
                    archive_tokens_for(entry, claimed), archive_sprites, archive_folded
                )
            if match and match[0] not in claimed:
                claimed[match[0]] = entry["id"]
                candidates = [match]
            elif match:
                conflicts.setdefault(match[0], [claimed[match[0]]]).append(entry["id"])
            big_matches = big_images.get(normalize(configured), []) if configured else []
            if not candidates and len(big_matches) == 1:
                image_path, _ = extract_archive_image(big_matches[0], source_root, cache_root)
                with Image.open(image_path) as original:
                    scaled = original.convert("RGBA")
                    scaled.thumbnail((424, 198), Image.Resampling.LANCZOS)
                    fallback_image = Image.new("RGBA", (424, 198), (20, 20, 22, 255))
                    fallback_image.alpha_composite(scaled, ((424 - scaled.width) // 2, (198 - scaled.height) // 2))
                fallback_name = f"archive:{big_matches[0]}"
        else:
            continue

        if not candidates and fallback_image is None:
            missing.append(entry["id"])
            continue
        name, sprite = min(candidates, key=lambda item: icon_rank(item[0], entry["title"])) if candidates else (fallback_name, None)
        filename = re.sub(r"[^a-z0-9_-]", "_", entry["id"].lower()) + ".png"
        destination = output_dir / filename
        image = sprite.image if sprite is not None else fallback_image
        assert image is not None
        image.save(destination, format="PNG", optimize=True)
        entries[entry["id"]] = {
            "path": f"thumbnails/{filename}",
            "sourceName": name,
            "width": image.width,
            "height": image.height,
            "bytes": destination.stat().st_size,
        }

    # The archive's own ID is the stable illustration identity. Generate a thumbnail
    # for every configured picture, including static pictures and CGs without a
    # loadable skeleton. These are separate from the raw skeleton gallery entries.
    archive_entries: dict[str, dict[str, Any]] = {}
    for archive_id, row in archive.items():
        image_name = row.get("img") or ""
        match = resolve_archive_sprite([image_name], archive_sprites, archive_folded)
        source_name = ""
        if match:
            source_name, sprite = match
            image = sprite.image
        else:
            big_matches = big_images.get(normalize(image_name), [])
            if len(big_matches) != 1:
                continue
            image_path, _ = extract_archive_image(big_matches[0], source_root, cache_root)
            with Image.open(image_path) as original:
                scaled = original.convert("RGBA")
                scaled.thumbnail((424, 198), Image.Resampling.LANCZOS)
                image = Image.new("RGBA", (424, 198), (20, 20, 22, 255))
                image.alpha_composite(scaled, ((424 - scaled.width) // 2, (198 - scaled.height) // 2))
            source_name = f"archive:{big_matches[0]}"
        filename = f"archive-{archive_id}.png"
        destination = output_dir / filename
        image.save(destination, format="PNG", optimize=True)
        archive_entries[archive_id] = {
            "path": f"thumbnails/{filename}",
            "sourceName": source_name,
            "width": image.width,
            "height": image.height,
            "bytes": destination.stat().st_size,
        }

    # Alternate-language packs can contain the exact same named skeleton as a
    # catalogued character. Reuse a portrait only for a unique exact sourceName.
    by_source: dict[str, list[dict[str, Any]]] = {}
    for entry in gallery["entries"]:
        if entry["category"] == "character" and entry["id"] in entries:
            source_name = entry["variants"][0]["main"]["sourceName"]
            by_source.setdefault(source_name, []).append(entries[entry["id"]])
    remaining: list[str] = []
    for entry_id in missing:
        entry = next(item for item in gallery["entries"] if item["id"] == entry_id)
        if entry["category"] != "character":
            remaining.append(entry_id)
            continue
        source_name = entry["variants"][0]["main"]["sourceName"]
        matches = by_source.get(source_name, [])
        if len(matches) != 1:
            remaining.append(entry_id)
            continue
        entries[entry_id] = dict(matches[0])
    missing = remaining

    return {
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "entryCount": len(entries),
        "bytes": sum(item["bytes"] for item in entries.values()),
        "missingEntryIds": missing,
        "archiveConflicts": conflicts,
        "entries": entries,
        "archiveEntryCount": len(archive_entries),
        "archiveEntries": archive_entries,
    }


def build_asmr_thumbnails(source_root: Path, cache_root: Path) -> dict[str, Any]:
    """Resolve CfgASMR.voice -> icon in the game's ASMR sprite package.

    Stable voice-keyed URLs are independent of character ownership and skin names.
    This is also callable separately to avoid regenerating the full gallery.
    """
    package = "textures_uis_icons_asmr"
    environment = UnityPy.load(unwrap_bundle(source_root / package)[2])
    sprites = {}
    for obj in environment.objects:
        if obj.type.name == "Sprite":
            sprite = obj.read()
            sprites[sprite.m_Name] = sprite
    output_dir = cache_root / "thumbnails"
    output_dir.mkdir(parents=True, exist_ok=True)
    entries, missing = {}, []
    for album in load_asmr_albums():
        icon, voice = album["icon"], album["voice"]
        if icon not in sprites:
            missing.append({"voice": voice, "icon": icon})
            continue
        image = sprites[icon].image.convert("RGBA")
        original_size = image.size
        image.thumbnail((640, 360), Image.Resampling.LANCZOS)
        filename = f"asmr-{voice}.png"
        image.save(output_dir / filename, optimize=True)
        entries[str(voice)] = {"icon": icon, "package": package,
                               "path": f"thumbnails/{filename}",
                               "sourceSize": original_size, "size": image.size}
    manifest = {"entries": entries, "missing": missing}
    (cache_root / "asmr-thumbnails.generated.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return manifest


def main() -> None:
    parser = argparse.ArgumentParser(description="Extract local character portrait thumbnails")
    parser.add_argument("--source", type=Path, default=DEFAULT_SOURCE)
    parser.add_argument("--spine-manifest", type=Path, default=DEFAULT_SPINE_MANIFEST)
    parser.add_argument("--cache", type=Path, default=DEFAULT_CACHE)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--multi-manifest", type=Path, default=DEFAULT_MULTI_MANIFEST)
    parser.add_argument("--asmr-only", action="store_true", help="Only extract configured ASMR album covers")
    args = parser.parse_args()
    asmr = build_asmr_thumbnails(args.source, args.cache)
    print(f"ASMR covers: {len(asmr['entries'])}, missing: {len(asmr['missing'])}")
    if args.asmr_only:
        return
    manifest = build_thumbnails(args.source, args.spine_manifest, args.cache, args.multi_manifest)
    temporary = args.output.with_suffix(".tmp")
    temporary.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(args.output)
    print(
        f"generated {manifest['entryCount']} thumbnails ({manifest['bytes'] / 1024 / 1024:.1f} MB), "
        f"missing {len(manifest['missingEntryIds'])} -> {args.output}"
    )


if __name__ == "__main__":
    main()
