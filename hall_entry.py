"""Original entry rows, separate from clickable hotspots (which exclude in)."""
from functools import lru_cache
import json
import warnings
from asset_cache import DEFAULT_SOURCE, DEFAULT_CACHE
from lua_bundle import get_bundle
from spine_action import _text, parse_config_entries, audio_ids_of, ACTION_CONFIG, interlude_default_of, track_of


def recover_snapshot_entries(entries, snapshot, eligible):
    """Recover lost records only when the intact stream validates the snapshot.

    An unreadable Lua block can erase entire model IDs, not just damage a row.
    Never override live entries or resurrect entries from an intact table.
    """
    if not isinstance(snapshot, dict):
        return entries
    common = entries.keys() & snapshot.keys()
    if len(common) < 20 or any(entries[key] != snapshot[key] for key in common):
        return entries
    result = dict(entries)
    for key in eligible - entries.keys():
        row = snapshot.get(key)
        if not isinstance(row, dict) or not isinstance(row.get('baseIdle'), str) or not row['baseIdle']:
            continue
        if not isinstance(row.get('index'), int) or row['index'] < 1:
            continue
        if any(not isinstance(row.get(field), list)
               or any(type(value) is not int or value < 0 for value in row[field])
               for field in ('audio', 'clearTracks')):
            continue
        result[key] = row
    return result


@lru_cache(maxsize=1)
def _entry_rows(source=DEFAULT_SOURCE, cache=DEFAULT_CACHE):
    """Parse authored admission rules once, without opening every figure bundle."""
    bundle = get_bundle()
    role_display = json.loads((cache / 'spine_action.generated.json').read_text(encoding='utf8')).get('display', {})
    multi_path = cache / 'multi_picture_action.generated.json'
    multi_display = json.loads(multi_path.read_text(encoding='utf8')).get('archive', {}) if multi_path.is_file() else {}
    entries = {}
    packs = {}
    recoverable = set()
    # MenuMgr.CheckHadL2dIn uses the matching config table; RoleSpineItem2.SetImg
    # resolves CGs through RoleTool.GetMulImgPosScale, not the character display.
    # Keep the authored in-row gate even when an unconfigured skeleton has `in`.
    for config, display in ((ACTION_CONFIG, role_display), ('cfgCfgSpineMultiImageAction.lua', multi_display)):
        text = _text(bundle, config)
        models, damaged = parse_config_entries(text)
        if '--[[DAMAGED]]--' in text or damaged:
            # Restrict recovery to currently recognized figures in this table.
            recoverable.update(model for model, value in display.items()
                               if value.get('l2dName') and model not in models)
        for model, data in models.items():
            row = next((r for r in data.get('item', []) if isinstance(r, dict) and r.get('sName') == 'in'), None)
            if row:
                name = (display.get(model) or {}).get('l2dName')
                packs[model] = source / ('prefabs_spine_' + name.lower()) if name else None
                entries[model] = {'index': row.get('index', 0), 'audio': audio_ids_of(row.get('audioId')),
                                  'clearTracks': sorted({track_of(r) for r in data.get('item', [])
                                                       if isinstance(r, dict) and not (r.get('content') or {}).get('inIgnore')}),
                                  'baseIdle': None,
                                  'effect': row.get('effect'), 'content': row.get('content') or {}}
    return entries, packs, recoverable


@lru_cache(maxsize=512)
def entry_manifest(source=DEFAULT_SOURCE, cache=DEFAULT_CACHE, model_id=None):
    entries, packs, recoverable = _entry_rows(source, cache)
    if model_id is not None:
        # A missing record in a damaged block still needs the original full
        # compatibility check. Never guess a recovered admission rule.
        if model_id in recoverable:
            full = entry_manifest(source, cache)
            return {model_id: full[model_id]} if model_id in full else {}
        entries = {model_id: entries[model_id]} if model_id in entries else {}
    resolved = {}
    for model, row in entries.items():
        default = interlude_default_of(packs[model]) if packs[model] else None
        resolved[model] = {**row, 'baseIdle': default['animation'] if default else None}
    entries = resolved
    if model_id is not None:
        return entries
    snapshot_path = cache / 'hall_entry.generated.json'
    if recoverable and snapshot_path.is_file():
        try:
            snapshot = json.loads(snapshot_path.read_text(encoding='utf8'))
        except (OSError, ValueError):
            snapshot = None
        recovered = recover_snapshot_entries(entries, snapshot, recoverable)
        count = len(recovered) - len(entries)
        if count:
            warnings.warn(f'Hall entries: recovered {count} records lost to damaged Lua from compatible saved manifest')
        return recovered
    return entries
