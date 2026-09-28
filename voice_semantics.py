"""Authoritative voice semantics for the local viewer.

Three separate things used to be conflated here, and only one of them was real:

1. **`CfgCardRoleVoice` is the authority on what a line is.** Each record carries
   `name` (the official label), `script` (the official Chinese text) and `audio`
   whose low two digits are the CRIWARE cue, i.e. the suffix of the ACB stream
   name (`alps.acb` holds `alps_1` … `alps_46`).
2. **The `type` field is positional, not a semantic enum.** The same `type` value
   carries different labels for different roles (e.g. `type=6` is 战斗MVP for 36
   roles but 战斗胜利 for 9 and 战斗失败 for 5), because roles with fewer lines
   shift everything after them. Categorising on `type` therefore mislabels lines;
   only `name` can be trusted.
3. **`RoleAudioPlayMgr.lua` documents a second, different enumeration**
   (touch = 10, levelBack = 12, …) that does *not* match the numbering used in
   `CfgCardRoleVoice`. It is kept for reference only and must never be mapped onto
   the config's `type` field.

Role identity comes from `CfgCardRole`, which maps a 5-digit id to `eName` and
`sName`; a role's voice config key is `f"{id}1"`. Matching ACB banks by filename
against `eName` recovers far more roles than the old route through the spine
gallery's `characterIds`.

## The second table: `cfgSound.lua`

`CfgCardRoleVoice` only covers 53 of the 190 roles in `CfgCardRole`.  The
remaining banks used to be unlabelled.  `cfgSound.lua` is the game's master sound
book and closes that gap: 9.9k rows, each carrying

    ["cue_sheet"]="cv/Anubis.acb"  ["cue_name"]="Anubis_04"
    ["name"]="行動開始"            ["script1"]="退後，讓我來懲戒它們。"

so a row is identified by *the ACB plus the stream name inside it* — no arithmetic
on an audio id, no fuzzy name matching.  Its `type` field is the documented
`RoleAudioType` enum (see `SOUND_TYPE_CATEGORY`), which also settles the question
the module docstring used to leave open: the enum is real, it just lives here.

Two caveats, both measured rather than assumed:

* In the current client, `cfgSound.lua` has unreadable blocks 570, 578 and 586;
  `CfgCardRoleVoice` has unreadable block 130. Complete records on either side
  remain usable. Earlier client counts below describe the prior readable build.
* For 39 of the 53 curated roles both tables exist and they disagree on ~1.1k
  streams.  Speech rate (`len(script) / duration`, median 3.74 字/秒 across 5,198
  streams) decides which table has drifted: on the streams where the two differ
  enough to tell, `cfgSound` fits the audio 262 times against 81 for the official
  table, and for `Thunder.acb` the official mapping puts a 91-character line on a
  1.03 s stream.  `role_label_alignment()` makes that call per role, so a role
  whose official mapping still matches keeps its curated (simplified) labels.
"""

from __future__ import annotations

import json
import re
import unicodedata
from functools import lru_cache
from pathlib import Path
from typing import Any

from lua_bundle import (
    DEFAULT_LUA_BUNDLE,
    LuaBundle,
    get_bundle,
)

__all__ = [
    "DEFAULT_LUA_BUNDLE",
    "CATEGORY_ORDER",
    "normalize_name",
    "fold_label",
    "parse_card_roles",
    "parse_role_voices",
    "parse_sound_book",
    "load_card_roles",
    "load_role_voices",
    "load_sound_book",
    "load_play_mgr_reference",
    "resolve_role_id",
    "semantic_category",
    "build_role_index",
    "load_asmr_voice",
    "role_label_alignment",
]

CATEGORY_ORDER = ["touch", "home", "battle", "profile", "facility", "shop", "other"]

SOUND_BOOK_ASSET = "cfgSound.lua"

# Traditional -> simplified, derived from the data rather than hand-written.
# `CfgCardRoleVoice` stores scripts in simplified Chinese while `cfgSound` stores the
# same lines in traditional, so 713 cue-aligned script pairs of identical length were
# walked character by character and every substitution seen at least three times was
# kept (see `experiment/diag_derive_fold.py`).  Two results were then corrected: the
# one wrong derivation (`導 -> 道`, actually `導 -> 导`) and one dropped as ambiguous
# (`畫`).  Fifteen more characters occur only in *labels* and never in those script
# pairs, so they are added by hand; `test_fold_map_is_well_formed` pins the whole
# table, and `test_every_reachable_label_is_categorised` catches anything missing.
TRADITIONAL_TO_SIMPLIFIED: dict[str, str] = json.loads(
    (Path(__file__).with_name("voice_fold_map.json")).read_text(encoding="utf-8")
)


