"""Reverse-engineer how the client maps a *touch position* to a spine animation.

Findings (see `INTERACTION.md` for the full write-up):

* The card/role figure is driven by `CardLive2DItem.lua`.  It reads
  `cfg = Cfgs.CfgSpineAction:GetByID(modelId)` and, in `SetTouch()`, spawns one
  `Common/CardTouchItem` per `cfg.item[k]` that has `areas ~= nil`.
* Each such item carries `areas = {{x, y, w, h, rotation_deg}, ...}` — a rotated
  rectangle in the displayed spine's local space — plus `sName` (the animation to
  play), `audioId` (voice cues) and `content` (behaviour: `clicks`, `actions`,
  `changeIdle`, `activation`, `noClick`, `nextClick`, `changerole`, `asmr`, ...).
* `CardTouchItem.Refresh` consumes only `areas[1]` and feeds it straight into a
  RectTransform: anchor = (x, y), size = (w, h), z-rotation = rot.  The item is
  parented to the spine container, so the rects live in that container's local
  space, *not* in screen pixels.
* The spine that is displayed is `cfg.l2dName` (from `cfgcharacter.lua`) — the
  *figure* build (animations `click1..clickN`, `idle*`, `in`).  The `_asmr_spine`
  build of the same character carries only `camera` + `idle`; it is the album
  overlay, not the clickable figure.  Conflating the two is what makes the
  clicks look "mismatched".
* A figure may be split across sibling pose packs (trailing `a`/`b`/`c`) whose
  animation sets only *union* to the full click range.
* Which spine track an animation lands on comes from `GetTrackIndex`: every
  `sType < 6` (character body) is track 1; props/effects (`sType >= 6`) get their
  own track, either `content.trackIndex` or the entry's own `index`.
* 8 of those entries carry `content.asmr = {id, jumpShop}` — that is how the
  ASMR album is launched from the figure.  `CfgASMR[id].model` names the
  `CfgSpineAction` key, and the two agree in both directions.

Output (default `cache/spine_action.generated.json`) is a single artifact holding
every half of the join, so the viewer never has to re-parse Lua at runtime.

    python spine_action.py [--out cache/spine_action.generated.json] [--no-figures]
"""

from __future__ import annotations

import argparse
import collections
import copy
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from lua_bundle import get_bundle  # noqa: E402
from luatable import LuaParseError, parse_config, config_record_entries  # noqa: E402

from runtime_paths import PATHS
DEFAULT_OUT = PATHS['cache'] / "spine_action.generated.json"
ACTION_CONFIG = "cfgCfgSpineAction.lua"
ASMR_CONFIG = "cfgCfgASMR.lua"
CHARACTER_CONFIG = "cfgcharacter.lua"

# `SpineTools.lua` — decides whether the touch item is a click or a drag target,
# and (with `GetTrackIndex`) which spine track it animates.
SPINE_ACTION_TYPES = {
    1: "In",           # 入场
    2: "RoleClick",    # 角色点击      {activation, randomActions, isHide}
    3: "RoleActions",  # 角色顺序多动作 {actions}
    4: "RoleGesture",  # 角色手势      {gestureDatas}
    5: "RoleDrag",     # 角色物品拖放   {drag}
    6: "ElseClick",    # 非角色点击
    7: "ElseMulClick", # 非角色多段点击 {clicks}
    8: "ElseActions",  # 非角色顺序多动作
    9: "ElseGesture",  # 非角色手势
    10: "ElseDrag",    # 非角色物品拖放
}

# `60210_skin_Longxian03a` -> head `60210_skin_Longxian`, pose `03`, variant `a`.
POSE_RE = re.compile(r"^(?P<head>.+?)(?P<pose>\d{2})(?P<variant>[a-z])?(?:_spine)?$")


def _text(bundle, name: str) -> str:
    """Read an asset, falling back to block-by-block reads when it is spliced."""
    try:
        return bundle.read(name)
    except (ValueError, KeyError):
        segments = bundle.read_segments(name)
        chunks = []
        previous = None
        for block, segment in segments:
            if previous is not None and block != previous + 1:
                chunks.append('\n--[[DAMAGED]]--\n')
            chunks.append(segment)
            previous = block
        return ''.join(chunks)


