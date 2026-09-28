"""Build `cache/voices.generated.json`: which voice bank belongs to whom, and what
each of its streams actually is.

Two label sources feed the manifest and every stream records which one it used
(`semantic.source`), because they are not equally trustworthy for every role:

* `roleVoice` — `CfgCardRoleVoice`, the curated per-card table (53 roles,
  simplified Chinese).  Used only while it still lines up with the shipped ACB.
* `soundBook` — `cfgSound.lua`, keyed by ACB path plus stream name (traditionally
  Chinese).  Covers 135/137 character banks and 181/187 skin banks.

`labelSource` on a bank says which source ended up labelling it, and
`labelConflictCount` records how many of its streams the two tables describe
differently — that count is what flags a drifted curated table instead of hiding it.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import subprocess
import time
from pathlib import Path
from typing import Any

from lua_bundle import get_bundle
from runtime_paths import PATHS
from voice_semantics import (
    NAME_ALIASES,
    cue_of,
    fold_label,
    load_asmr_albums,
    load_asmr_voice,
    load_card_roles,
    load_multi_picture,
    load_role_voices,
    load_short_name_index,
    load_sound_book,
    resolve_role_id,
    role_label_alignment,
    sound_book_status,
)


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_SOURCE = PATHS['voice_source']
DEFAULT_CHINESE_SOURCE = PATHS['chinese_source']
DEFAULT_CACHE = PATHS['cache']
DEFAULT_SPINE_MANIFEST = DEFAULT_CACHE / "assets.generated.json"
DEFAULT_OUTPUT = DEFAULT_CACHE / "voices.generated.json"
DEFAULT_ASMR_OUTPUT = DEFAULT_CACHE / "asmr.generated.json"

#: Protagonist voice banks, keyed by the gallery's own character id and variant kind.
#: `syujinko_*` never resolves through `CfgCardRole` — there is no row for them — so
#: the gallery id is the only handle, and `cfgcharacter.lua` says it is authoritative:
#:
#:   7101202  總隊長        71011_break_Leader_spine            (male, base)
#:   7102202  總隊長        71021_break_Leader_spine            (female, base)
#:   7101302  總隊長·純白    71013_break_Leader_spine            (male, `purewhite`)
#:   7102302  總隊長·純白    71023_break_Leader_spine            (female, `purewhite`)
#:   7101303  總隊長·純白    71013_Skin139_Leader_draw  → skin 139
#:   7102303  總隊長·純白    71023_Skin139_Leader_draw  → skin 139
#:
#: The previous version hard-coded just the two base banks, so every later protagonist
#: bank (the `purewhite` pair and the two `skin139` banks, all four shipped with real
#: sound-book labels) was dropped without a word.  `unmappedLeaderVariants` in the
#: manifest now reports anything this table does not cover.
LEADER_BANKS: dict[str, dict[str, str]] = {
    "71011": {"break": "syujinko_m.acb"},
    "71021": {"break": "syujinko_f.acb"},
    "71013": {"break": "syujinko_purewhite_m.acb", "skin": "syujinko_m_skin139.acb"},
    "71023": {"break": "syujinko_purewhite_f.acb", "skin": "syujinko_f_skin139.acb"},
}
DEFAULT_DECODER = PATHS['decoder']

# Bank `sourceGroup` -> subdirectory of the voice source root (which is `sounds/cv`).
VOICE_SOURCE_SUBDIRS: dict[str, tuple[str, ...]] = {
    "cv": (),
    "cv_skin": ("cv_skin",),
    "cv_cn": ("..", "..", "sounds_cn", "cv"),
    "picture": ("..", "picture"),
    "asmr": ("..", "asmr"),
}


def config_for_role(role_id: str) -> dict[int, dict[str, Any]] | None:
    """Merge every `CfgCardRoleVoice` entry belonging to a 5-digit role id.

    A role can own several config keys.  Fragarach, for instance, has `601901`
    covering cues 1-39 and `601903` covering cues 40-54: two non-overlapping
    ranges of one voice set, so the union is safe.  Verified: it is the only role
    with more than one key, and its two cue sets do not intersect.
    """
    voices = load_role_voices()
    merged: dict[int, dict[str, Any]] = {}
    for key in sorted(voices):
        if key[:5] == role_id:
            merged.update(voices[key])
    return merged or None


def sound_sheet(bank: dict[str, Any]) -> str:
    """The `cue_sheet` path `cfgSound` uses for this bank.

    Skin banks live in `sounds/cv/cv_skin/` and `cfgSound` spells that out in full,
    so the prefix is part of the key rather than an assumption.
    """
    prefix = "cv/cv_skin/" if bank.get("sourceGroup") == "cv_skin" else "cv/"
    return prefix + str(bank["sourceFile"]).lower()


def enrich_sound_aliases(manifest: dict[str, Any], sound: dict | None = None) -> dict[str, Any]:
    """Preserve exact cfgSound runtime aliases without relabelling audio streams.

    Safe for an existing manifest: no audio probing, offset inference or
    replacement of retained semantics. CN uses the same cue names as its JP
    source; its already-established stream identity remains unchanged.
    """
    sound = load_sound_book() if sound is None else sound
    owners: dict[int, set[tuple[str, str]]] = {}
    for key, row in sound.items():
        for audio_id in row.get("audioIds", [row.get("audioId")]):
            if isinstance(audio_id, int):
                owners.setdefault(audio_id, set()).add(key)
    ambiguous = {audio_id for audio_id, keys in owners.items() if len(keys) > 1}
    added: set[tuple[str, int, int]] = set()
    for group in ("entries", "variantEntries", "auxiliaryEntries", "chineseEntries", "chineseVariantEntries"):
        for bank in manifest.get(group, {}).values():
            sheet = sound_sheet(bank)
            for stream in bank["streams"]:
                row = sound.get((sheet, stream["name"]))
                if not row or not row.get("audioIds"):
                    continue
                aliases = set(stream.get("interactionAudioIds", []))
                existing = aliases | {stream.get("semantic", {}).get("audioId"), stream.get("interactionAudioId")}
                for audio_id in row["audioIds"]:
                    if audio_id not in existing and audio_id not in ambiguous:
                        aliases.add(audio_id)
                        added.add((bank["id"], stream["index"], audio_id))
                if aliases:
                    stream["interactionAudioIds"] = sorted(aliases)
    return {"source": "cfgSound.lua", "addedCount": len(added),
            "added": [{"bank": bank, "stream": stream, "audioId": audio_id}
                      for bank, stream, audio_id in sorted(added)],
            "ambiguousAudioIds": sorted(ambiguous)}


def _cjk(script: str) -> str:
    folded = fold_label(script)
    return "".join(char for char in folded if "\u4e00" <= char <= "\u9fff")


def _scripts_differ(left: str, right: str) -> bool:
    """True when two tables describe the same stream with different lines.

    Compared after folding traditional onto simplified and dropping punctuation,
    so `获得` vs `獲得` is agreement while `升级` vs `战斗失败` is not.
    """
    a, b = _cjk(left), _cjk(right)
    if len(a) < 2 or len(b) < 2:
        return False
    return a[:14] != b[:14]


# `CfgCardRole` uses the literal string "none" (and an empty string) for two roles
# that ship without a display name.  Passing those through would print "none" in the
# UI as though it were a name.
PLACEHOLDER_NAMES = {"", "none", "?"}


def display_name(role_id: str) -> str | None:
    """The role's Chinese name, or None when the game never gave it one."""
    name = load_card_roles().get(role_id, {}).get("sName", "")
    return None if name.strip().lower() in PLACEHOLDER_NAMES else name