# `cfgSound.type` is the real `RoleAudioPlayMgr.RoleAudioType` enum (verified: every
# type that carries a consistent label agrees with the documented comment, while
# `CfgCardRoleVoice.type` is positional and does not).  Used only as a fallback when
# the row's own `name` is not in the label vocabulary.
SOUND_TYPE_CATEGORY = {
    1: "home",  # CrossCore / MEGAGAME
    2: "profile",  # 獲得
    3: "battle",  # 出擊
    4: "profile",  # 升級
    5: "profile",  # 躍升
    6: "profile",  # 最終躍升
    7: "home",  # 登錄
    8: "battle",  # 勝利 / MVP
    9: "battle",  # 失敗
    10: "touch",  # 接觸（好感度分级）
    11: "touch",  # 特殊接触 / 心动接触
    12: "facility",  # 歸來
    13: "facility",  # 遠征歸來
    14: "facility",  # 進入設施
    15: "facility",  # 設施工作 / 設施內語音
    16: "profile",  # 生日祝福
    17: "shop",  # 商店語音
    18: "profile",  # 皮膚專屬「獲得」
    21: "shop",
    22: "shop",
    23: "shop",
}

# Bank filenames that do not normalise onto their role's English name.
NAME_ALIASES = {
    "badlandskr": "badlands",
    "barberared": "barbera",
    "ccc": "chalcosoma",
    "ggg": "goliatus",
    "dainslef03spinejp": "dainslef",
    "hadesdeath": "hades",
    "hadesmian": "hades",
    "heliconiuskr": "heliconius",
    "talbot03spinekr": "talbot",
    "thunderstorm": "thunder",
    "vodkamirror": "vodka",
    # The gallery title for the protagonist is "Leader"; its male voice bank
    # `syujinko_m.acb` normalises to "syujinkom".
    "leader": "syujinkom",
    # Banks that ship twice under two spellings.  Both files are present, so the
    # misspelled twin provably belongs to the same role:
    #   Chalcosma.acb / Chalcosoma.acb          -> CHALCOSOMA C.C. (50250)
    #   IjenBlade.acb / Ijen_Blade.acb          -> Ijen·SP (60350)
    #   Dirwolf_skin116.acb                     -> Direwolf (30200)
    "chalcosma": "chalcosomacc",
    "ijenblade": "ijensp",
    "dirwolf": "direwolf",
}

# Exact labels taken from the full CfgCardRoleVoice vocabulary (105 distinct labels),
# plus the labels that only exist in cfgSound (listed in their simplified form, which
# is what `fold_label` produces).
EXACT_CATEGORY = {
    "游戏开始": "home",
    "MEGAGAME": "home",
    "CrossCore": "home",
    "看板": "home",
    "登录": "home",
    "开心": "home",
    "讨厌": "home",
    "语气词（开心）": "home",
    "语气词（讨厌）": "home",
    "同调开始": "battle",
    "同调后": "home",
    "PV独白": "home",
    "PV语录": "home",
    "召唤时": "home",
    "出击": "battle",
    "行动开始": "battle",
    "开始行动": "battle",
    "战斗不能": "battle",
    "战斗MVP": "battle",
    "战斗胜利": "battle",
    "战斗失败": "battle",
    "战斗结束，回到主界面": "battle",
    "死亡": "battle",
    "机神传送": "battle",
    "同调结束": "battle",
    "同调发动": "battle",
    # The 40-46 tail block of some banks holds co-op reaction lines; their scripts
    # ("你好，請多指教。" / "感謝你的協助。" / "糟糕，推導出錯了……") sit next to
    # 机神传送 and belong to the same battle-support set.
    "问候": "battle",
    "感谢": "battle",
    "称赞": "battle",
    "失误": "battle",
    "威胁": "battle",
    "惊讶": "battle",
    "overload": "battle",
    "获得": "profile",
    "升级": "profile",
    "跃升": "profile",
    "最终跃升": "profile",
    "强化": "profile",
    "突破": "profile",
    "最终突破": "profile",
    "生日": "profile",
    "生日祝福": "profile",
    "配置角色在设施": "facility",
    "配置设施": "facility",
    "归来": "facility",
    "远征归来": "facility",
    "进入设施": "facility",
    "设施工作": "facility",
    "设施内语音": "facility",
    # The game keeps `allocationTouch` (设施接触) separate from `touch` (接触), and
    # clicking a portrait should only draw portrait lines, so facility
    # interactions stay in their own group.
    "设施接触": "facility",
    "点击在设施的角色": "facility",
    # Affection-tier reactions.  cfgSound distinguishes them by the tier in `openLv`
    # (友好 = 41, 挚爱 = 91) while CfgCardRoleVoice only has 喜欢/语气词; all of them
    # are portrait-interaction lines.
    "友好": "touch",
    "喜欢": "touch",
    "挚爱": "touch",
    "不悦": "touch",
    "愉悦": "touch",
    "心动接触": "touch",
    "特殊接触": "touch",
    # A single dev placeholder line; it describes nothing.
    "备用语音": "other",
}

