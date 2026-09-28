"""Shared runtime locations. Import before resource modules; never writes inputs."""
from __future__ import annotations

import json
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent


def load_paths(config_path: Path | None = None, environ=None) -> dict[str, Path]:
    env = os.environ if environ is None else environ
    explicit = config_path or env.get('CROSSCORE_CONFIG')
    config = Path(explicit).expanduser().resolve() if explicit else ROOT / 'viewer.local.json'
    values = {}
    if config.exists():
        values = json.loads(config.read_text(encoding='utf-8-sig'))
        if not isinstance(values, dict):
            raise ValueError(f'{config}: expected a JSON object')
    elif explicit:
        raise FileNotFoundError(f'Configuration not found: {config}')

    def path(key: str, fallback: Path) -> Path:
        raw = env.get(f'CROSSCORE_{key.upper()}', values.get(key))
        if raw is None:
            return fallback.resolve()
        if not isinstance(raw, str) or not raw.strip():
            raise ValueError(f'{config}: {key} must be a nonempty path string')
        result = Path(os.path.expandvars(raw)).expanduser()
        return (result if result.is_absolute() else config.parent / result).resolve()

    data = path('game_data', ROOT.parent / 'Daibloscore/client/DAIBLOSCORE_Data')
    source = path('source', data / 'GameHotRes/Custom')
    voice = path('voice_source', source.parent / 'sounds/cv')
    result = {
        'game_data': data, 'source': source,
        'lua_bundle': path('lua_bundle', source / 'luascripts'),
        'voice_source': voice,
        'chinese_source': path('chinese_source', voice.parent.parent / 'sounds_cn/cv'),
        'cache': path('cache', ROOT / 'cache'),
        'census': path('census', ROOT.parent / '.probe/census_full.json'),
        'xlua': path('xlua', data / 'Plugins/x86_64/xlua.dll'),
        'decoder': path('decoder', ROOT.parent / 'tools/vgmstream/vgmstream-cli.exe'),
    }
    unknown = set(values) - set(result)
    if unknown:
        raise ValueError(f'{config}: unknown keys: {", ".join(sorted(unknown))}')
    return result


PATHS = load_paths()