def parse_config_entries(text: str, wanted: set[int] | None = None) -> tuple[dict[str, dict], list[int]]:
    """keyed id -> entry, plus the ids whose entry could not be decoded.

    Parsed entry-by-entry so that one splice in the shipped stream costs a single
    entry instead of the whole table.  `wanted` limits the parse to the ids of
    interest, which keeps the 1 MB `cfgcharacter.lua` cheap.
    """
    models: dict[str, dict] = {}
    damaged: list[int] = []
    marks = config_record_entries(text)
    for index, (entry_id, start) in enumerate(marks):
        if wanted is not None and entry_id not in wanted:
            continue
        end = marks[index + 1][1] if index + 1 < len(marks) else len(text)
        body = text[start:end].rstrip().rstrip(",")
        if '--[[DAMAGED]]--' in body:
            damaged.append(entry_id)
            continue
        try:
            wrapped = parse_config("{" + body + "}")
        except LuaParseError:
            damaged.append(entry_id)
            continue
        entry = wrapped.get(entry_id)
        if not isinstance(entry, dict):
            damaged.append(entry_id)
            continue
        models[str(entry_id)] = entry
    return models, damaged


def track_of(touch: dict) -> object:
    """Mirror of `CardLive2DItem.GetTrackIndex`.

        if (cfgChild.sType < 6) then return 1 end
        if (cfgChild.content and cfgChild.content.trackIndex) then return ... end
        return cfgChild.index

    i.e. the character body always animates on track 1; props and effects get a
    track of their own so they can run alongside it.
    """
    s_type = touch.get("sType")
    if isinstance(s_type, int) and s_type < 6:
        return 1
    content = touch.get("content") or {}
    if isinstance(content, dict) and content.get("trackIndex") is not None:
        return content["trackIndex"]
    return touch.get("index")


def real_index_of(touch: dict) -> object:
    """Mirror ``RoleSpineItem2.GetRealIndex``.

    Multi-click progress is keyed by ``content.trackIndex`` when present and by
    the row index otherwise.  This is deliberately separate from ``track_of``:
    body animations always play on track 1, but their progress record can still
    use the configured row index.
    """
    content = touch.get("content") or {}
    if isinstance(content, dict) and content.get("trackIndex") is not None:
        return content["trackIndex"]
    return touch.get("index")


def touch_kind(touch: dict) -> str:
    """Return the input/behaviour family selected by the shipped Lua."""
    content = touch.get("content") or {}
    gesture = touch.get("gesture") or 0
    if content.get("asmr"):
        return "asmr"
    if gesture:
        if content.get("drag") or touch.get("sType") in (5, 10):
            return "drag"
        return "gesture"
    if content.get("changerole"):
        return "pose-switch"
    if content.get("clicks"):
        return "multi-click"
    if content.get("actions"):
        return "actions"
    if content.get("randomActions"):
        return "random-action"
    if content.get("orderActions"):
        return "ordered-action"
    return "click"


def normalized_swap(touch: dict) -> dict | None:
    """Name the positional ``changerole`` tuple used by ``RoleSpineItem2``."""
    content = touch.get("content") or {}
    raw = content.get("changerole")
    if not isinstance(raw, list) or len(raw) < 3:
        return None
    source_role = touch.get("role") or 1
    target_role = raw[5] if len(raw) > 5 and raw[5] not in (None, "") else 3 - source_role
    return {
        "targetSpine": raw[0],
        "interludeSpine": raw[1],
        "durationMs": raw[2],
        "afterIndex": raw[3] if len(raw) > 3 and raw[3] not in (None, "") else None,
        "inheritProgress": raw[4] if len(raw) > 4 and raw[4] not in (None, "") else None,
        "targetRole": target_role,
    }


def normalized_content(value: object) -> dict:
    """Restore list shape for fields RoleSpineItem2 always iterates.

    The Lua literal parser unwraps a one-item positional table to a scalar.
    That is harmless for most config values, but these fields are consumed
    with ``pairs`` and are therefore lists even when they contain one index.
    """
    content = dict(value) if isinstance(value, dict) else {}
    for key in ("noClick", "needClicks", "reset7"):
        if key in content and not isinstance(content[key], list):
            content[key] = [content[key]]
    return content