def normalize(value: str) -> str:
    return re.sub(r"[^a-z0-9]", "", value.lower())


def parse_metadata(output: str) -> list[dict[str, Any]]:
    streams: list[dict[str, Any]] = []
    blocks = re.split(r"(?=metadata for )", output)
    for block in blocks:
        index = re.search(r"^stream index:\s*(\d+)", block, re.M)
        name = re.search(r"^stream name:\s*(.+)$", block, re.M)
        samples = re.search(r"^stream total samples:\s*(\d+)", block, re.M)
        sample_rate = re.search(r"^sample rate:\s*(\d+) Hz", block, re.M)
        if not (index and name and samples and sample_rate):
            continue
        streams.append(
            {
                "index": int(index.group(1)),
                "name": name.group(1).strip(),
                "duration": round(int(samples.group(1)) / int(sample_rate.group(1)), 3),
            }
        )
    return streams


def probe_bank(decoder: Path, source: Path) -> list[dict[str, Any]]:
    result = subprocess.run(
        [str(decoder), "-m", "-S", "0", str(source)],
        check=True,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    streams = parse_metadata(result.stdout)
    if not streams:
        raise ValueError(f"decoder returned no streams for {source.name}")
    return streams


def build_manifest(
    source_root: Path, spine_manifest: Path, decoder: Path,
    previous_manifest: dict[str, Any] | None = None,
) -> dict[str, Any]:
    if not decoder.is_file():
        raise FileNotFoundError(f"vgmstream decoder not found: {decoder}")
    gallery = json.loads(spine_manifest.read_text(encoding="utf-8"))
    bank_files = sorted(source_root.glob("*.acb"), key=lambda item: item.name.lower())
    skin_files = sorted((source_root / "cv_skin").glob("*.acb"), key=lambda item: item.name.lower())
    id_counts: dict[str, int] = {}
    for source in [*bank_files, *skin_files]:
        key = normalize(source.stem)
        id_counts[key] = id_counts.get(key, 0) + 1

    def bank_id_for(source: Path) -> str:
        base = normalize(source.stem)
        if id_counts[base] == 1:
            return base
        relative = source.relative_to(source_root).as_posix().lower()
        return base + "_" + hashlib.sha256(relative.encode("utf-8")).hexdigest()[:8]
    banks_by_key = {normalize(path.stem): path for path in bank_files}
    bank_cache: dict[str, dict[str, Any]] = {}
    entries: dict[str, dict[str, Any]] = {}
    variant_entries: dict[str, dict[str, Any]] = {}
    unmapped_leader: list[str] = []
    sound = load_sound_book()
    skin_files_by_group: dict[int, set[Path]] = {}
    skin_files_by_name = {path.name.lower(): path for path in skin_files}
    for (sheet, _), row in sound.items():
        audio_id = row.get("audioId")
        if not isinstance(audio_id, int) or not sheet.startswith("cv/cv_skin/"):
            continue
        source = skin_files_by_name.get(Path(sheet).name.lower())
        if source:
            skin_files_by_group.setdefault(audio_id // 100, set()).add(source)

    def gallery_role_id(entry: dict[str, Any]) -> str | None:
        """Fallback route: the spine gallery's own character ids."""
        for character_id in entry.get("characterIds", []):
            if len(character_id) == 5 and config_for_role(character_id):
                return character_id
        return None

    def resolve_entry_role(entry: dict[str, Any], source: Path) -> str | None:
        """Prefer the authoritative route: ACB filename -> CfgCardRole.eName."""
        return resolve_role_id(source.stem) or gallery_role_id(entry)

    def annotate_bank(
        bank: dict[str, Any], role_id: str | None, allow_official: bool = True
    ) -> dict[str, Any]:
        """Attach role identity and per-line semantics to one voice bank.

        Two sources exist and they are not interchangeable:

        * `CfgCardRoleVoice` — the curated per-card table.  Simplified labels, and
          the only one that covers the 53 roles the in-game voice gallery lists.
        * `cfgSound` — the master sound book, keyed by ACB path plus stream name.
          It covers 135 of 137 character banks and 181 of 187 skin banks, which the
          curated table never reaches, but its labels are traditional Chinese.

        The curated table is used where it is *still aligned with the shipped ACB*;
        `role_label_alignment()` measures that by comparing the two tables' scripts
        for the same stream.  A role whose official mapping has drifted falls back to
        the sound book rather than keeping labels that no longer describe the audio
        being played.  Thunder, cue 32, is the measured example: 1.034 s of audio,
        which the curated table fills with a 91-character line and the sound book with
        「不錯呢。」 — four characters.

        `allow_official=False` keeps the identity but takes every label from the
        sound book.  Skin banks need that: a skin is the same character (so the name
        belongs) but its streams are a separate, longer cue set that the base role's
        config does not describe.

        Identity is attached whenever it is known, even with no semantics at all.
        The previous version returned early when a role had no `CfgCardRoleVoice`
        entry, which threw away a resolved role name for 82 banks and left them
        indistinguishable from genuinely unrecognised ones.
        """
        sheet = sound_sheet(bank)
        official = config_for_role(role_id) if (role_id and allow_official) else None
        cues = {id(stream): cue_of(stream) for stream in bank["streams"]}
        # A cue can own several streams (`Badlands_12` / `Badlands_12_b`).  Keep the
        # plain `_<n>` name as that cue's representative so the alignment sample is
        # not silently taken from a half-line like `_b`.
        cue_to_name: dict[int, str] = {}
        for stream in bank["streams"]:
            cue = cues[id(stream)]
            if cue not in cue_to_name or re.search(r"_\d+$", stream["name"]):
                cue_to_name[cue] = stream["name"]

        alignment = None
        if official:
            alignment = role_label_alignment(sheet, cue_to_name, official, sound)
        use_official = bool(official) and (alignment is None or alignment["aligned"])

        matched = conflicts = 0
        for stream in bank["streams"]:
            cue = cues[id(stream)]
            row = sound.get((sheet, stream["name"]))
            entry = official.get(cue) if use_official else None
            if entry and row and isinstance(row.get("audioId"), int) and row["audioId"] != entry.get("audioId"):
                # The curated gallery label can be correct while cfgSound uses
                # another runtime ID for the same cue. Keep both playback keys.
                stream["interactionAudioIds"] = [row["audioId"]]
            if entry and row and str(entry.get("script", "")) and str(row.get("script", "")):
                # Both tables describe this stream.  Record how often they differ —
                # it is the metric that tells whether the curated table has drifted.
                if _scripts_differ(str(entry["script"]), str(row["script"])):
                    conflicts += 1
            if entry:
                stream["semantic"] = dict(entry, cue=cue, source="roleVoice")
                matched += 1
            elif row:
                stream["semantic"] = {
                    "audioId": row["audioId"],
                    "cue": cue,
                    "position": None,
                    "type": row["type"],
                    "label": row["label"],
                    "labelSimplified": row["labelSimplified"],
                    "category": row["category"],
                    "script": row["script"],
                    "openLv": row["openLv"],
                    "source": "soundBook",
                }
                matched += 1
        if role_id:
            bank["roleId"] = role_id
            bank["roleName"] = display_name(role_id)
        if official:
            bank["officialAligned"] = bool(alignment and alignment["aligned"])
            if alignment:
                bank["officialCompared"] = alignment["compared"]
                bank["officialMatched"] = alignment["matched"]
        bank["labelSource"] = (
            "roleVoice" if use_official else ("soundBook" if matched else "none")
        )
        bank["semanticStreamCount"] = matched
        bank["labelConflictCount"] = conflicts
        bank["resolvedCueCount"] = len(official) if official else 0
        return bank

    def load_bank(source: Path) -> dict[str, Any]:
        bank_id = bank_id_for(source)
        bank = bank_cache.get(bank_id)
        if bank is None:
            streams = probe_bank(decoder, source)
            bank = {
                "id": bank_id,
                "title": source.stem,
                "sourceFile": source.name,
                "sourceGroup": "cv_skin" if source.parent.name.lower() == "cv_skin" else "cv",
                "bytes": source.stat().st_size,
                "streamCount": len(streams),
                "streams": streams,
            }
            bank_cache[bank_id] = bank
        return bank

    for entry in gallery["entries"]:
        if entry["category"] != "character":
            continue
        title_key = normalize(entry["title"])
        bank_key = NAME_ALIASES.get(title_key, title_key)
        source = banks_by_key.get(bank_key)
        if source is None:
            continue
        # Role identity now comes from the bank filename via CfgCardRole.eName, so
        # the spine gallery's `characterIds` is no longer needed to mint a roleId.
        # 38 character entries carry no characterIds; 30 of them still have a voice
        # bank, and 12 of those have an authoritative config that used to be lost.
        entries[entry["id"]] = annotate_bank(load_bank(source), resolve_entry_role(entry, source))

        if entry["id"] == "character:leader":
            for variant in entry["variants"]:
                character_id = variant["main"].get("characterId")
                bank_name = (LEADER_BANKS.get(character_id) or {}).get(variant["kind"])
                if not bank_name:
                    unmapped_leader.append(variant["id"])
                    continue
                # Skin banks live under `cv/cv_skin/`; the base ones under `cv/`.
                leader_source = source_root / bank_name
                if not leader_source.is_file():
                    leader_source = source_root / "cv_skin" / bank_name
                # The protagonists are the one case where the bank filename resolves to
                # nothing: `syujinko_*` has no `CfgCardRole` row, so `resolve_role_id`
                # returns None and the gallery's own id is all there is.  Using it
                # (rather than None) is what keeps the four protagonists apart — it is
                # the id the variant path itself is named after (`71013_skin_Leader03_spine`).
                # Their `roleName` stays None because `CfgCardRole` carries no row for
                # them; `cfgcharacter.key` does (總隊長 / 總隊長·純白) but it is not the
                # table the rest of the viewer takes names from.
                variant_entries[variant["id"]] = annotate_bank(
                    load_bank(leader_source),
                    resolve_role_id(leader_source.stem) or character_id,
                    allow_official=variant["kind"] != "skin",
                )

        for variant in (item for item in entry["variants"] if item["kind"] == "skin"):
            role_id = str(variant["main"].get("characterId", ""))
            source_name = str(variant["main"].get("sourceName", "")).lower()
            tail = source_name.removeprefix(role_id).replace("_asmr", "")
            skin_match = re.search(r"skin(\d{1,2})", tail)
            if not skin_match:
                skin_match = re.search(r"(\d{1,2})([a-z]?)(?:_(?:character|spine))?$", tail)
            if len(role_id) != 5 or not skin_match:
                continue
            group = int(role_id) * 10 + int(skin_match.group(1))
            candidates = sorted(skin_files_by_group.get(group, ()), key=lambda path: path.name.lower())
            suffix = (skin_match.group(2) if skin_match.lastindex and skin_match.lastindex >= 2 else "") or ""
            wanted_suffix = "" if suffix in ("", "a") else suffix
            matching = candidates[:]
            if len(matching) > 1:
                matching = []
                for path in candidates:
                    ending = re.search(r"skin\d+_?([a-z])$", path.stem, re.I)
                    if (ending.group(1).lower() if ending else "") == wanted_suffix:
                        matching.append(path)
            if len(matching) != 1:
                continue
            skin_source = matching[0]
            # cfgSound's audio-id group identifies the exact skin even when it
            # belongs to a different role than the gallery's base character.
            variant_entries[variant["id"]] = annotate_bank(
                load_bank(skin_source),
                role_id,
                allow_official=False,
            )

    matched_bank_count = len(bank_cache)
    auxiliary_entries: dict[str, dict[str, Any]] = {}
    unprobeable_banks: list[str] = []
    for source in [*bank_files, *skin_files]:
        if bank_id_for(source) in bank_cache:
            continue
        try:
            bank = load_bank(source)
        except (ValueError, subprocess.CalledProcessError):
            unprobeable_banks.append(source.name)
            continue
        sheet = sound_sheet(bank)
        groups = {
            row["audioId"] // 100
            for (path, _), row in sound.items()
            if path == sheet and isinstance(row.get("audioId"), int)
        }
        role_id = str(next(iter(groups)) // 10) if len(groups) == 1 else resolve_role_id(source.stem.split("_skin")[0])
        auxiliary_entries[bank["id"]] = annotate_bank(
            bank, role_id, allow_official=bank["sourceGroup"] == "cv"
        )

    reused_previous = 0
    if previous_manifest:
        previous_banks = {
            (bank.get("sourceGroup", "cv"), bank["sourceFile"].lower()): bank
            for bank in [
                *previous_manifest.get("entries", {}).values(),
                *previous_manifest.get("variantEntries", {}).values(),
                *previous_manifest.get("auxiliaryEntries", {}).values(),
            ]
        }
        for bank in bank_cache.values():
            old = previous_banks.get((bank["sourceGroup"], bank["sourceFile"].lower()))
            if not old or old.get("bytes") != bank["bytes"] or old.get("streamCount") != bank["streamCount"]:
                continue
            if any(
                (new["index"], new["name"], new["duration"])
                != (prior["index"], prior["name"], prior["duration"])
                for new, prior in zip(bank["streams"], old["streams"])
            ):
                continue
            for stream, prior in zip(bank["streams"], old["streams"]):
                if not stream.get("semantic") and prior.get("semantic"):
                    stream["semantic"] = prior["semantic"]
                    reused_previous += 1
            bank["semanticStreamCount"] = sum(bool(stream.get("semantic")) for stream in bank["streams"])
            if any(stream.get("semantic", {}).get("source") == "roleVoice" for stream in bank["streams"]):
                bank["labelSource"] = "roleVoice"
            elif bank["semanticStreamCount"]:
                bank["labelSource"] = "soundBook"

    # A damaged cfgSound block can remove individual rows while leaving the
    # bank's audio-id group and ACB cue names intact. Recover only an unlabelled
    # stream with one unambiguous numeric cue inside a bank whose surviving rows
    # unanimously establish the same audio-id offset. Split takes can start at
    # 37 or 60 rather than 1, so a plain group prefix would point at the wrong
    # audio (Silver Feather and Machairodus are measured examples).
    for bank in bank_cache.values():
        offsets = {
            stream["semantic"]["audioId"] - cue_of(stream)
            for stream in bank["streams"]
            if stream.get("semantic") and isinstance(stream["semantic"].get("audioId"), int)
        }
        if len(offsets) != 1:
            continue
        offset = next(iter(offsets))
        by_cue: dict[int, list[dict[str, Any]]] = {}
        for stream in bank["streams"]:
            by_cue.setdefault(cue_of(stream), []).append(stream)
        for cue, streams in by_cue.items():
            if (0 < cue < 100 and len(streams) == 1 and not streams[0].get("semantic")
                    and re.fullmatch(r"[A-Za-z0-9_]+_\d{1,2}", streams[0]["name"])):
                streams[0]["interactionAudioId"] = offset + cue
        bank["inferredAudioStreamCount"] = sum(
            "interactionAudioId" in stream for stream in bank["streams"]
        )

    def labelled(bank: dict[str, Any]) -> bool:
        return bool(bank.get("semanticStreamCount"))

    semantic_banks = [bank for bank in bank_cache.values() if bank.get("semanticStreamCount")]
    resolved_banks = [bank for bank in bank_cache.values() if bank.get("roleId")]
    all_banks = list(bank_cache.values())
    # Counted over the loaded banks, not over annotation calls: two variant entries
    # can point at one ACB (`Dainslef_skin117` ships under both the normal and the JP
    # variant path), and counting that bank twice would make this disagree with
    # `semanticStreamCount`, which walks the same unique set.
    source_counts = {
        name: sum(
            1
            for bank in all_banks
            for stream in bank["streams"]
            if stream.get("semantic", {}).get("source") == name
        )
        for name in ("roleVoice", "soundBook")
    }
    manifest: dict[str, Any] = {
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "source": str(source_root),
        "decoder": str(decoder),
        "availableBankCount": len(bank_files) + len(skin_files),
        "matchedBankCount": matched_bank_count,
        "indexedBankCount": len(bank_cache),
        "unprobeableBanks": unprobeable_banks,
        "voiceEntryCount": len(entries),
        "semanticRoleCount": len(load_role_voices()),
        "resolvedRoleCount": len({bank["roleId"] for bank in resolved_banks}),
        "semanticBankCount": len(semantic_banks),
        "semanticEntryCount": sum(1 for bank in entries.values() if labelled(bank)),
        "semanticStreamCount": sum(
            1 for bank in bank_cache.values() for stream in bank["streams"] if stream.get("semantic")
        ),
        "streamCount": sum(bank["streamCount"] for bank in bank_cache.values()),
        "inferredAudioStreamCount": sum(bank.get("inferredAudioStreamCount", 0) for bank in bank_cache.values()),
        "reusedPreviousSemanticCount": reused_previous,
        "roleVoiceDamagedBlocks": get_bundle().damaged_blocks("cfgCfgCardRoleVoice.lua"),
        # -- label provenance -------------------------------------------------
        "labelSourceCounts": source_counts,
        "soundBookStreamCount": source_counts["soundBook"],
        "identityOnlyBankCount": sum(
            1 for bank in all_banks if bank.get("roleId") and not bank.get("semanticStreamCount")
        ),
        "unresolvedBankCount": sum(1 for bank in all_banks if not bank.get("roleId")),
        "unmappedLeaderVariants": unmapped_leader,
        "labelConflictCount": sum(bank.get("labelConflictCount", 0) for bank in all_banks),
        "officialAlignedRoleCount": len(
            {bank["roleId"] for bank in all_banks if bank.get("officialAligned")}
        ),
        "officialDriftedRoleCount": len(
            {
                bank["roleId"]
                for bank in all_banks
                if bank.get("officialAligned") is False
            }
        ),
        "skinBankCount": sum(1 for bank in all_banks if bank.get("sourceGroup") == "cv_skin"),
        "skinLabelledBankCount": sum(
            1 for bank in all_banks if bank.get("sourceGroup") == "cv_skin" and labelled(bank)
        ),
        "soundBook": sound_book_status(),
        "entries": entries,
        "variantEntries": variant_entries,
        "auxiliaryEntries": auxiliary_entries,
    }
    add_chinese_banks(manifest, source_root, decoder)
    # The 多人立绘 group rides in the same manifest so its per-line audio is served
    # by the existing `/assets/voice/<id>/<index>.wav` route.
    manifest.update(build_picture_entries(source_root, decoder))
    manifest["soundAliasEnrichment"] = enrich_sound_aliases(manifest, sound)
    return manifest


def add_chinese_banks(manifest: dict[str, Any], source_root: Path, decoder: Path) -> None:
    """Enrich a Japanese manifest using the optional Chinese CV package.

    Match streams by cue name because the two ACBs can have different indexes.
    This can also run on an existing manifest when a damaged Lua bundle prevents
    rebuilding the Japanese semantic index.
    """
    chinese_root = DEFAULT_CHINESE_SOURCE if source_root.resolve() == DEFAULT_SOURCE.resolve() else source_root.parent.parent / "sounds_cn" / "cv"
    chinese_files = {path.name.lower(): path for path in chinese_root.glob("*.acb")}
    chinese_banks: dict[str, dict[str, Any]] = {}
    sound = load_sound_book()

    def chinese_bank(japanese: dict[str, Any]) -> dict[str, Any] | None:
        if japanese.get("sourceGroup") != "cv":
            return None
        source = chinese_files.get(japanese["sourceFile"].lower())
        if source is None:
            return None
        key = source.name.lower()
        if key not in chinese_banks:
            streams = probe_bank(decoder, source)
            japanese_semantics = {
                stream["name"].lower(): stream["semantic"]
                for stream in japanese["streams"] if stream.get("semantic")
            }
            japanese_interaction_ids = {
                stream["name"].lower(): stream["interactionAudioId"]
                for stream in japanese["streams"] if stream.get("interactionAudioId")
            }
            japanese_alternate_ids = {
                stream["name"].lower(): stream["interactionAudioIds"]
                for stream in japanese["streams"] if stream.get("interactionAudioIds")
            }
            for stream in streams:
                semantic = japanese_semantics.get(stream["name"].lower())
                if semantic:
                    stream["semantic"] = semantic
                else:
                    row = sound.get(("cv/" + source.name.lower(), stream["name"]))
                    if row:
                        stream["semantic"] = {
                            **row, "cue": cue_of(stream), "position": None,
                            "source": "soundBook",
                        }
                interaction_id = japanese_interaction_ids.get(stream["name"].lower())
                if interaction_id:
                    stream["interactionAudioId"] = interaction_id
                alternate_ids = japanese_alternate_ids.get(stream["name"].lower())
                if alternate_ids:
                    stream["interactionAudioIds"] = alternate_ids
            chinese_banks[key] = {
                "id": "cn_" + normalize(source.stem),
                "title": source.stem,
                "sourceFile": source.name,
                "sourceGroup": "cv_cn",
                "bytes": source.stat().st_size,
                "streamCount": len(streams),
                "streams": streams,
                "roleId": japanese.get("roleId"),
                "roleName": japanese.get("roleName"),
                "labelSource": japanese.get("labelSource", "none"),
                "semanticStreamCount": sum(bool(stream.get("semantic")) for stream in streams),
            }
        return chinese_banks[key]

    manifest["chineseEntries"] = {
        key: bank for key, japanese in manifest["entries"].items()
        if (bank := chinese_bank(japanese)) is not None
    }
    manifest["chineseVariantEntries"] = {
        key: bank for key, japanese in manifest["variantEntries"].items()
        if (bank := chinese_bank(japanese)) is not None
    }
    manifest["chineseAvailableBankCount"] = len(chinese_files)
    manifest["chineseMatchedBankCount"] = len(chinese_banks)
    manifest["chineseStreamCount"] = sum(bank["streamCount"] for bank in chinese_banks.values())


def decode_stream(
    bank: dict[str, Any],
    stream_index: int,
    source_root: Path = DEFAULT_SOURCE,
    cache_root: Path = DEFAULT_CACHE,
    decoder: Path = DEFAULT_DECODER,
) -> Path:
    if stream_index < 1 or stream_index > int(bank["streamCount"]):
        raise ValueError("voice stream index out of range")
    source_group = bank.get("sourceGroup", "cv")
    # Path is relative to `sounds/cv`, so the 多人立绘 group has to climb out of it.
    source_dir = (DEFAULT_CHINESE_SOURCE if source_group == 'cv_cn' and source_root.resolve() == DEFAULT_SOURCE.resolve()
                  else source_root.joinpath(*VOICE_SOURCE_SUBDIRS.get(source_group, ()))).resolve()
    source = (source_dir / bank["sourceFile"]).resolve()
    if source.parent != source_dir.resolve() or not source.is_file():
        raise FileNotFoundError("voice bank not found")
    output_dir = cache_root / "voice" / bank["id"]
    output_dir.mkdir(parents=True, exist_ok=True)
    output = output_dir / f"{stream_index}.wav"
    if output.is_file() and output.stat().st_size > 44:
        return output
    temporary = output_dir / f"{stream_index}.tmp.wav"
    temporary.unlink(missing_ok=True)
    try:
        subprocess.run(
            [str(decoder), "-s", str(stream_index), "-o", str(temporary), str(source)],
            check=True,
            capture_output=True,
            timeout=60,
        )
        if not temporary.is_file() or temporary.stat().st_size <= 44:
            raise RuntimeError("decoder did not produce a valid WAV")
        temporary.replace(output)
    finally:
        temporary.unlink(missing_ok=True)
    return output


def probe_audio(source: Path, decoder: Path = DEFAULT_DECODER) -> dict[str, int]:
    """Header facts about one ACB: total frames, rate, channels.

    `-I` prints the info as JSON but, unlike `-m`, it **still decodes** — and with no
    `-o` the decoder's default output is `<infile>.wav`, i.e. a 200–320 MB WAV dropped
    next to the album inside the read-only game directory.  Measured: one `-I` call on a
    1.3 MB preview produced a 7.7 MB `c2.acb.wav` beside it.  Pointing `-o` at the null
    device keeps the JSON and writes nothing (`-m` cannot be used instead: it emits the
    same facts as locale-dependent text and yields no stream name).
    """
    result = subprocess.run(
        [str(decoder), "-I", "-o", os.devnull, str(source)],
        check=True,
        capture_output=True,
        text=True,
        timeout=60,
    )
    info = json.loads(result.stdout)
    return {
        "samples": int(info["numberOfSamples"]),
        "sampleRate": int(info["sampleRate"]),
        "channels": int(info["channels"]),
    }


def asmr_spine_index(spine_manifest: Path) -> dict[str, dict[str, Any]]:
    """Map a Spine folder name to the gallery variant that serves it.

    `CfgASMR.l2d` names the folder (`70030_skin_Poseidon03_ASMR_spine`) while the
    gallery manifest already knows the variant id and its asset paths, so the album
    only has to be pointed at one.  Keyed by `normalize()` because the two spellings
    differ in case, which is exactly how they differ here.
    """
    if not spine_manifest.is_file():
        return {}
    gallery = json.loads(spine_manifest.read_text(encoding="utf-8"))
    index: dict[str, dict[str, Any]] = {}
    for entry in gallery.get("entries", []):
        for variant in entry.get("variants", []):
            main = variant.get("main") or {}
            folder = main.get("folder")
            if not folder:
                continue
            # First writer wins so a re-scan cannot silently repoint an album at a
            # duplicate folder that happens to carry the same name.
            index.setdefault(normalize(folder), {"variantId": variant.get("id"), "main": main})
    return index


def build_asmr_manifest(
    source_root: Path = DEFAULT_SOURCE,
    decoder: Path = DEFAULT_DECODER,
    spine_manifest: Path | None = None,
    probe: bool = True,
) -> dict[str, Any]:
    """`cache/asmr.generated.json`: the seven ASMR albums, script and audio joined.

    `CfgAsmrVoice` gives 1,157 timed lines but never names a file; `CfgASMR` gives
    the album that owns each script id plus its two sheets.  Joining them is the
    whole job — the character comes from the album's `model` field (its first five
    digits are the role id), not from guessing at the file name.

    The third table is the Spine gallery: `CfgASMR.l2d` names the 立绘 the game shows
    while the album plays, and `spine_manifest` is what turns that folder name into a
    loadable variant.  An album whose 立绘 is missing is reported in `missingSpine`
    rather than silently rendered empty.
    """
    sound_root = source_root.parent
    roles = load_card_roles()
    scripts = load_asmr_voice()
    spine_index = asmr_spine_index(spine_manifest) if spine_manifest else {}
    albums: list[dict[str, Any]] = []
    missing: list[str] = []
    missing_spine: list[str] = []
    total_lines = 0
    total_seconds = 0.0

    for album in load_asmr_albums():
        model = album.get("model")
        role_id = str(model)[:5] if isinstance(model, int) else None
        info: dict[str, int] = {}
        source = sound_root / album["sheet"]
        if probe and source.is_file():
            info = probe_audio(source, decoder)
        elif not source.is_file():
            missing.append(album["sheet"])
        lines = scripts.get(album["voice"], [])
        total_lines += len(lines)
        seconds = info.get("samples", 0) / info["sampleRate"] if info else 0.0
        total_seconds += seconds
        preview = {}
        preview_source = sound_root / album["previewSheet"] if album["previewSheet"] else None
        if probe and preview_source is not None and preview_source.is_file():
            preview = probe_audio(preview_source, decoder)
        spine = spine_index.get(normalize(album["l2d"])) if album["l2d"] else None
        if spine is None:
            missing_spine.append(album["l2d"] or album["sheet"])
        albums.append(
            {
                "id": album["id"],
                "voice": album["voice"],
                "title": album["name"],
                "description": album["description"],
                "cvName": album["cvName"],
                "roleId": role_id,
                "roleName": display_name(role_id) if role_id else None,
                "l2d": album["l2d"],
                "spineVariant": spine["variantId"] if spine else None,
                "spine": spine["main"] if spine else None,
                "sheet": album["sheet"],
                "previewSheet": album["previewSheet"],
                "sourceFile": Path(album["sheet"]).name,
                "sourceDir": Path(album["sheet"]).parent.as_posix(),
                "seconds": round(seconds, 3),
                "sampleRate": info.get("sampleRate"),
                "channels": info.get("channels"),
                "previewSeconds": (
                    round(preview["samples"] / preview["sampleRate"], 3) if preview else None
                ),
                "lineCount": len(lines),
                "lines": lines,
            }
        )
    return {
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "albumCount": len(albums),
        "lineCount": total_lines,
        "totalSeconds": round(total_seconds, 3),
        "missingSheets": missing,
        "missingSpine": missing_spine,
        "albums": albums,
    }


def asmr_sheet_path(album: dict[str, Any], preview: bool, sound_root: Path) -> Path:
    """Resolve one of an album's two sheets, refusing anything outside `sounds/`."""
    sheet = album["previewSheet"] if preview else album["sheet"]
    if not sheet:
        raise FileNotFoundError("asmr album has no preview sheet")
    candidate = (sound_root / sheet).resolve()
    if sound_root.resolve() not in candidate.parents or not candidate.is_file():
        raise FileNotFoundError("asmr album not found")
    return candidate


def decode_asmr(
    album: dict[str, Any],
    preview: bool,
    source_root: Path = DEFAULT_SOURCE,
    cache_root: Path = DEFAULT_CACHE,
    decoder: Path = DEFAULT_DECODER,
) -> Path:
    """Decode one whole ASMR album (or its short preview) to a cached WAV.

    Unlike `decode_stream` this is a ~20 minute track, so the file is around 200 MB
    and the timeout is raised accordingly.  The preview is a *different* asset —
    the album's `_Check` sheet — not a trimmed version of the full track.  The
    decoder is told `-s 1` because the album ACBs are single-subsong.
    """
    source = asmr_sheet_path(album, preview, source_root.parent)
    output_dir = cache_root / "asmr"
    output_dir.mkdir(parents=True, exist_ok=True)
    output = output_dir / (f"{album['voice']}-preview.wav" if preview else f"{album['voice']}.wav")
    if output.is_file() and output.stat().st_size > 44:
        return output
    temporary = output.with_suffix(".tmp.wav")
    temporary.unlink(missing_ok=True)
    try:
        subprocess.run(
            [str(decoder), "-s", "1", "-o", str(temporary), str(source)],
            check=True,
            capture_output=True,
            timeout=300,
        )
        if not temporary.is_file() or temporary.stat().st_size <= 44:
            raise RuntimeError("decoder did not produce a valid WAV")
        temporary.replace(output)
    finally:
        temporary.unlink(missing_ok=True)
    return output


PICTURE_LABEL_RE = re.compile(r"^(?P<title>[^-]+)-(?P<character>.+)$")
PICTURE_TRAILING_INDEX_RE = re.compile(r"\d+$")
PICTURE_TEST_MARKER = "測試用"


def split_picture_label(label: str) -> tuple[str, str]:
    """`暗巷危機-刃齒` -> (封面題名, 角色短名)."""
    match = PICTURE_LABEL_RE.match(label or "")
    if not match:
        return (label or "").strip(), ""
    return match.group("title").strip(), match.group("character").strip()


def enrich_picture_texts(entries: dict[str, dict[str, Any]]) -> dict[str, Any]:
    """Fill text only; retain all bank identities, audio indexes and existing scripts."""
    sound = load_sound_book()
    short_names = load_short_name_index()
    supplement = json.loads(Path(__file__).with_name('picture_text_supplement.generated.json').read_text('utf-8'))
    fallback = {}
    for row in supplement['records']:
        key = (row['cueSheet'].lower(), row['cueName'])
        if key in fallback and fallback[key] != row:
            raise ValueError(f'Conflicting picture text supplement: {key}')
        fallback[key] = row
    added = []
    conflicts = []
    for bank in entries.values():
        changed = False
        for stream in bank['streams']:
            key = ('picture/' + bank['sourceFile'].lower(), stream['name'])
            pc, android = sound.get(key), fallback.get(key)
            if pc and pc.get('script') and android and fold_label(pc['script']) != fold_label(android['script']):
                conflicts.append({'bank': bank['id'], 'cue': stream['name'],
                                  'pc': pc['script'], 'android': android['script']})
            if stream.get('semantic', {}).get('script'):
                continue
            record = pc if pc and pc.get('script') else android
            if not record or not record.get('script'):
                continue
            _, character = split_picture_label(record['label'])
            semantic = dict(stream.get('semantic') or {})
            semantic.update({
                'cue': cue_of(stream), 'label': record['label'],
                'labelSimplified': fold_label(record['label']), 'script': record['script'],
                'category': record.get('category') or 'other', 'source': 'soundBook',
                'character': character,
                'characterRoleId': short_names.get(fold_label(PICTURE_TRAILING_INDEX_RE.sub('', character).strip())) if character else None,
                'textProvenance': ({**supplement['source'], 'audioId': record['audioId'],
                                    'cueSheet': key[0], 'cueName': key[1]}
                                   if record is android else {'platform': 'pc', 'asset': 'cfgSound.lua',
                                    'audioId': record['audioId'], 'cueSheet': key[0], 'cueName': key[1]}),
            })
            stream['semantic'] = semantic
            changed = True
            added.append({'bank': bank['id'], 'index': stream['index'],
                          'source': semantic['textProvenance']['platform']})
        if changed:
            speakers = {}
            for stream in bank['streams']:
                semantic = stream.get('semantic') or {}
                character = semantic.get('character')
                if character:
                    speaker = speakers.setdefault(character, {'name': character,
                        'roleId': semantic.get('characterRoleId'), 'streamIndexes': [],
                        'test': PICTURE_TEST_MARKER in character})
                    speaker['streamIndexes'].append(stream['index'])
            bank['speakers'] = sorted(speakers.values(), key=lambda item: (-len(item['streamIndexes']), item['name']))
        bank['semanticStreamCount'] = sum(bool(s.get('semantic')) for s in bank['streams'])
        if bank['semanticStreamCount']:
            bank['labelSource'] = 'soundBook'
    return {'added': added, 'conflicts': conflicts,
            'textCount': sum(bool(s.get('semantic', {}).get('script')) for b in entries.values() for s in b['streams'])}


def refresh_picture_counts(manifest: dict[str, Any]) -> None:
    entries = manifest['pictureEntries']
    manifest['pictureLabelledBankCount'] = sum(bool(b['semanticStreamCount']) for b in entries.values())
    manifest['pictureLabelledStreamCount'] = sum(b['semanticStreamCount'] for b in entries.values())
    manifest['pictureUnlabelledBanks'] = [b['sourceFile'] for b in entries.values() if not b['semanticStreamCount']]
    manifest['pictureSpeakerCount'] = len({s['name'] for b in entries.values() for s in b['speakers']})


def build_picture_entries(
    source_root: Path = DEFAULT_SOURCE, decoder: Path = DEFAULT_DECODER
) -> dict[str, Any]:
    """The `sounds/picture/` group: 多人回忆立绘, one ACB per illustration.

    Unlike the character banks these hold a *conversation*: every stream belongs to
    a named speaker, and the speaker is encoded in the sound book's label as
    `<封面題名>-<角色短名>`.  The short name is not `CfgCardRole.sName` (that holds
    the full personal name) — it resolves through `character.key`, which is the name
    the game itself displays.
    """
    if not decoder.is_file():
        raise FileNotFoundError(f"vgmstream decoder not found: {decoder}")
    picture_root = source_root.parent / "picture"
    sound = load_sound_book()
    short_names = load_short_name_index()
    archive = {str(row["img"]).lower(): row for row in load_multi_picture()}
    entries: dict[str, dict[str, Any]] = {}
    unlabelled: list[str] = []

    for path in sorted(picture_root.glob("*.acb"), key=lambda item: item.name.lower()):
        streams = probe_bank(decoder, path)
        sheet = f"picture/{path.name.lower()}"
        speakers: dict[str, dict[str, Any]] = {}
        labelled = 0
        label_title = ""
        for stream in streams:
            record = sound.get((sheet, stream["name"]))
            if not record:
                continue
            title, character = split_picture_label(record["label"])
            label_title = label_title or title
            role_id = (
                short_names.get(fold_label(PICTURE_TRAILING_INDEX_RE.sub("", character).strip()))
                if character
                else None
            )
            stream["semantic"] = {
                "cue": cue_of(stream),
                "label": record["label"],
                "labelSimplified": record.get("labelSimplified") or fold_label(record["label"]),
                "script": record.get("script", ""),
                "category": record.get("category"),
                "source": "soundBook",
                "character": character,
                "characterRoleId": role_id,
            }
            labelled += 1
            if character:
                speaker = speakers.setdefault(
                    character, {"name": character, "roleId": role_id, "streamIndexes": [], "test": False}
                )
                speaker["streamIndexes"].append(stream["index"])
                if PICTURE_TEST_MARKER in character:
                    speaker["test"] = True
        if not labelled:
            unlabelled.append(path.name)
        row = archive.get(path.stem.lower())
        title = (row or {}).get("title") or label_title or path.stem
        bank_id = f"picture_{normalize(path.stem)}"
        entries[bank_id] = {
            "id": bank_id,
            "title": title,
            "titleSimplified": fold_label(title),
            "sourceFile": path.name,
            "sourceGroup": "picture",
            "bytes": path.stat().st_size,
            "streamCount": len(streams),
            "semanticStreamCount": labelled,
            "labelSource": "soundBook" if labelled else None,
            "archiveId": (row or {}).get("id"),
            "obtain": (row or {}).get("obtain") or "",
            "itemId": (row or {}).get("itemId"),
            "l2dName": (row or {}).get("l2dName") or "",
            "speakers": sorted(
                speakers.values(),
                key=lambda item: (-len(item["streamIndexes"]), item["name"]),
            ),
            "streams": streams,
        }
    text_report = enrich_picture_texts(entries)
    unlabelled = [bank['sourceFile'] for bank in entries.values() if not bank['semanticStreamCount']]
    speaker_names = {speaker["name"] for bank in entries.values() for speaker in bank["speakers"]}
    return {
        "pictureBankCount": len(entries),
        "pictureLabelledBankCount": sum(1 for bank in entries.values() if bank["semanticStreamCount"]),
        "pictureStreamCount": sum(bank["streamCount"] for bank in entries.values()),
        "pictureLabelledStreamCount": sum(bank["semanticStreamCount"] for bank in entries.values()),
        "pictureSpeakerCount": len(speaker_names),
        "pictureUnlabelledBanks": unlabelled,
        "pictureEntries": entries,
        "pictureTextEnrichment": text_report,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Build the local character voice manifest")
    parser.add_argument("--source", type=Path, default=DEFAULT_SOURCE)
    parser.add_argument("--spine-manifest", type=Path, default=DEFAULT_SPINE_MANIFEST)
    parser.add_argument("--decoder", type=Path, default=DEFAULT_DECODER)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--asmr-output", type=Path, default=DEFAULT_ASMR_OUTPUT)
    parser.add_argument("--chinese-only", action="store_true", help="enrich the existing voice manifest without rebuilding Lua semantics")
    parser.add_argument("--picture-text-only", action="store_true", help="fill missing picture texts without probing or decoding audio")
    parser.add_argument("--sound-aliases-only", action="store_true", help="restore exact cfgSound interaction IDs without probing or decoding audio")
    args = parser.parse_args()
    if args.sound_aliases_only:
        manifest = json.loads(args.output.read_text(encoding="utf-8"))
        manifest['soundAliasEnrichment'] = enrich_sound_aliases(manifest)
        print(json.dumps(manifest['soundAliasEnrichment'], ensure_ascii=False))
    elif args.picture_text_only:
        manifest = json.loads(args.output.read_text(encoding="utf-8"))
        manifest['pictureTextEnrichment'] = enrich_picture_texts(manifest['pictureEntries'])
        refresh_picture_counts(manifest)
        print(json.dumps(manifest['pictureTextEnrichment'], ensure_ascii=False))
    elif args.chinese_only:
        manifest = json.loads(args.output.read_text(encoding="utf-8"))
        add_chinese_banks(manifest, args.source, args.decoder)
    else:
        previous = json.loads(args.output.read_text(encoding="utf-8")) if args.output.is_file() else None
        manifest = build_manifest(args.source, args.spine_manifest, args.decoder, previous)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    temporary = args.output.with_suffix(".tmp")
    temporary.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(args.output)
    print(
        f"matched {manifest['voiceEntryCount']} gallery entries to {manifest['matchedBankCount']} banks, "
        f"{manifest['streamCount']} streams -> {args.output}"
    )
    if args.chinese_only or args.picture_text_only or args.sound_aliases_only or not args.asmr_output:
        return
    asmr = build_asmr_manifest(args.source, args.decoder, args.spine_manifest)
    args.asmr_output.parent.mkdir(parents=True, exist_ok=True)
    asmr_temporary = args.asmr_output.with_suffix(".tmp")
    asmr_temporary.write_text(json.dumps(asmr, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    asmr_temporary.replace(args.asmr_output)
    print(
        f"{asmr['albumCount']} ASMR albums, {asmr['lineCount']} timed lines, "
        f"{asmr['totalSeconds'] / 60:.1f} min, "
        f"{asmr['albumCount'] - len(asmr['missingSpine'])}/{asmr['albumCount']} 立绘 resolved -> {args.asmr_output}"
    )


if __name__ == "__main__":
    main()
