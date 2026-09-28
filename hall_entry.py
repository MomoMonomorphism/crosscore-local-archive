"""Original entry rows, separate from clickable hotspots (which exclude in)."""
from functools import lru_cache
import json
from asset_cache import DEFAULT_SOURCE, DEFAULT_CACHE
from lua_bundle import get_bundle
from spine_action import _text, parse_config_entries, audio_ids_of, ACTION_CONFIG, interlude_default_of, track_of


@lru_cache(maxsize=1)
def entry_manifest(source=DEFAULT_SOURCE, cache=DEFAULT_CACHE):
    bundle = get_bundle()
    role_display = json.loads((cache / 'spine_action.generated.json').read_text(encoding='utf8')).get('display', {})
    multi_path = cache / 'multi_picture_action.generated.json'
    multi_display = json.loads(multi_path.read_text(encoding='utf8')).get('archive', {}) if multi_path.is_file() else {}
    entries = {}
    # MenuMgr.CheckHadL2dIn uses the matching config table; RoleSpineItem2.SetImg
    # resolves CGs through RoleTool.GetMulImgPosScale, not the character display.
    # Keep the authored in-row gate even when an unconfigured skeleton has `in`.
    for config, display in ((ACTION_CONFIG, role_display), ('cfgCfgSpineMultiImageAction.lua', multi_display)):
        models, _ = parse_config_entries(_text(bundle, config))
        for model, data in models.items():
            row = next((r for r in data.get('item', []) if isinstance(r, dict) and r.get('sName') == 'in'), None)
            if row:
                name = (display.get(model) or {}).get('l2dName')
                default = interlude_default_of(source / ('prefabs_spine_' + name.lower())) if name else None
                entries[model] = {'index': row.get('index', 0), 'audio': audio_ids_of(row.get('audioId')),
                                  'clearTracks': sorted({track_of(r) for r in data.get('item', [])
                                                       if isinstance(r, dict) and not (r.get('content') or {}).get('inIgnore')}),
                                  'baseIdle': default['animation'] if default else None,
                                  'effect': row.get('effect'), 'content': row.get('content') or {}}
    return entries
