"""Lazy, versioned prefab animation-state contract. No texture re-extraction."""
from __future__ import annotations

import json
import math
import threading
import uuid
from pathlib import Path

import UnityPy
from asset_cache import unwrap_bundle, validate_package

VERSION = 2
_lock = threading.Lock()


def settings_from_environment(env) -> dict:
    # Follow local PPtrs; never associate a data asset by a similar filename.
    readers = list(env.objects)
    objects = {o.path_id: o for o in readers}
    models: dict[str, list[dict]] = {}
    warnings = []

    def local(ref, owner):
        if not ref or ref.get('m_FileID') != 0:
            raise ValueError('external or missing PPtr')
        # Local path IDs are scoped to the owner's serialized file.
        file = getattr(owner, 'assets_file', None)
        return (file.objects if file is not None else objects)[ref['m_PathID']]

    for obj in readers:
        if obj.type.name != 'MonoBehaviour':
            continue
        try:
            graphic = obj.read_typetree()
        except Exception:
            continue
        if 'startingAnimation' not in graphic or 'skeletonDataAsset' not in graphic:
            continue
        try:
            data_obj = local(graphic['skeletonDataAsset'], obj)
            data = data_obj.read_typetree()
            text_obj = local(data['skeletonJSON'], data_obj)
            name = text_obj.read().m_Name
            default = float(data['defaultMix'])
            if not math.isfinite(default) or default < 0:
                raise ValueError('invalid defaultMix')
            sources, targets, durations = (data.get(k, []) for k in ('fromAnimation', 'toAnimation', 'duration'))
            if not len(sources) == len(targets) == len(durations):
                raise ValueError('mix arrays have different lengths')
            mixes = []
            for source, target, duration in zip(sources, targets, durations):
                if not source or not target:  # SkeletonDataAsset.FillStateData skips empty names.
                    continue
                duration = float(duration)
                if not math.isfinite(duration) or duration < 0:
                    raise ValueError('invalid named mix duration')
                mixes.append({'from': source, 'to': target, 'duration': duration})
            profile = {'defaultMix': default, 'mixes': mixes,
                       'startingAnimation': graphic['startingAnimation'],
                       'startingLoop': bool(graphic['startingLoop'])}
            models.setdefault(name, []).append({'profile': profile, 'graphicPathId': str(obj.path_id),
                'dataAssetPathId': str(data_obj.path_id), 'skeletonPathId': str(text_obj.path_id)})
        except (KeyError, ValueError, TypeError) as error:
            warnings.append(f'graphic {obj.path_id}: {error}')
    result = {}
    for name, candidates in models.items():
        first = candidates[0]['profile']
        if any(item['profile'] != first for item in candidates):
            warnings.append(f'{name}: conflicting component profiles; not guessed')
            continue
        result[name] = {**first, 'sources': [{k: v for k, v in item.items() if k != 'profile'} for item in candidates]}
    return {'models': result, 'warnings': warnings}


def runtime_settings(package: str, source_root: Path, cache_root: Path) -> dict:
    package = validate_package(package)
    source = source_root / package
    stat = source.stat()
    identity = {'size': stat.st_size, 'mtimeNs': stat.st_mtime_ns}
    target = cache_root / 'spine-runtime' / f'{package}.json'
    with _lock:
        if target.is_file():
            try:
                cached = json.loads(target.read_text('utf8'))
                if cached.get('version') == VERSION and cached.get('sourceIdentity') == identity:
                    return cached
            except (OSError, ValueError):
                pass
        env = UnityPy.load(unwrap_bundle(source)[2])
        result = {'version': VERSION, 'package': package, 'sourceIdentity': identity,
                  **settings_from_environment(env)}
        target.parent.mkdir(parents=True, exist_ok=True)
        temporary = target.with_name(target.name + f'.{uuid.uuid4().hex}.tmp')
        temporary.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf8')
        temporary.replace(target)
        return result