# Ordered patterns cover the numbered / suffixed variants (接触1, 攻击2（同调状态）…).
CATEGORY_PATTERNS: list[tuple[str, str]] = [
    (r"^接触\d+", "touch"),
    (r"^交互\d+", "touch"),
    (r"^看板", "home"),
    (r"^行动开始", "battle"),
    (r"^开始行动", "battle"),
    (r"^攻击\d+", "battle"),
    (r"^受击", "battle"),
    (r"^技能\d+", "battle"),
    (r"^必杀", "battle"),
    (r"^被动技能", "battle"),
    (r"^形态\d+必杀", "battle"),
    (r"^转化形态\d+", "battle"),
    (r"^.+形态技能\d+", "battle"),
    (r"^overload", "battle"),
    (r"^胜利", "battle"),
    (r"^失败", "battle"),
    (r"^获得", "profile"),
    (r"^升级", "profile"),
    (r"^跃升", "profile"),
    (r"^最终跃升", "profile"),
    (r"^进入设施", "facility"),
    (r"^设施工作", "facility"),
    (r"^设施内语音", "facility"),
    (r"^商店语音\d*", "shop"),
]

PLAY_MGR_TYPES: dict[int, tuple[str, str]] = {
    1: ("CrossCore", "游戏开始（标题时语音）"),
    2: ("get", "获得"),
    3: ("enterLevel", "出击"),
    4: ("upgrade", "强化"),
    5: ("perBreak", "突破"),
    6: ("maxBreak", "最终突破"),
    7: ("login", "看板（登录游戏时）"),
    8: ("mvp", "战斗胜利时 MVP 角色的语音"),
    9: ("fail", "战斗失败"),
    10: ("touch", "接触"),
    11: ("sprecialTouch", "特殊部位的接触语音"),
    12: ("levelBack", "归来"),
    13: ("expeditionBack", "远征归来"),
    14: ("allocation", "配置设施"),
    15: ("allocationTouch", "设施接触"),
    16: ("birthday", "角色生日"),
    17: ("shop", "商店语音"),
}


def fold_label(value: str) -> str:
    """Fold traditional Chinese onto simplified so one label map covers both tables."""
    return "".join(TRADITIONAL_TO_SIMPLIFIED.get(char, char) for char in value)


def normalize_name(value: str) -> str:
    """Fold a display name or filename into a comparable key.

    Accents are *transliterated*, not dropped: `CfgCardRole` spells the role
    "Marée Rouge" while its bank is `MareeRouge.acb`, so simply stripping
    non-alphanumerics would yield "marerouge" and never match "mareerouge".
    """
    decomposed = unicodedata.normalize("NFKD", value)
    folded = "".join(char for char in decomposed if not unicodedata.combining(char))
    return re.sub(r"[^a-z0-9]", "", folded.lower())


TRAILING_QUALIFIER_RE = re.compile(r"（[^（）]*）\s*$")

# Longest first, so 最终突破 is preferred over 突破 and 战斗胜利 over 战斗.
_EXACT_KEYS_BY_LENGTH: tuple[str, ...] = tuple(sorted(EXACT_CATEGORY, key=len, reverse=True))


def semantic_category(label: str, type_hint: int | None = None) -> str:
    """Map a label to a browsing category.

    Only the label is consulted for `CfgCardRoleVoice` rows: there `type` is
    positional and therefore unsafe.  `cfgSound` rows may pass `type_hint`, which
    is the genuine `RoleAudioType` enum, but even then it is a *fallback* — the
    label is more specific (`type=10` spans 接触/友好/挚爱).

    Two normalisations run before lookup, because the game hangs both a mode and an
    index off otherwise identical labels — `行动开始（同调状态）`, `失败（复仇状态）`,
    `接触40（特邀大使）`, `登錄1（賽道豔影）`:

    1. a trailing parenthetical is stripped;
    2. a known label used as a prefix is accepted, so numbering a label does not
       knock it out of the vocabulary.

    An exact entry still wins over both.
    """
    folded = fold_label(label)
    candidates = [folded]
    without_suffix = TRAILING_QUALIFIER_RE.sub("", folded)
    if without_suffix != folded:
        candidates.append(without_suffix)
    for candidate in candidates:
        if candidate in EXACT_CATEGORY:
            return EXACT_CATEGORY[candidate]
    for candidate in candidates:
        for pattern, category in CATEGORY_PATTERNS:
            if re.match(pattern, candidate):
                return category
    for candidate in candidates:
        for key in _EXACT_KEYS_BY_LENGTH:
            if candidate.startswith(key):
                return EXACT_CATEGORY[key]
    if type_hint is not None:
        return SOUND_TYPE_CATEGORY.get(type_hint, "other")
    return "other"