def pose_contracts(touches: dict[str, list[dict]], display: dict[str, dict], source: Path) -> dict[str, dict]:
    """Build the role -> figure contract the browser needs for real pose swaps."""
    result: dict[str, dict] = {}
    for mid, rows in touches.items():
        initial = (display.get(mid) or {}).get("l2dName")
        poses: dict[str, dict] = {}
        if initial:
            poses["1"] = {"role": 1, "l2dName": initial}
        for row in rows:
            role = row.get("role") or 1
            poses.setdefault(str(role), {"role": role, "l2dName": initial if role == 1 else None})
            swap = row.get("poseSwitch")
            if swap:
                target_role = int(swap["targetRole"])
                poses.setdefault(str(target_role), {"role": target_role, "l2dName": None})
                poses[str(target_role)]["l2dName"] = swap["targetSpine"]
        for key, pose in poses.items():
            pose["touchIndexes"] = [
                row["index"] for row in rows if (row.get("role") or 1) == int(key)
            ]
            l2d = pose.get("l2dName")
            pose["packs"] = figure_packs(source, l2d) if l2d else []
            pose["animations"] = []
        result[mid] = {
            "initialRole": 1,
            "initialSpine": initial,
            "poses": poses,
            "switchIndexes": [row["index"] for row in rows if row.get("poseSwitch")],
        }
    return result


def audio_ids_of(value: object) -> list[int]:
    """Flatten a Lua audioId array, including explicitly numbered sparse slots."""
    if isinstance(value, list):
        return [item for item in value if isinstance(item, int)]
    if isinstance(value, dict):
        head = audio_ids_of(value.get("__array"))
        tail = [item for key, item in sorted(
            ((key, item) for key, item in value.items() if isinstance(key, int)),
            key=lambda pair: pair[0],
        ) if isinstance(item, int)]
        return head + tail
    return []


def touches_of(entry: dict) -> list[dict]:
    """Action registry in index order, including non-pointer callback actions.

    RoleSpineItem2.SetTouch requires areas, but PlayByIndex reads cfg.item
    directly. Keep those internal rows with empty rects and hittable=False.
    The `in` row belongs to the separate hall-entry lifecycle.
    """
    out = []
    for item in entry.get("item") or []:
        if not isinstance(item, dict):
            continue
        if item.get("sName") == "in":
            continue
        rects = [r for r in (item.get("areas") or []) if isinstance(r, list) and len(r) >= 5]
        gesture = item.get("gesture") or 0
        s_type = item.get("sType")
        record = {
            "index": item.get("index"),
            "anim": item.get("sName"),
            "sType": s_type,
            "sTypeName": SPINE_ACTION_TYPES.get(s_type) if isinstance(s_type, int) else None,
            "gesture": item.get("gesture"),
            # `click_clickNode.enabled = gesture == 0`, else the drag handler runs
            "isDrag": gesture != 0,
            "rects": rects,
            "audio": audio_ids_of(item.get("audioId")),
            "content": normalized_content(item.get("content")),
            "role": item.get("role"),
        }
        record["track"] = track_of(record)
        record["realIndex"] = real_index_of(record)
        record["kind"] = touch_kind(record)
        record["pose"] = item.get("role") or 1
        record["poseSwitch"] = normalized_swap(record)
        record["activation"] = (record["content"] or {}).get("activation")
        record["initialActive"] = item.get("role", 1) == 1 and "isHide" not in (record["content"] or {})
        if item.get("areas") is None:
            record["touchObject"] = False
            record["initialActive"] = False
        record["hittable"] = any(rect[2] > 0 and rect[3] > 0 for rect in rects)
        audio = record["audio"] or []
        sequential = any((record["content"] or {}).get(key) for key in (
            "actions", "clicks", "randomActions", "orderActions"
        ))
        record["audioMode"] = "sequence" if len(audio) > 1 and sequential else "random"
        out.append(record)
    out.sort(key=lambda t: (t["index"] is None, t["index"]))
    return out


