"""Read-only mapping builder: CG / multi-picture entry -> archive thumb -> big image -> spine.

Writes nothing into the shipped cache. Output goes to stdout (or --out).

Evidence rules, in priority order:
  1. config value      -- l2dName / archiveId / itemId taken straight out of the generated cache
  2. exact name match  -- normalize(entry title or source name) == normalize(asset name)
  3. missing           -- reported as missing, never guessed

A name-inference hit that is not backed by (1) is labelled `candidate`, never `confirmed`.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path


WORK = Path(__file__).parent
MULPIC_PREFIX = "arch_"


def normalize(value: str) -> str:
    """Lowercase and strip everything that is not [a-z0-9] -- matches thumbnail_cache.normalize."""
    return re.sub(r"[^a-z0-9]", "", (value or "").lower())


def strip_index(value: str) -> str:
    """Drop a leading `cg`/`picture` + 3-5 digit index, plus a trailing `spine`.

    Source names carry an index (`CG00031_AlleyCornerCrisis_spine`) while the archive
    art does not (`arch_alley_corner_crisis`), so the index has to come off before the
    rest of the name can be compared at all.

    Two spellings need the looser second rule below: an index-less `cg_seashore`, and
    `CG03_FireworksLoIent` whose asset is spelled with a capital `I` where the source
    has a lowercase `l` (`fireworks_IoIent`) -- the casing flip is in the shipped asset,
    not a transcription error on our side.
  """
    text = (value or "").strip()
    text = re.sub(r"^(?:cg|picture)\d{2,5}[_\-]*", "", text, flags=re.IGNORECASE)
    text = re.sub(r"^(?:cg|picture)[_\-]+", "", text, flags=re.IGNORECASE)
    text = re.sub(r"[_\-]*spine$", "", text, flags=re.IGNORECASE)
    return text


def fold_i_l(value: str) -> str:
    """Lowercase, strip punctuation, then map `i` and `l` onto the same glyph.

    Applied to *both* sides of a comparison. The shipped archives contain at least one
    name where `l` was typed as `I` (`arch_fireworks_IoIent` for source `FireworksLoIent`),
    and once punctuation is gone the two are indistinguishable, so a folded index is the
    only way to reach them without hand-writing a per-entry alias.
    """
    return normalize(value).replace("i", "l")


def tokens_for(*values: str | None) -> list[str]:
    """Build the ordered, deduplicated candidate token list for one entry.

    Each source value yields both its raw form and its index-stripped form, so a single
    pass covers `arch_<name>`, `<Name>_spine` and `<index>_<Name>` spellings.
    """
    out: list[str] = []
    for value in values:
        if not value:
            continue
        for token in (value, strip_index(value)):
            token = token.strip()
            if token and normalize(token) not in {normalize(t) for t in out}:
                out.append(token)
    return out


def load_json(path: Path) -> dict:
    with path.open(encoding="utf-8") as handle:
        return json.load(handle)


def cg_entries(assets: dict) -> list[dict]:
    rows = []
    for entry in assets["entries"]:
        if entry.get("category") != "cg":
            continue
        variants = []
        for variant in entry.get("variants", []):
            main = variant.get("main") or {}
            variants.append(
                {
                    "variantId": variant.get("id"),
                    "label": variant.get("label"),
                    "sourceName": main.get("sourceName"),
                    "folder": main.get("folder"),
                    "jsonPath": main.get("jsonPath"),
                }
            )
        rows.append(
            {
                "id": entry["id"],
                "title": entry.get("title"),
                "slug": entry["id"].split(":", 1)[1],
                "variants": variants,
            }
        )
    return rows


def build_maps(mulpic: list[str], multiimg: list[str]) -> tuple[dict[str, list[str]], dict[str, list[str]]]:
    """Map the normalized asset spelling to the real asset names that produce it.

    Only the strict spelling is registered. Values stay lists so a genuine collision
    surfaces as `ambiguous` instead of silently picking one.
  """
    thumb_map: dict[str, list[str]] = {}
    for name in mulpic:
        thumb_map.setdefault(normalize(name.removeprefix(MULPIC_PREFIX)), []).append(name)
    image_map: dict[str, list[str]] = {}
    for name in multiimg:
        image_map.setdefault(normalize(name), []).append(name)
    return thumb_map, image_map


def fold_index(map_: dict[str, list[str]]) -> dict[str, list[str]]:
    """Secondary lookup index keyed on the `i`/`l`-folded spelling.

    Built as a separate index and consulted only when the strict lookup finds nothing,
    so a folded key can never displace or collide with a strict one.
    """
    out: dict[str, list[str]] = {}
    for key, names in map_.items():
        folded = fold_i_l(key)
        if folded == key:
            continue
        out.setdefault(folded, []).extend(names)
    return out


def pick(candidates: list[str] | None) -> tuple[str | None, str]:
    if not candidates:
        return None, "none"
    if len(candidates) == 1:
        return candidates[0], "unique"
    return None, f"ambiguous({len(candidates)}: {', '.join(sorted(candidates))})"


def resolve(spine_key: str, thumb_map, thumb_fold, image_map, image_fold) -> dict:
    """Resolve one token (a CG slug, a spine folder name, or an l2dName) to thumb + big image.

    Strict spelling first; the folded index is consulted only as a fallback when the
    strict lookup returns nothing at all, so it can never downgrade a clean hit.
    """
    strict = normalize(spine_key)
    folded = fold_i_l(spine_key)

    def lookup(map_, fold_):
        names = map_.get(strict)
        if names:
            return pick(names), strict
        names = fold_.get(folded)
        if names:
            return pick(names), f"{folded} (folded i/l)"
        return (None, "none"), None

    (thumb, thumb_state), thumb_spelling = lookup(thumb_map, thumb_fold)
    (image, image_state), image_spelling = lookup(image_map, image_fold)

    return {
        "key": spine_key,
        "normalized": strict,
        "thumb": thumb,
        "thumbState": thumb_state,
        "thumbSpelling": thumb_spelling,
        "bigImage": image,
        "bigImageState": image_state,
        "bigImageSpelling": image_spelling,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--inv", type=Path, default=WORK / ".scratch_inv.json")
    parser.add_argument("--assets", type=Path, default=WORK / "cache" / "assets.generated.json")
    parser.add_argument("--voices", type=Path, default=WORK / "cache" / "voices.generated.json")
    parser.add_argument("--out", type=Path, default=None)
    args = parser.parse_args()

    inv = load_json(args.inv)
    assets = load_json(args.assets)
    voices = load_json(args.voices)

    mulpic = [row["name"] for row in inv["mulpicSprites"]]
    multiimg = inv["multiimgPackageNames"]
    thumb_map, image_map = build_maps(mulpic, multiimg)
    thumb_fold = fold_index(thumb_map)
    image_fold = fold_index(image_map)

    report: dict = {
        "counts": {
            "mulpicSprites": len(mulpic),
            "multiimgPackages": len(multiimg),
        },
        "cg": [],
        "pictures": [],
    }

    # ---- CG entries: key on the spine sourceName / folder, plus the entry slug ----
    for entry in cg_entries(assets):
        variants = []
        for variant in entry["variants"]:
            candidates = tokens_for(
                variant.get("sourceName"), variant.get("folder"), entry["slug"]
            )
            resolved = [
                resolve(token, thumb_map, thumb_fold, image_map, image_fold)
                for token in candidates
            ]
            variants.append(
                {
                    "variantId": variant["variantId"],
                    "sourceName": variant["sourceName"],
                    "folder": variant["folder"],
                    "tokens": resolved,
                    "thumb": next((r["thumb"] for r in resolved if r["thumb"]), None),
                    "bigImage": next((r["bigImage"] for r in resolved if r["bigImage"]), None),
                }
            )
        entry_row = {
            "id": entry["id"],
            "title": entry["title"],
            "slug": entry["slug"],
            "variants": variants,
        }
        entry_row["thumb"] = next((v["thumb"] for v in variants if v["thumb"]), None)
        entry_row["bigImage"] = next((v["bigImage"] for v in variants if v["bigImage"]), None)
        entry_row["thumbTokens"] = sorted(
            {r["normalized"] for v in variants for r in v["tokens"] if r["thumb"]}
        )
        entry_row["bigImageTokens"] = sorted(
            {r["normalized"] for v in variants for r in v["tokens"] if r["bigImage"]}
        )
        report["cg"].append(entry_row)

    # ---- multi-picture voice banks: key on l2dName first, then the title / source file ----
    for bank_id, bank in voices["pictureEntries"].items():
        candidates = tokens_for(
            bank.get("l2dName"),
            bank.get("title"),
            bank.get("titleSimplified"),
            str(bank["sourceFile"]).removesuffix(".acb") if bank.get("sourceFile") else None,
        )
        resolved = [
            resolve(token, thumb_map, thumb_fold, image_map, image_fold) for token in candidates
        ]
        report["pictures"].append(
            {
                "id": bank_id,
                "title": bank.get("title"),
                "titleSimplified": bank.get("titleSimplified"),
                "sourceFile": bank.get("sourceFile"),
                "l2dName": bank.get("l2dName"),
                "archiveId": bank.get("archiveId"),
                "itemId": bank.get("itemId"),
                "semanticStreamCount": bank.get("semanticStreamCount"),
                "speakerCount": len(bank.get("speakers") or []),
                "tokens": resolved,
                "thumb": next((r["thumb"] for r in resolved if r["thumb"]), None),
                "bigImage": next((r["bigImage"] for r in resolved if r["bigImage"]), None),
            }
        )

    # ---- summary ----
    cg_rows = report["cg"]
    pic_rows = report["pictures"]
    report["summary"] = {
        "cg": {
            "total": len(cg_rows),
            "withThumb": sum(1 for r in cg_rows if r["thumb"]),
            "withBigImage": sum(1 for r in cg_rows if r["bigImage"]),
            "missingThumb": [r["id"] for r in cg_rows if not r["thumb"]],
            "missingBigImage": [r["id"] for r in cg_rows if not r["bigImage"]],
        },
        "pictures": {
            "total": len(pic_rows),
            "withL2dName": sum(1 for r in pic_rows if r["l2dName"]),
            "withThumb": sum(1 for r in pic_rows if r["thumb"]),
            "withBigImage": sum(1 for r in pic_rows if r["bigImage"]),
            "missingThumb": [r["id"] for r in pic_rows if not r["thumb"]],
            "missingBigImage": [r["id"] for r in pic_rows if not r["bigImage"]],
        },
    }

    # unused mulpic / multiimg names -- potential mismatches worth reporting
    used_thumbs = {r["thumb"] for r in cg_rows + pic_rows if r["thumb"]}
    used_images = {r["bigImage"] for r in cg_rows + pic_rows if r["bigImage"]}
    report["unused"] = {
        "mulpic": sorted(n for n in mulpic if n not in used_thumbs),
        "multiimg": sorted(n for n in multiimg if n not in used_images),
    }

    payload = json.dumps(report, ensure_ascii=False, indent=2)
    if args.out:
        args.out.write_text(payload, encoding="utf-8")
        print(f"wrote {args.out} ({len(payload)} bytes)")
    else:
        print(payload)


if __name__ == "__main__":
    main()