def _field(record: str, name: str) -> str | int | None:
    match = re.search(rf'\["{re.escape(name)}"\]=(\d+|"(?:[^"\\]|\\.)*")', record)
    if not match:
        return None
    value = match.group(1)
    if value.startswith('"'):
        return value[1:-1].replace(r"\"", '"').replace(r"\\", "\\")
    return int(value)


def _skip_string(text: str, index: int) -> int:
    """Return the index just past the Lua string literal starting at `index`."""
    if text.startswith("[[", index):
        end = text.find("]]", index + 2)
        return len(text) if end < 0 else end + 2
    if text[index] == '"':
        i = index + 1
        while i < len(text):
            if text[i] == "\\":
                i += 2
                continue
            if text[i] == '"':
                return i + 1
            i += 1
        return len(text)
    return index + 1


def iter_table_entries(text: str) -> list[tuple[str, str]]:
    """Yield top-level `[key]={...}` entries of the first table in `text`.

    Brace-aware rather than regex-based: role records embed `[[...]]` long strings
    (character biographies) that contain braces and newlines, so splitting on a
    lookahead would corrupt the entries.
    """
    start = text.find("={")
    if start < 0:
        return []
    start += 2  # just inside the outer `{`
    entries: list[tuple[str, str]] = []
    depth = 1
    i = start
    entry_key: str | None = None
    entry_start = 0
    while i < len(text):
        char = text[i]
        if char == '"' or text.startswith("[[", i):
            i = _skip_string(text, i)
            continue
        if char == "{":
            depth += 1
            if depth == 2:
                match = re.search(r'\[("?)([^"\]]+)\1\]=$', text[:i])
                if match:
                    entry_key = match.group(2)
                    entry_start = i
            i += 1
            continue
        if char == "}":
            depth -= 1
            if depth == 1 and entry_key is not None:
                entries.append((entry_key, text[entry_start : i + 1]))
                entry_key = None
            i += 1
            if depth == 0:
                break
            continue
        i += 1
    return entries


def _split_entries(text: str, marker: str) -> list[tuple[str, str]]:
    """Top-level entries that contain `marker` somewhere in their body."""
    return [(key, body) for key, body in iter_table_entries(text) if marker in body]


def parse_card_roles(text: str) -> dict[str, dict[str, str]]:
    """id -> {eName, sName} from `CfgCardRole`."""
    roles: dict[str, dict[str, str]] = {}
    for role_id, body in _split_entries(text, '["eName"]'):
        def field(name: str) -> str:
            hit = re.search(rf'\["{name}"\]="([^"]*)"', body)
            return hit.group(1) if hit else ""

        roles[role_id] = {"eName": field("eName"), "sName": field("sName")}
    return roles


def parse_role_voices(text: str) -> dict[str, dict[int, dict[str, Any]]]:
    """configKey -> {cue: record} from `CfgCardRoleVoice`."""
    roles: dict[str, dict[int, dict[str, Any]]] = {}
    for role_id, body in _split_entries(text, '["infos"]'):
        voices: dict[int, dict[str, Any]] = {}
        for record in re.findall(r"\{(.*?)\}", body, re.S):
            audio = _field(record, "audio")
            label = _field(record, "name")
            if not isinstance(audio, int) or not isinstance(label, str):
                continue
            position = _field(record, "index")
            voices[audio % 100] = {
                "audioId": audio,
                "cue": audio % 100,
                "position": position if isinstance(position, int) else None,
                "type": _field(record, "type"),
                "label": label,
                "labelSimplified": fold_label(label),
                "category": semantic_category(label),
                "script": _field(record, "script") or "",
                "openLv": _field(record, "openLv"),
            }
        if voices:
            roles[role_id] = voices
    return roles


def parse_asmr_voice(text: str) -> dict[int, list[dict[str, Any]]]:
    """asmrId -> [{index, word, time}] from `CfgAsmrVoice`."""
    tracks: dict[int, list[dict[str, Any]]] = {}
    for key, body in _split_entries(text, '["arr"]'):
        lines: list[dict[str, Any]] = []
        for record in re.findall(r"\{(.*?)\}", body, re.S):
            word = _field(record, "word")
            index = _field(record, "index")
            time = _field(record, "time")
            if isinstance(word, str) and isinstance(index, int):
                lines.append({"index": index, "word": word, "time": time})
        if lines:
            tracks[int(key)] = sorted(lines, key=lambda item: item["index"])
    return tracks