def prior_rows_compatible(current: list[dict], previous: list[dict]) -> bool:
    """Allow newly recovered internal actions, never silently accept changed old rows."""
    now_by_id = {row['index']: row for row in current}
    old_by_id = {row['index']: row for row in previous}
    if len(now_by_id) != len(current) or len(old_by_id) != len(previous):
        return False
    if not old_by_id.keys() <= now_by_id.keys():
        return False
    fields = ('index', 'anim', 'content', 'role', 'poseSwitch', 'track')
    for index, old in old_by_id.items():
        now = now_by_id[index]
        if any(now.get(f) != old.get(f) for f in fields) or (now.get('audio') or []) != (old.get('audio') or []):
            return False
    return all(now_by_id[index].get('touchObject') is False
               for index in now_by_id.keys() - old_by_id.keys())


def family_prefix(l2d: str) -> str:
    """`60210_skin_Longxian03a` -> `60210_skin_longxian03` (lowercased)."""
    m = POSE_RE.match(l2d)
    if not m:
        return l2d.lower()
    return (m["head"] + m["pose"]).lower()


def figure_packs(source: Path, l2d: str) -> list[str]:
    """Sibling pose packs of one figure, excluding the ASMR album build.

    A figure can be split over trailing `a`/`b`/`c` packs; the click range is the
    union of their animation sets, so the viewer must know all of them.
    """
    prefix = "prefabs_spine_" + family_prefix(l2d)
    out = []
    try:
        # Bundles are files, not folders: `prefabs_spine_3006_skin_crestedplume03_spine`
        # is a ~10 MB blob sitting directly in GameHotRes/Custom.
        entries = sorted(p.name for p in source.iterdir() if p.is_file())
    except OSError:
        return out
    for name in entries:
        low = name.lower()
        if not low.startswith(prefix) or "asmr" in low:
            continue
        out.append(name)
    return out


def pos_space_of(pack: Path, memo: dict | None = None) -> dict | None:
    """Serialized prefab transform from the root touch space to the skeleton.

    The lobby's touch rectangles (`CfgSpineAction.areas`) are authored in the
    coordinate space of this container, NOT in raw skeleton units: CSpine
    renders the skeleton inside `pos/main` (scale + offset vary per pack), and the
    designer places hotspots next to the rendered figure.  Evidence:

    - Alps04 `pos` = scale 0.45, offset (17.6, -892.5); mapping the shoe drag
      rect through it lands on the `footR` slot (dist 77), the unmapped rect
      misses the whole figure (nearest slot 2224).
    - CrestedPlume `pos` = scale 0.34; rect-cluster span / skeleton span =
      0.346 / 0.330 — matching the serialized scale.

    Returns the `pos` and `main` transforms or None when the bundle has no
    `pos` node. The `main` child is nontrivial on Alps04-06 and Anthem05.
    """
    if memo is not None and pack.name in memo:
        return memo[pack.name]
    try:
        import UnityPy
        import asset_cache

        _raw, _offset, bundle_bytes = asset_cache.unwrap_bundle(pack)
        env = UnityPy.load(bundle_bytes)
    except Exception:
        return None
    result = None
    game_objects: dict[int, dict] = {}
    rect_trees: dict[int, dict] = {}
    for obj in env.objects:
        try:
            if obj.type.name == "GameObject":
                data = obj.read_typetree()
                game_objects[obj.path_id] = data
            elif obj.type.name == "RectTransform":
                rect_trees[obj.path_id] = obj.read_typetree()
        except Exception:
            continue
    for rt_pid, rt in rect_trees.items():
        go = game_objects.get(rt.get("m_GameObject", {}).get("m_PathID"), {})
        if (go.get("m_Name") or "") != "pos":
            continue
        main = next((child for child in rect_trees.values()
                     if child.get("m_Father", {}).get("m_PathID") == rt_pid
                     and game_objects.get(child.get("m_GameObject", {}).get("m_PathID"), {}).get("m_Name") == "main"), None)
        result = {
            "scale": float(rt["m_LocalScale"]["x"]),
            "offsetX": float(rt["m_AnchoredPosition"]["x"]),
            "offsetY": float(rt["m_AnchoredPosition"]["y"]),
            "mainScale": float(main["m_LocalScale"]["x"]) if main else 1.0,
            "mainOffsetX": float(main["m_AnchoredPosition"]["x"]) if main else 0.0,
            "mainOffsetY": float(main["m_AnchoredPosition"]["y"]) if main else 0.0,
        }
        break
    if memo is not None:
        memo[pack.name] = result
    return result


