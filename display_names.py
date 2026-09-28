"""Source-backed simplified Chinese names for the viewer's gallery entries.

`cfgcharacter.key` is the game's short display name. The asset catalog is
grouped by Spine folder, so some entries contain several model IDs; only use
a name when the role ID or an exact English-name join identifies it.
"""

from __future__ import annotations

import re
import json
from collections import defaultdict
from pathlib import Path
from typing import Any

from lua_bundle import DEFAULT_LUA_BUNDLE, get_bundle
from voice_semantics import fold_label, parse_characters


_SUPPLEMENTAL_SIMPLIFIED: dict[str, str] = json.loads(
    Path(__file__).with_name("display_simplified_map.json").read_text(encoding="utf-8")
)


def simplify_display(value: str) -> str:
    return "".join(_SUPPLEMENTAL_SIMPLIFIED.get(char, char) for char in fold_label(value))


def _english_key(value: str) -> str:
    return re.sub(r"[^a-z0-9]", "", value.lower())


def _spine_key(value: str) -> str:
    return re.sub(r"spine$", "", _english_key(value))


def build_display_names(
    gallery: dict[str, Any], lua_bundle_path: Path = DEFAULT_LUA_BUNDLE
) -> dict[str, Any]:
    characters = parse_characters(get_bundle(lua_bundle_path).read("cfgcharacter.lua"))
    names_by_role: dict[str, set[str]] = defaultdict(set)
    names_by_english: dict[str, set[str]] = defaultdict(set)
    names_by_spine: dict[str, set[str]] = defaultdict(set)
    for model_id, row in characters.items():
        name = simplify_display(str(row.get("key") or "")).strip()
        if not name or "\ufffd" in name:
            continue
        if model_id.isdigit() and len(model_id) >= 6:
            names_by_role[model_id[:-2]].add(name)
        english = _english_key(str(row.get("englishName") or ""))
        if english:
            names_by_english[english].add(name)
        spine = _spine_key(str(row.get("l2dName") or ""))
        if spine:
            names_by_spine[spine].add(name)

    role_names: dict[str, str] = {}
    for role_id, candidates in names_by_role.items():
        base = characters.get(f"{role_id}01")
        base_name = simplify_display(str(base.get("key") or "")).strip() if base else ""
        if base_name in candidates:
            role_names[role_id] = base_name
        elif len(candidates) == 1:
            role_names[role_id] = next(iter(candidates))

    entry_names: dict[str, str] = {}
    for entry in gallery.get("entries", []):
        if entry.get("category") != "character":
            continue
        ids = entry.get("characterIds") or []
        role_candidates = set().union(*(names_by_role.get(str(role_id), set()) for role_id in ids))
        english_candidates = names_by_english.get(_english_key(str(entry.get("title") or "")), set())
        if len(role_candidates) == 1:
            name = next(iter(role_candidates))
        elif len(english_candidates) == 1 and (not role_candidates or english_candidates <= role_candidates):
            name = next(iter(english_candidates))
        else:
            spine_candidates: set[str] = set()
            for variant in entry.get("variants", []):
                main = variant["main"]
                spine_candidates.update(names_by_spine.get(_spine_key(main["folder"]), set()))
                spine_candidates.update(names_by_spine.get(_spine_key(main["sourceName"]), set()))
            if len(spine_candidates) != 1:
                continue
            name = next(iter(spine_candidates))
        entry_names[entry["id"]] = name

    return {
        "source": "cfgcharacter.lua:key",
        "entryNames": entry_names,
        "roleNames": role_names,
        "characterEntryCount": sum(e.get("category") == "character" for e in gallery.get("entries", [])),
        "namedEntryCount": len(entry_names),
    }