def parse_asmr_albums(text: str) -> list[dict[str, Any]]:
    """`CfgASMR` rows: the album metadata that owns each `CfgAsmrVoice` script.

    This is the table that ties an ASMR script to its audio.  `CfgAsmrVoice` only
    carries `id` + `arr` (the timed lines) and no file name at all, so the album
    list is the only authoritative mapping from a script id to an `.acb`.

    Two audio sheets per album: `cue_sheet1` is the short shop preview, `cue_sheet2`
    the full track.  `l2d`/`model` carry the character, which is how the album is
    attributed without guessing from the file name.
    """
    albums: list[dict[str, Any]] = []
    for record in re.findall(r"\{([^{}]*)\}", text, re.S):
        voice = _field(record, "voice")
        sheet = _field(record, "cue_sheet2")
        if not isinstance(voice, int) or not isinstance(sheet, str) or not sheet:
            continue
        albums.append(
            {
                "id": _field(record, "id"),
                "voice": voice,
                "name": _field(record, "name") or "",
                "description": _field(record, "des") or "",
                "cvName": _field(record, "cvName") or "",
                "sheet": sheet,
                "cueName": _field(record, "cue_name2") or "",
                "previewSheet": _field(record, "cue_sheet1") or "",
                "previewCueName": _field(record, "cue_name1") or "",
                "icon": _field(record, "icon") or "",
                "l2d": _field(record, "l2d") or "",
                "model": _field(record, "model"),
            }
        )
    return sorted(albums, key=lambda album: album["voice"])


def iter_array_records(text: str) -> list[str]:
    """Each top-level `{...}` body of an *array* table (`={{...},{...}}`).

    `iter_table_entries` cannot serve these: array rows carry no `[key]=` prefix,
    and several of them (`["imgPos"]={...}`, `["l2dPos"]={...}`) contain nested
    braces, so a regex split truncates them.
    """
    start = text.find("={")
    if start < 0:
        return []
    records: list[str] = []
    depth = 0
    record_start = 0
    i = start + 1
    while i < len(text):
        char = text[i]
        if char == '"' or text.startswith("[[", i):
            i = _skip_string(text, i)
            continue
        if char == "{":
            depth += 1
            if depth == 2:
                record_start = i + 1
            i += 1
            continue
        if char == "}":
            depth -= 1
            if depth == 1:
                records.append(text[record_start:i])
            i += 1
            if depth == 0:
                break
            continue
        i += 1
    return records


def parse_multi_picture(text: str) -> list[dict[str, Any]]:
    """`CfgArchiveMultiPicture` rows: the 多人立绘 archive albums.

    `img` is the asset key and is also the ACB basename under `sounds/picture/`,
    which is what lets the sound book's `picture/<img>.acb` rows be attached to a
    titled album instead of floating free.
    """
    albums: list[dict[str, Any]] = []
    for record in iter_array_records(text):
        image = _field(record, "img")
        if not isinstance(image, str) or not image:
            continue
        albums.append(
            {
                "id": _field(record, "id"),
                "img": image,
                "title": _field(record, "sName") or "",
                "obtain": _field(record, "get_txt") or "",
                "itemId": _field(record, "itemId"),
                "shopId": _field(record, "shopId"),
                "l2dName": _field(record, "l2dName") or "",
                "icon": _field(record, "icon") or "",
                "sort": _field(record, "sort"),
                "themeType": _field(record, "theme_type"),
            }
        )
    return sorted(albums, key=lambda album: (album["sort"] is None, album["sort"]))


def parse_characters(text: str) -> dict[str, dict[str, Any]]:
    """`character` rows: charId -> display metadata.

    `key` is the *short* name the game actually shows (赤溟, 咎瓦尤斯, 刃齒) — a
    different string from `CfgCardRole.sName`, which holds the full personal name
    (凱莉·楊, 切尔西·甘迺迪).  The 多人立绘 voice labels are built from the short
    name, so this table is what lets those labels be attributed to a role.
    """
    characters: dict[str, dict[str, Any]] = {}
    for char_id, body in iter_table_entries(text):
        characters[char_id] = {
            "key": _field(body, "key") or "",
            "englishName": _field(body, "englishName") or "",
            "voiceID": _field(body, "voiceID"),
            "image": _field(body, "img") or "",
            "l2dName": _field(body, "l2dName") or "",
        }
    return characters


def parse_play_mgr_reference(text: str) -> dict[int, tuple[str, str]]:
    """Read the documented `RoleAudioType` enum out of a code comment.

    Reference only here: its numbering does not match `CfgCardRoleVoice.type`.
    It *does* match `cfgSound.type` — see `SOUND_TYPE_CATEGORY`.
    """
    found: dict[int, tuple[str, str]] = {}
    for match in re.finditer(r"RoleAudioType\.(\w+)\s*=\s*(\d+)\s*--\s*(.+)", text):
        name, number, comment = match.groups()
        found[int(number)] = (name, comment.strip())
    return found


# `cfgSound.lua` rows are flat `[id]={...}` tables with no nesting, so a forward scan
# is enough and no brace-depth tracking is needed.
SOUND_ENTRY_RE = re.compile(r"\[(\d+)\]\s*=\s*\{")
SOUND_FIELD_RE = re.compile(
    r'\["(\w+)"\]\s*=\s*(?:"((?:[^"\\]|\\.)*)"|(-?\d+)|(true|false))'
)
# Long strings never appear in this table; if one shows up the row is skipped rather
# than parsed wrongly.
SOUND_LONG_STRING = "[["