def pose_space_of(source: Path, pose: dict, memo: dict | None = None) -> dict | None:
    """Use the prefab of the displayed pose, not the first sibling pack.

    A family can include an interlude and several figures with different
    serialized `pos` scales. Their animation sets are shared for discovery,
    but their touch rectangles belong to the currently displayed figure.
    """
    l2d = pose.get("l2dName") or ""
    exact = "prefabs_spine_" + l2d.lower()
    packs = pose.get("packs") or []
    ordered = ([exact] if exact in packs else []) + [name for name in packs if name != exact]
    return next((space for name in ordered if (space := pos_space_of(source / name, memo))), None)


def interlude_default_of(pack: Path) -> dict | None:
    """Read the prefab's serialized CSpine starting animation and loop flag."""
    try:
        import UnityPy
        import asset_cache

        env = UnityPy.load(asset_cache.unwrap_bundle(pack)[2])
        for obj in env.objects:
            if obj.type.name != "MonoBehaviour":
                continue
            try:
                data = obj.read_typetree()
            except Exception:
                continue
            if data.get("startingAnimation"):
                return {
                    "animation": str(data["startingAnimation"]),
                    "loop": bool(data.get("startingLoop")),
                }
    except Exception:
        pass
    return None


def remap_rects(rows: list[dict], space: dict | None) -> list[dict]:
    """Map touch rects from prefab root space into raw skeleton (JSON) space.

    The skeleton is nested under `pos/main`, so both transforms must be
    inverted. The y flip is real: Spine's rendered local Y points down while
    Unity UI's anchored Y points up. Sizes divide by the combined scale; the
    rotation angle changes sign under the y flip.
    """
    if not space or not space.get("scale"):
        return rows
    k = float(space["scale"])
    ox = float(space.get("offsetX") or 0.0)
    oy = float(space.get("offsetY") or 0.0)
    main_scale = float(space.get("mainScale") or 1.0)
    main_x = float(space.get("mainOffsetX") or 0.0)
    main_y = float(space.get("mainOffsetY") or 0.0)
    full_scale = k * main_scale
    for row in rows:
        mapped = []
        for rect in row["rects"]:
            cx, cy, w, h, deg = rect[0], rect[1], rect[2], rect[3], rect[4]
            mapped.append([
                (cx - ox - k * main_x) / full_scale,
                (oy - cy + k * main_y) / full_scale,
                w / full_scale,
                h / full_scale,
                (-deg) % 360.0,
            ])
        row["rects"] = mapped
        row["hittable"] = any(rect[2] > 0 and rect[3] > 0 for rect in mapped)
    return rows


def unmap_rects(rows: list[dict], space: dict | None) -> list[dict]:
    """Restore source `areas` coordinates from a previous generated manifest."""
    if not space or not space.get("scale"):
        return rows
    k = float(space["scale"])
    ox = float(space.get("offsetX") or 0.0)
    oy = float(space.get("offsetY") or 0.0)
    main_scale = float(space.get("mainScale") or 1.0)
    main_x = float(space.get("mainOffsetX") or 0.0)
    main_y = float(space.get("mainOffsetY") or 0.0)
    full_scale = k * main_scale
    for row in rows:
        row["rects"] = [
            [cx * full_scale + ox + k * main_x,
             oy + k * main_y - cy * full_scale,
             w * full_scale, h * full_scale, (-deg) % 360.0]
            for cx, cy, w, h, deg in row["rects"]
        ]
    return rows


def spine_anims(pack: Path) -> list[str]:
    """Animation names found in every skeleton TextAsset inside one bundle."""
    try:
        import UnityPy
    except ImportError:  # pragma: no cover - optional dependency
        return []
    import asset_cache

    try:
        _raw, _offset, bundle_bytes = asset_cache.unwrap_bundle(pack)
        env = UnityPy.load(bundle_bytes)
    except Exception:
        return []
    names: list[str] = []
    for obj in env.objects:
        if obj.type.name != "TextAsset":
            continue
        try:
            data = obj.read()
        except Exception:
            continue
        raw = getattr(data, "m_Script", None)
        if raw is None:
            continue
        text = raw if isinstance(raw, str) else bytes(raw).decode("utf-8", "replace")
        if not text.lstrip().startswith("{"):
            continue
        try:
            parsed = json.loads(text)
        except Exception:
            continue
        for anim in (parsed.get("animations") or {}):
            if anim not in names:
                names.append(anim)
    return names


