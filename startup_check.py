"""Read-only startup diagnosis; never regenerates or deletes accepted caches."""
from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import importlib.util
import json
import platform
import struct
import sys
from pathlib import Path

from runtime_paths import ROOT, PATHS

MANIFESTS = {
    'assets.generated.json': 'generate_manifest.py',
    'voices.generated.json': 'voice_cache.py (also produces ASMR)',
    'asmr.generated.json': 'voice_cache.py full generation',
    'spine_action.generated.json': 'spine_action.py (preserve previous input)',
    'multi_picture_action.generated.json': 'multi_picture_action.py (after assets/voices)',
    'thumbnails.generated.json': 'thumbnail_cache.py (after multi-picture)',
}
REQUIRED_FIELDS = {
    'assets.generated.json': {'entries': list},
    'voices.generated.json': {'entries': dict, 'pictureEntries': dict},
    'asmr.generated.json': {'albums': list},
    'spine_action.generated.json': {'models': dict, 'poses': dict},
    'multi_picture_action.generated.json': {'archive': dict, 'models': dict},
    'thumbnails.generated.json': {'entries': dict, 'archiveEntries': dict},
}


def inspect(paths=None, root=ROOT):
    paths = PATHS if paths is None else paths
    checks = []

    def add(name, ok, detail, optional=False):
        checks.append({'name': name, 'status': 'ok' if ok else 'warning' if optional else 'error', 'detail': str(detail)})

    add('platform', sys.platform == 'win32' and struct.calcsize('P') == 8,
        f'{platform.system()} / Python {platform.python_version()} / {struct.calcsize("P") * 8}-bit; native games need Windows x64')
    for module, package in [('UnityPy', 'UnityPy'), ('PIL', 'Pillow'), ('lz4', 'lz4'), ('brotli', 'brotli'), ('texture2ddecoder', 'texture2ddecoder')]:
        found = importlib.util.find_spec(module) is not None
        try:
            version = importlib.metadata.version(package)
        except importlib.metadata.PackageNotFoundError:
            version = 'missing'
        add(package, found, f'{version}; install with: "{sys.executable}" -m pip install -r requirements.txt')
    for key in ('source', 'voice_source', 'cache', 'lua_bundle', 'xlua', 'decoder', 'census'):
        target = paths[key]
        ok = target.is_dir() if key in ('source', 'voice_source', 'cache') else target.is_file()
        add(key, ok, target)
    try:
        from spine_source import REFERENCES, ROOT as reference_root, resolve_spine_source, DEFAULT_SOURCE
        active = 0
        if paths['source'].resolve() == DEFAULT_SOURCE.resolve():
            for package, reference in REFERENCES.items():
                if reference.get('baseSource') and (reference_root / reference['baseSource']).resolve() != paths['source'].resolve():
                    continue
                resolve_spine_source(package, paths['source'])
                active += 1
        add('pinned Spine references', True, f'{active} active verified original Android bundles')
    except (OSError, ValueError, KeyError, TypeError) as error:
        add('pinned Spine references', False, error)
    binding = paths['cache'] / 'resource-baseline.json'
    if binding.is_file():
        try:
            frozen = json.loads(binding.read_text(encoding='utf8'))
            mismatches = [key for key, value in frozen['runtimePaths'].items()
                          if key not in paths or Path(value).resolve() != paths[key].resolve()]
            if mismatches:
                raise ValueError('Cache belongs to different resource paths: ' + ', '.join(mismatches))
            for item in frozen['checks']:
                with Path(item['path']).open('rb') as stream:
                    actual = hashlib.file_digest(stream, 'sha256').hexdigest()
                if actual != item['sha256']:
                    raise ValueError('Baseline fingerprint changed: ' + item['path'])
            add('resource baseline', True, frozen['label'])
        except (OSError, ValueError, KeyError, TypeError) as error:
            add('resource baseline', False, error)
    for label, target in [('Chinese voices', paths['chinese_source']), ('UI effects', paths['voice_source'].parent / 'temp/temp.acb'),
                          ('Rhythm music', paths['voice_source'].parent / 'bgms/LycorisRadiata_Music_01.acb')]:
        add(label, target.exists(), target, optional=label == 'Chinese voices')
    try:
        census = json.loads(paths['census'].read_text(encoding='utf-8-sig'))
        if not isinstance(census, list) or not census or not all(isinstance(row, dict) and 'pkg' in row for row in census):
            raise ValueError('expected nonempty package records')
        add('census JSON', True, f'{len(census)} package records')
    except (OSError, ValueError) as error:
        add('census JSON', False, error)
    for filename, generator in MANIFESTS.items():
        target = paths['cache'] / filename
        try:
            value = json.loads(target.read_text(encoding='utf-8-sig'))
            if not isinstance(value, dict):
                raise ValueError('expected object')
            for field, expected in REQUIRED_FIELDS[filename].items():
                if not isinstance(value.get(field), expected):
                    raise ValueError(f'{field}: expected {expected.__name__}')
            add(filename, True, f'{target} ({target.stat().st_size} bytes)')
            if value.get('retainedPriorActionIds'):
                add('historical interaction input', False, f'Keep this manifest; retained IDs: {value["retainedPriorActionIds"]}', True)
            if value.get('reusedPreviousSemanticCount'):
                add('historical voice input', False, f'Keep this manifest; reused semantic count: {value["reusedPreviousSemanticCount"]}', True)
            if filename == 'voices.generated.json':
                identity = value.get('semanticIndexSource', {})
                with paths['lua_bundle'].open('rb') as stream:
                    lua_sha = hashlib.file_digest(stream, 'sha256').hexdigest()
                current = identity.get('luaSha256') == lua_sha
                text_path = paths['cache'] / 'android_text_zh_cn.generated.json'
                if identity.get('androidTextSha256'):
                    current = current and text_path.is_file()
                    if text_path.is_file():
                        with text_path.open('rb') as stream:
                            current = current and hashlib.file_digest(stream, 'sha256').hexdigest() == identity['androidTextSha256']
                alias_path = root / 'voice_bank_aliases.json'
                if identity.get('bankAliasesSha256'):
                    current = current and alias_path.is_file()
                    if alias_path.is_file():
                        with alias_path.open('rb') as stream:
                            current = current and hashlib.file_digest(stream, 'sha256').hexdigest() == identity['bankAliasesSha256']
                annotation_path = root / 'voice_annotations.json'
                if identity.get('annotationsSha256'):
                    current = current and annotation_path.is_file()
                    if annotation_path.is_file():
                        with annotation_path.open('rb') as stream:
                            current = current and hashlib.file_digest(stream, 'sha256').hexdigest() == identity['annotationsSha256']
                        registry = json.loads(annotation_path.read_text('utf8'))
                        for source in registry.get('luaSources', {}).values():
                            lua_path = (root / source['path']).resolve()
                            current = current and lua_path.is_file()
                            if lua_path.is_file():
                                with lua_path.open('rb') as stream:
                                    current = current and hashlib.file_digest(stream, 'sha256').hexdigest() == source['sha256']
                add('voice semantic index freshness', current,
                    'source fingerprints match' if current else 'Source fingerprint missing or changed; run tools/refresh_voice_index.py in isolation before --apply', True)
        except (OSError, ValueError) as error:
            add(filename, False, f'{target}: {error}; restore baseline or prepare isolated generation with {generator}; see docs/RUNBOOK.md')
    index = root / 'dist/index.html'
    add('frontend', index.is_file(), f'{index}; build with start_viewer.ps1 -Build')
    if index.is_file():
        inputs = [*(root / 'web/src').rglob('*'), root / 'web/package-lock.json', root / 'web/vite.config.ts']
        stale = [str(p.relative_to(root)) for p in inputs if p.is_file() and p.stat().st_mtime > index.stat().st_mtime + 1]
        add('frontend freshness', not stale, 'up to date' if not stale else 'Run -Build; newer sources: ' + ', '.join(stale[:5]), optional=True)
    modules = root / 'web/node_modules'
    add('frontend dependencies', modules.is_dir(), modules, optional=True)
    if modules.is_dir() and modules.resolve() != modules.absolute():
        add('linked node_modules', False, f'{modules} -> {modules.resolve()}; new machines need npm ci', optional=True)
    return {'ok': not any(c['status'] == 'error' for c in checks), 'workspace': str(root.resolve()),
            'python': sys.executable, 'paths': {k: str(v) for k, v in paths.items()}, 'checks': checks}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--json', action='store_true')
    args = parser.parse_args()
    report = inspect()
    if args.json:
        print(json.dumps(report, ensure_ascii=False, indent=2))
    else:
        for check in report['checks']:
            print(f'[{check["status"].upper()}] {check["name"]}: {check["detail"]}')
    sys.exit(0 if report['ok'] else 1)