def parse_sound_book(segments: list[str]) -> dict[tuple[str, str], dict[str, Any]]:
    """Merge `cfgSound` rows from one or more readable block segments.

    Keyed by `(cue_sheet.lower(), cue_name)`, which is the ACB path plus the stream
    name inside it — the only pair that unambiguously names one audio stream.

    A row is kept only when it is *complete*: a row truncated by a damaged block
    still yields `cue_sheet` but loses fields to its right, so requiring both
    `cue_sheet` and `cue_name` **and** a closing brace drops it instead of inventing
    an entry or filling its tail from the next block.

    `label` is the table's own string and stays traditional (`獲得`, `攻擊1`).  It is
    paired with `labelSimplified` so the viewer can show and search one consistent
    form: the curated table next to it is simplified, and a search for `接触` would
    otherwise silently miss every `接觸` row.
    """
    index: dict[tuple[str, str], dict[str, Any]] = {}
    for text in segments:
        starts = [match.start() for match in SOUND_ENTRY_RE.finditer(text)]
        for position, start in enumerate(starts):
            end = starts[position + 1] if position + 1 < len(starts) else len(text)
            body = text[start:end]
            # Rows are separated by `\r\n,`, so a complete row ends with `}` and at
            # most a trailing comma.  A row cut short by the end of a readable block
            # fails this and is dropped.
            if not re.search(r"\}\s*,?\s*$", body):
                continue
            if SOUND_LONG_STRING in body:
                continue
            fields: dict[str, Any] = {}
            for match in SOUND_FIELD_RE.finditer(body):
                key = match.group(1)
                if match.group(2) is not None:
                    fields[key] = match.group(2).replace(r"\"", '"').replace(r"\\", "\\")
                elif match.group(3) is not None:
                    fields[key] = int(match.group(3))
                else:
                    fields[key] = match.group(4) == "true"
            sheet = str(fields.get("cue_sheet", ""))
            cue_name = str(fields.get("cue_name", ""))
            if not sheet or not cue_name:
                continue
            label = str(fields.get("name", ""))
            type_hint = fields.get("type") if isinstance(fields.get("type"), int) else None
            script = fields.get("script1") or fields.get("script2") or ""
            cue_key = (sheet.lower(), cue_name)
            previous = index.get(cue_key, {})
            # Several runtime IDs can intentionally reuse one ACB cue. The
            # last record still supplies the gallery label, but must not erase
            # earlier IDs used by interaction scripts (e.g. Scorching 49/50).
            audio_ids = set(previous.get("audioIds", []))
            for audio_id in (previous.get("audioId"), fields.get("id")):
                if isinstance(audio_id, int):
                    audio_ids.add(audio_id)
            index[cue_key] = {
                "audioId": fields.get("id"),
                "groupId": fields.get("group"),
                "model": fields.get("model"),
                "cueSheet": sheet,
                "cueName": cue_name,
                "label": label,
                "labelSimplified": fold_label(label),
                "category": semantic_category(label, type_hint),
                "type": type_hint,
                "script": script,
                "openLv": fields.get("openLv"),
                "faceIndex": fields.get("faceIndex"),
                "bookDisplay": fields.get("bookDisplay"),
                **({"audioIds": sorted(audio_ids)} if len(audio_ids) > 1 else {}),
            }
    return index


def _comparable(script: str) -> str:
    """Fold to simplified CJK-only text so two renderings of a line can be compared."""
    folded = fold_label(script)
    return "".join(char for char in folded if "\u4e00" <= char <= "\u9fff")


# `Badlands_12_b` and `rays_11_a` are the second block / second half of cue 12 and
# cue 11, not cues of their own — the trailing letter is part of the stream name.
CUE_SUFFIX_RE = re.compile(r"_(\d+)(?:_?[a-z])?_?$", re.I)


def cue_of(stream: dict[str, Any]) -> int:
    """The CRIWARE cue a stream answers to: its name's number, else its position.

    A cue can own more than one stream.  `Badlands_12` sits at index 12 and
    `Badlands_12_b` at index 13, but both are cue 12; `rays_11_a` and `rays_11_b`
    are the two halves of cue 11, which the sound book itself labels 技能3 and
    技能3（結束前）.  Reading the number off the name is therefore the only way to
    get the cue right for those five streams — the index would silently rename
    every later cue in the bank.

    `voice_cache` and the tests both use this, so the alignment measurement is
    taken over exactly the cue map the manifest is built from.
    """
    match = CUE_SUFFIX_RE.search(str(stream.get("name", "")))
    return int(match.group(1)) if match else int(stream["index"])