def build(
    bundle,
    source: Path | None = None,
    figures_for: set[str] | None = None,
    scan_figures: bool = True,
    previous: dict | None = None,
) -> dict:
    action_text = _text(bundle, ACTION_CONFIG)
    models, damaged = parse_config_entries(action_text)
    source_ids = [str(mid) for mid, _ in config_record_entries(action_text)]
    if len(set(source_ids)) != len(source_ids):
        raise ValueError('duplicate source interaction record IDs')
    unaccounted = set(source_ids) - set(models) - {str(mid) for mid in damaged}
    if unaccounted:
        raise ValueError(f'unaccounted interaction records: {sorted(unaccounted)}')
    asmr_raw = parse_config(_text(bundle, ASMR_CONFIG))
    albums = asmr_raw if isinstance(asmr_raw, list) else list(asmr_raw.values())

    # CfgASMR[id].model is the bridge from an album to its touch table.
    album_of_model = {str(a["model"]): a["id"] for a in albums}
    touches = {mid: touches_of(entry) for mid, entry in models.items()}
    touches = {mid: t for mid, t in touches.items() if t}

    # ---- display layer: which spine is shown, and where its hotspots live ----
    # Covers both the touchable models and every album's model, because the
    # viewer must be able to draw a figure even when no touch can open it.
    if source is None:
        import asset_cache

        source = asset_cache.DEFAULT_SOURCE
    displayed_ids = {int(mid) for mid in touches} | set(damaged) | {int(a["model"]) for a in albums}
    char_text = _text(bundle, CHARACTER_CONFIG)
    display, display_damaged = parse_config_entries(char_text, wanted=displayed_ids)
    # A damaged dialogue string must not conceal intact display references.
    # Read only bounded scalar/flat fields; never recover action semantics this way.
    from config_records import records
    partial_display = records(char_text, ['id', 'l2dName', 'img', 'l2dPos', 'imgPos'])
    recovered_display = []
    for mid in display_damaged:
        row = partial_display.get(str(mid), {})
        if row.get('l2dName') and figure_packs(source, row['l2dName']):
            display[str(mid)] = row
            recovered_display.append(mid)

    retained_models: list[int] = []
    retained_display: list[int] = []
    if previous:
        # A stale manifest is useful only when every surviving source row still
        # agrees on its action semantics and displayed figure identity.
        old_models = previous.get("models") or {}
        old_display = previous.get("display") or {}
        common = set(touches) & set(old_models)
        compatible = len(common) >= 20 and all(
            prior_rows_compatible(touches[mid], old_models[mid]) for mid in common
        )
        compatible = compatible and all(
            all(now.get(field) == old_display[mid].get(field)
                for field in ("l2dName", "img", "l2dPos", "imgPos"))
            for mid, now in display.items() if mid in old_display
        )
        if compatible:
            for mid in damaged:
                old_rows = old_models.get(str(mid))
                if not old_rows:
                    continue
                touches[str(mid)] = copy.deepcopy(old_rows)
                for role, pose in (previous.get("poses", {}).get(str(mid), {}).get("poses", {})).items():
                    role_rows = [row for row in touches[str(mid)] if row["pose"] == int(role)]
                    unmap_rects(role_rows, pose.get("touchSpace"))
                retained_models.append(mid)
            for mid in displayed_ids:
                old = old_display.get(str(mid))
                if str(mid) not in display and old:
                    display[str(mid)] = old
                    retained_display.append(mid)

    # Which albums can actually be reached by touching the figure.
    reachable = sorted({
        t["content"]["asmr"]["id"]
        for rows in touches.values() for t in rows
        if (t["content"] or {}).get("asmr")
    })

    poses = pose_contracts(touches, display, source)

    # Touch rects are authored in each pack's `pos` container space; remap them
    # into raw skeleton units so the browser only deals with one space.
    pos_memo: dict = {}
    for mid, rows in touches.items():
        contract = poses[mid]
        for role_key, pose in contract["poses"].items():
            space = pose_space_of(source, pose, pos_memo)
            contract["poses"][role_key]["touchSpace"] = space
            role_rows = [row for row in rows if (row.get("role") or 1) == int(role_key)]
            remap_rects(role_rows, space)

    interlude_defaults: dict[str, dict] = {}
    for name in sorted({
        row["poseSwitch"]["interludeSpine"]
        for rows in touches.values()
        for row in rows
        if row.get("poseSwitch") and row["poseSwitch"].get("interludeSpine")
    }):
        pack = source / ("prefabs_spine_" + name.lower())
        default = interlude_default_of(pack)
        if default:
            interlude_defaults[name] = default

    # The runtime needs every pose, not only the seven album figures.  The old
    # research prototype scanned the album subset for speed, which was enough to
    # prove the ASMR/figure distinction but not enough to drive the whole lobby.
    if figures_for is None and scan_figures:
        figures_for = {
            pose["l2dName"]
            for model in poses.values()
            for pose in model["poses"].values()
            if pose.get("l2dName")
        }
        # Two ASMR albums do not have a CfgSpineAction entry.  They still need
        # their display figure metadata, so the complete runtime set is the
        # union of interaction poses and all album display figures.
        figures_for.update(
            display[str(a["model"])]["l2dName"]
            for a in albums
            if display.get(str(a["model"]), {}).get("l2dName")
        )

    figure_section: dict[str, dict] = {}
    for l2d in sorted(figures_for or ()):
        packs = figure_packs(source, l2d)
        detail = []
        union: list[str] = []
        for name in packs:
            anims = spine_anims(source / name)
            detail.append({"pack": name, "anims": anims})
            for anim in anims:
                if anim not in union:
                    union.append(anim)
        figure_section[l2d] = {"packs": detail, "animationUnion": union}

    for model in poses.values():
        for pose in model["poses"].values():
            figure = figure_section.get(pose.get("l2dName"))
            if figure:
                pose["animations"] = figure["animationUnion"]

    stats = collections.Counter()
    anims: collections.Counter[str] = collections.Counter()
    gestures: collections.Counter[str] = collections.Counter()
    s_types: collections.Counter[str] = collections.Counter()
    tracks: collections.Counter[str] = collections.Counter()
    content_keys: collections.Counter[str] = collections.Counter()
    kinds: collections.Counter[str] = collections.Counter()
    rects = 0
    diagnostics: list[dict] = [
        {"kind": "damaged-action-config", "modelId": mid}
        for mid in damaged
    ] + [
        {"kind": "damaged-character-config", "modelId": mid}
        for mid in display_damaged
    ]
    for mid, group in touches.items():
        for t in group:
            if t["anim"]:
                anims[t["anim"]] += 1
            gestures[str(t["gesture"])] += 1
            s_types[str(t["sTypeName"])] += 1
            tracks[str(t["track"])] += 1
            kinds[t["kind"]] += 1
            rects += len(t["rects"])
            for key in t["content"] or {}:
                content_keys[key] += 1
            stats["withAudio"] += 1 if t["audio"] else 0
            stats["withContent"] += 1 if t["content"] else 0
            stats["dragTargets"] += 1 if t["isDrag"] else 0
            if not t["hittable"]:
                diagnostics.append({"kind": "internal-action" if t.get("touchObject") is False else "zero-sized-hotspot", "modelId": mid, "index": t["index"]})
            raw_swap = (t["content"] or {}).get("changerole")
            if raw_swap and not t["poseSwitch"]:
                diagnostics.append({"kind": "malformed-pose-switch", "modelId": mid, "index": t["index"]})

    for mid, contract in poses.items():
        if not contract.get("initialSpine"):
            diagnostics.append({"kind": "missing-display-spine", "modelId": mid})
        for role, pose in contract["poses"].items():
            if not pose.get("l2dName"):
                diagnostics.append({"kind": "missing-pose-spine", "modelId": mid, "role": int(role)})

    return {
        "source": ACTION_CONFIG,
        "characterSource": CHARACTER_CONFIG,
        "entryCount": len(config_record_entries(action_text)),
        "parsedCount": len(models),
        "sourceCoverage": {
            "recordIds": source_ids,
            "parsedIds": sorted(models),
            "failedIds": damaged,
            "unaccountedIds": sorted(unaccounted),
        },
        "damagedIds": damaged,
        "displayDamagedIds": display_damaged,
        "recoveredPartialDisplayIds": recovered_display,
        "retainedPriorActionIds": sorted(retained_models),
        "retainedPriorDisplayIds": sorted(retained_display),
        "touchModelCount": len(touches),
        "touchCount": sum(len(g) for g in touches.values()),
        "rectCount": rects,
        "withAudio": stats["withAudio"],
        "withContent": stats["withContent"],
        "dragTargets": stats["dragTargets"],
        "distinctAnims": len(anims),
        "animHistogram": dict(anims.most_common(40)),
        "gestureHistogram": dict(gestures.most_common()),
        "sTypeHistogram": dict(s_types.most_common()),
        "trackHistogram": dict(tracks.most_common()),
        "kindHistogram": dict(kinds.most_common()),
        "contentKeys": dict(content_keys.most_common()),
        "sTypeNames": SPINE_ACTION_TYPES,
        "diagnostics": diagnostics,
        # how the viewer must place the hotspots and which spine it must load
        "display": {
            mid: {
                "l2dName": (display.get(mid) or {}).get("l2dName"),
                "img": (display.get(mid) or {}).get("img"),
                "l2dPos": (display.get(mid) or {}).get("l2dPos"),
                "imgPos": (display.get(mid) or {}).get("imgPos"),
                "packs": figure_packs(source, (display.get(mid) or {}).get("l2dName") or "")
                if (display.get(mid) or {}).get("l2dName")
                else [],
            }
            for mid in sorted(display)
        },
        "figures": figure_section,
        "albums": [
            {
                "id": a["id"],
                "model": a["model"],
                "l2d": a["l2d"],
                "e_anim": a["e_anim"],
                "voice": a["voice"],
                "name": a["name"],
                "cvName": a["cvName"],
                # present only when a touch on the figure can open this album
                "modelTouches": len(touches.get(str(a["model"]), [])),
                "reachableFromFigure": a["id"] in reachable,
            }
            for a in sorted(albums, key=lambda a: a["id"])
        ],
        "albumOfModel": album_of_model,
        "poses": poses,
        "interludeDefaults": interlude_defaults,
        "models": touches,
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(DEFAULT_OUT))
    ap.add_argument("--no-figures", action="store_true",
                    help="skip the expensive per-pack animation scan")
    ap.add_argument("--figures-all", action="store_true",
                    help="deprecated compatibility flag; the default already scans all runtime figures")
    ap.add_argument("--previous", type=Path,
                    help="previous generated manifest for intact rows lost to a damaged Lua block")
    a = ap.parse_args()

    import asset_cache

    bundle = get_bundle()

    previous_path = a.previous or Path(a.out)
    previous = json.loads(previous_path.read_text(encoding="utf-8")) if previous_path.is_file() else None
    payload = build(
        bundle,
        asset_cache.DEFAULT_SOURCE,
        figures_for=None,
        scan_figures=not a.no_figures,
        previous=previous,
    )
    from drag_host import enrich_drag_hosts
    enrich_drag_hosts(payload, asset_cache.DEFAULT_SOURCE, Path(a.out).parent)
    out = Path(a.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")

    print(f"CfgSpineAction: 条目 {payload['parsedCount']}/{payload['entryCount']}"
          f"（损坏 {len(payload['damagedIds'])}: {payload['damagedIds']}）")
    print(f"有触点的 modelId {payload['touchModelCount']}，触点 {payload['touchCount']} 条，"
          f"旋转矩形 {payload['rectCount']} 个")
    print(f"带语音 {payload['withAudio']} / 带 content {payload['withContent']}"
          f" / 拖拽类 {payload['dragTargets']}；动画名 {payload['distinctAnims']} 种")
    print(f"sType 分布 : {payload['sTypeHistogram']}")
    print(f"轨道分布   : {payload['trackHistogram']}")
    print(f"content 子键: {payload['contentKeys']}")
    print("CfgASMR 专辑:")
    for alb in payload["albums"]:
        mark = "★ 可从立绘触发" if alb["reachableFromFigure"] else "  仅列表/商店进入"
        d = payload["display"].get(str(alb["model"])) or {}
        print(f"   {alb['id']}  model={alb['model']}  触点 {alb['modelTouches']:2d} 条  "
              f"l2d={d.get('l2dName')}  {mark}")
    print(f"已扫描立绘包 {len(payload['figures'])} 个 l2dName")
    print(f"-> {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