def role_label_alignment(
    sheet: str,
    cue_to_name: dict[int, str],
    official: dict[int, dict[str, Any]],
    sound: dict[tuple[str, str], dict[str, Any]],
    min_compared: int = 4,
    threshold: float = 0.5,
) -> dict[str, Any]:
    """Decide whether `CfgCardRoleVoice` still lines up with the shipped ACB.

    Both tables assign a script to a cue, so when they describe the same stream the
    scripts must match once simplified/traditional is folded away.  Where they do
    not, the official cue mapping has drifted from the bank (its `audio % 100` no
    longer points at the stream it names) and the sound book should win.

    Fails safe: with fewer than `min_compared` overlapping cues the official table
    is treated as aligned, so an unmeasurable role keeps its curated labels.

    The 0.5 threshold is measured, not chosen: over the 43 roles that own a curated
    table the ratios bifurcate into 0.00-0.48 (11 roles) and 0.52-0.97 (32 roles),
    so the cut sits in an empty gap (see `test_alignment_threshold_sits_in_a_gap`).
    """
    key = sheet.lower()
    compared = matched = 0
    for cue, name in cue_to_name.items():
        entry = official.get(cue)
        row = sound.get((key, name))
        if not entry or not row:
            continue
        left, right = _comparable(str(entry.get("script", ""))), _comparable(str(row.get("script", "")))
        if len(left) < 2 or len(right) < 2:
            continue
        compared += 1
        if left[:14] == right[:14]:
            matched += 1
    ratio = matched / compared if compared else 1.0
    return {
        "compared": compared,
        "matched": matched,
        "ratio": round(ratio, 3),
        "aligned": compared < min_compared or ratio >= threshold,
    }


@lru_cache(maxsize=1)
def _bundle() -> LuaBundle:
    return get_bundle()


@lru_cache(maxsize=1)
def load_card_roles(path: Path | None = None) -> dict[str, dict[str, str]]:
    return parse_card_roles(_bundle().read("cfgCfgCardRole.lua"))


@lru_cache(maxsize=1)
def load_role_voices(path: Path | None = None) -> dict[str, dict[int, dict[str, Any]]]:
    bundle = _bundle()
    name = "cfgCfgCardRoleVoice.lua"
    if not bundle.damaged_blocks(name):
        return parse_role_voices(bundle.read(name))

    # Each top-level role is independent. A damaged block need not make the
    # *other* complete roles disappear. Join adjacent readable blocks, then
    # start after the first complete numeric role key in each later run.
    # `parse_role_voices` uses a brace-aware top-level parser, so the unfinished
    # role at either edge of a run is discarded instead of being labelled with
    # a fragment of another role's script.
    runs: list[str] = []
    previous = -2
    for block_index, text in bundle.read_segments(name):
        if block_index == previous + 1:
            runs[-1] += text
        else:
            runs.append(text)
        previous = block_index
    roles: dict[str, dict[int, dict[str, Any]]] = {}
    for run in runs:
        if run.lstrip("\ufeff").startswith('_G["CfgCardRoleVoice"]={'):
            roles.update(parse_role_voices(run))
            continue
        start = re.search(r'\r\n,\[(\d+)\]=\{', run)
        if start:
            roles.update(parse_role_voices('_G["CfgCardRoleVoice"]={' + run[start.start() + 3:]))
    return roles


@lru_cache(maxsize=1)
def load_sound_book(path: Path | None = None) -> dict[tuple[str, str], dict[str, Any]]:
    """The master sound book, assembled from every readable block of `cfgSound.lua`.

    `read()` cannot serve this asset — it spans two blocks that resist repair — so
    the table is read block by block and the damaged blocks are reported through
    `sound_book_status()` rather than silently reducing coverage.
    """
    segments = (get_bundle(path) if path is not None else _bundle()).read_segments(SOUND_BOOK_ASSET)
    return parse_sound_book(join_readable_segments(segments))


def join_readable_segments(segments: list[tuple[int, str]]) -> list[str]:
    """Preserve records across healthy block edges, never across damaged blocks."""
    runs: list[str] = []
    previous: int | None = None
    for block, text in segments:
        if previous is None or block != previous + 1:
            runs.append(text)
        else:
            runs[-1] += text
        previous = block
    return runs


@lru_cache(maxsize=1)
def sound_book_status() -> dict[str, Any]:
    """How much of `cfgSound.lua` is actually readable, and how clean it is.

    `replacementCharCount` matters because it is the only signal that catches a
    *silent* byte corruption.  The client's Lua payload carries scattered altered
    bytes; most break liblz4 outright (the blocks in `BLOCK_REPAIRS`), but one here
    changed a text byte inside an LZ4 literal run — `魔` (e9 ad 94) became e9 c5 94 —
    which still decodes to the declared length, so no length check can see it.  It
    surfaces only as U+FFFD, and is counted rather than smoothed over.
    """
    bundle = _bundle()
    segments = bundle.read_segments(SOUND_BOOK_ASSET)
    damaged = bundle.damaged_blocks(SOUND_BOOK_ASSET)
    body_at, body_len = bundle.assets[SOUND_BOOK_ASSET]
    readable_bytes = sum(len(text.encode("utf-8", errors="replace")) for _, text in segments)
    replacements = sum(text.count("\ufffd") for _, text in segments)
    return {
        "asset": SOUND_BOOK_ASSET,
        "segments": len(segments),
        "damagedBlocks": damaged,
        "bodyBytes": body_len,
        "readableBytes": readable_bytes,
        "readableRatio": round(readable_bytes / body_len, 4) if body_len else 0.0,
        "replacementCharCount": replacements,
        "rowCount": len(load_sound_book()),
    }


@lru_cache(maxsize=1)
def load_asmr_voice(path: Path | None = None) -> dict[int, list[dict[str, Any]]]:
    return parse_asmr_voice(_bundle().read("cfgCfgAsmrVoice.lua"))


@lru_cache(maxsize=1)
def load_asmr_albums(path: Path | None = None) -> list[dict[str, Any]]:
    return parse_asmr_albums(_bundle().read("cfgCfgASMR.lua"))


@lru_cache(maxsize=1)
def load_multi_picture(path: Path | None = None) -> list[dict[str, Any]]:
    return parse_multi_picture(_bundle().read("cfgCfgArchiveMultiPicture.lua"))


@lru_cache(maxsize=1)
def load_characters(path: Path | None = None) -> dict[str, dict[str, Any]]:
    return parse_characters(_bundle().read("cfgcharacter.lua"))


@lru_cache(maxsize=1)
def load_short_name_index() -> dict[str, str]:
    """Folded short display name -> 5-digit role id.

    A short name can belong to several charIds (base card, break form, skins), all
    sharing the leading five digits.  The lowest charId wins so the mapping is
    stable across runs.
    """
    index: dict[str, str] = {}
    for char_id, info in sorted(load_characters().items()):
        name = info.get("key") or ""
        if not name or len(char_id) < 5:
            continue
        index.setdefault(fold_label(name), char_id[:5])
    return index


@lru_cache(maxsize=1)
def load_play_mgr_reference(path: Path | None = None) -> dict[int, tuple[str, str]]:
    try:
        text = _bundle().read("RoleAudioPlayMgr.lua")
    except (KeyError, ValueError):
        return dict(PLAY_MGR_TYPES)
    found = parse_play_mgr_reference(text)
    return found or dict(PLAY_MGR_TYPES)


@lru_cache(maxsize=1)
def _role_name_index() -> tuple[dict[str, str], tuple[tuple[str, str], ...]]:
    exact: dict[str, str] = {}
    listing: list[tuple[str, str]] = []
    for role_id, info in load_card_roles().items():
        e_name = info.get("eName", "")
        if not e_name or "?" in e_name:
            continue
        key = normalize_name(e_name)
        if not key:
            continue
        exact.setdefault(key, role_id)
        listing.append((key, role_id))
    return exact, tuple(listing)


def build_role_index() -> dict[str, str]:
    """normalised English name -> 5-digit role id (exact matches only)."""
    return dict(_role_name_index()[0])


def _match_role(key: str) -> str | None:
    exact, listing = _role_name_index()
    if key in exact:
        return exact[key]
    if len(key) < 5:
        return None
    for predicate in (
        lambda name: name.startswith(key),
        lambda name: name.endswith(key),
        lambda name: key.startswith(name) and len(name) >= 5,
        lambda name: len(key) >= 6 and key in name,
    ):
        hits = {role_id for name, role_id in listing if predicate(name)}
        if len(hits) == 1:
            return next(iter(hits))
    return None


def resolve_role_id(bank_stem: str) -> str | None:
    """Map an ACB bank filename to a `CfgCardRole` id.

    Bank filenames are abbreviated, reworded or suffixed versions of the role's
    English name (`Lokotun` vs `Lokotunjailurus`, `Morne` vs `Le Morne`,
    `Barbera` vs `Barbera·Red`, `Kunlun_unsterblich` vs `Kunlun`), so after an
    exact lookup we fall back to a *unique* start/end/contains match with a length
    guard.  Requiring uniqueness matters: a loose match that picks one of several
    roles would silently mislabel lines.
    """
    key = normalize_name(bank_stem)
    key = NAME_ALIASES.get(key, key)
    role_id = _match_role(key)
    if role_id:
        return role_id

    # Skin banks look like `<name>skin08`; retry the whole match on the base name.
    skin = re.match(r"^(.+?)skin\d+[a-z]?$", key)
    if skin:
        base = NAME_ALIASES.get(skin.group(1), skin.group(1))
        return _match_role(base)
    return None
