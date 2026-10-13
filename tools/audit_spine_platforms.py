"""Read-only fixed PC/Android character bundle audit; bounded, resumable evidence."""
import argparse
from collections import Counter
import gc
import hashlib
import json
import math
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import UnityPy
from asset_cache import unwrap_bundle, text_bytes, _is_skeleton
from runtime_paths import PATHS
from spine_action import pos_space_of
from spine_runtime_settings import settings_from_environment

VERSION = 1
ANDROID = ROOT.parent / 'resource-baselines/android-cn-3.3.0-20261001-d92fccc3/resources/Custom'
OUTPUT = ROOT / '.scratch/spine-platform-audit.json'


class UnresolvedBundle(ValueError):
    """Original resource is absent from this bundle or has ambiguous names."""


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=True).encode()).hexdigest()


def file_hash(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def normalize_names(result):
    # Match the established extract_package naming contract, while rejecting
    # collisions instead of guessing which identically named model is intended.
    for field in ['models', 'atlases', 'textures', 'materials', 'profiles']:
        normalized = {name.strip(): value for name, value in result[field].items()}
        if len(normalized) != len(result[field]):
            raise UnresolvedBundle('Ambiguous normalized resource names: ' + field)
        result[field] = normalized
    def finite_json(value):
        if isinstance(value, float) and not math.isfinite(value):
            # Unity's default particle _CameraFadeParams contains +Infinity.
            # This is diagnostic material data, not modified game JSON.
            return {'nonfinite': str(value)}
        if isinstance(value, dict):
            return {k: finite_json(v) for k, v in value.items()}
        if isinstance(value, list):
            return [finite_json(v) for v in value]
        return value
    result['materials'] = finite_json(result['materials'])
    return result


def inspect(path):
    env = UnityPy.load(unwrap_bundle(path)[2])
    models, atlases, textures, materials, graphics = {}, {}, {}, {}, []
    for obj in env.objects:
        if obj.type.name == 'TextAsset':
            asset = obj.read()
            raw = text_bytes(asset)
            if asset.m_Name.lower().endswith('.atlas'):
                atlases[asset.m_Name] = hashlib.sha256(raw).hexdigest()
            elif _is_skeleton(raw):
                data = json.loads(raw)
                if asset.m_Name in models:
                    raise UnresolvedBundle('Duplicate skeleton name: ' + asset.m_Name)
                models[asset.m_Name] = {
                    'header': data.get('skeleton', {}),
                    'sections': {k: digest(v) for k, v in data.items() if k not in ('skeleton', 'animations')},
                    'animations': {k: digest(v) for k, v in data.get('animations', {}).items()},
                    'entrance': 'in' in data.get('animations', {}),
                }
        elif obj.type.name == 'Texture2D':
            asset = obj.read()
            textures[asset.m_Name] = {'width': asset.m_Width, 'height': asset.m_Height,
                                     'format': asset.m_TextureFormat}
        elif obj.type.name == 'Material':
            tree = obj.read_typetree()
            ref = tree['m_Shader']
            if ref.get('m_FileID'):
                shader = {'external': ref.get('m_FileID')}
            else:
                shader = obj.assets_file.objects[ref['m_PathID']].read_typetree()['m_ParsedForm']['m_Name']
            properties = tree.get('m_SavedProperties', {})
            materials[tree['m_Name']] = {'shader': shader,
                'floats': dict(properties.get('m_Floats', [])),
                'colors': dict(properties.get('m_Colors', [])),
                'keywords': tree.get('m_ShaderKeywords'),
                'validKeywords': sorted(tree.get('m_ValidKeywords', []))}
        elif obj.type.name == 'MonoBehaviour':
            try:
                tree = obj.read_typetree()
            except Exception as error:
                raise ValueError(f'Unreadable MonoBehaviour {obj.path_id}: {error}') from error
            if 'startingAnimation' in tree:
                graphics.append({k: tree.get(k) for k in
                    ['startingAnimation', 'startingLoop', 'meshGenerator', 'allowMultipleCanvasRenderers']})
    native = settings_from_environment(env)
    if not models or not atlases:
        raise UnresolvedBundle('No original Spine skeleton/atlas; original bundle cannot replace this browser asset')
    profiles = {name: {k: v for k, v in profile.items() if k != 'sources'}
                for name, profile in native['models'].items()}
    result = {'models': models, 'atlases': atlases, 'textures': textures,
              'materials': materials, 'graphics': sorted(graphics, key=digest),
              'profiles': profiles, 'warnings': native['warnings'], 'layout': pos_space_of(path)}
    del env
    return normalize_names(result)


def compare(pc, android):
    reasons, changes = [], []
    if set(pc['models']) != set(android['models']):
        reasons.append('skeleton-names')
    for name in sorted(set(pc['models']) & set(android['models'])):
        a, b = pc['models'][name], android['models'][name]
        sections = [k for k in sorted(set(a['sections']) | set(b['sections']))
                    if a['sections'].get(k) != b['sections'].get(k)]
        actions = [k for k in sorted(set(a['animations']) | set(b['animations']))
                   if a['animations'].get(k) != b['animations'].get(k)]
        if sections or actions:
            reasons.append('skeleton-data')
            changes.append({'model': name, 'sections': sections, 'actions': actions,
                            'entranceChanged': 'in' in actions})
        if not all(m['header'].get('spine', '').startswith('4.2.') for m in (a, b)):
            reasons.append('runtime-version')
        if any(a['header'].get(k) != b['header'].get(k)
               for k in set(a['header']) | set(b['header']) if k not in ('spine', 'hash', 'images', 'audio')):
            reasons.append('declared-bounds')
    for key in ['atlases', 'profiles', 'layout', 'materials', 'graphics']:
        if pc[key] != android[key]:
            reasons.append(key)
    if pc['warnings'] or android['warnings']:
        reasons.append('native-profile-warnings')
    if set(pc['textures']) != set(android['textures']):
        reasons.append('texture-names')
    lower_resolution = [name for name in set(pc['textures']) & set(android['textures'])
        if android['textures'][name]['width'] < pc['textures'][name]['width']
        or android['textures'][name]['height'] < pc['textures'][name]['height']]
    return {'status': 'review' if reasons else 'compatible-lower-resolution' if lower_resolution else 'compatible',
            'reasons': sorted(set(reasons)), 'modelsChanged': changes,
            'lowerResolutionTextures': sorted(lower_resolution),
            'textureChanges': {name: {'pc': pc['textures'][name], 'android': android['textures'][name]}
                for name in sorted(set(pc['textures']) & set(android['textures']))
                if pc['textures'][name] != android['textures'][name]}}


def inventory():
    manifest = json.loads((PATHS['cache'] / 'assets.generated.json').read_text('utf8'))
    refs = {}
    characters = [e for e in manifest['entries'] if e['category'] == 'character']
    for entry in characters:
        for variant in entry['variants']:
            for kind, asset in [('main', variant['main']),
                                *[('effect', fx['asset']) for fx in variant.get('effects', [])]]:
                package = 'prefabs_spine_' + asset['folder']
                refs.setdefault(package, []).append({'entry': entry['id'], 'variant': variant['id'],
                    'kind': kind, 'sourceName': asset['sourceName']})
    # Include the interlude/auxiliary bundles actually referenced by character poses.
    actions = json.loads((PATHS['cache'] / 'spine_action.generated.json').read_text('utf8'))
    for model, family in actions['poses'].items():
        for role, pose in family.get('poses', {}).items():
            for package in pose.get('packs', []):
                refs.setdefault(package, []).append({'model': model, 'role': role, 'kind': 'pose'})
    return refs, {'characters': len(characters), 'variants': sum(len(e['variants']) for e in characters)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=OUTPUT)
    parser.add_argument('--fresh', action='store_true')
    args = parser.parse_args()
    refs, totals = inventory()
    prior = {}
    if not args.fresh and args.output.exists():
        prior = json.loads(args.output.read_text('utf8'))
    reusable = prior.get('version') == VERSION and prior.get('sources') == {
        'pc': str(PATHS['source']), 'android': str(ANDROID)}
    rows = {}
    result = {'version': VERSION, 'sources': {'pc': str(PATHS['source']), 'android': str(ANDROID)},
              'scope': 'Original character main/effect and pose bundles; no native/WebGL pixel acceptance',
              'inventory': totals, 'packages': rows}
    for index, (package, references) in enumerate(sorted(refs.items()), 1):
        pc_path, android_path = PATHS['source'] / package, ANDROID / package
        if not pc_path.is_file() or not android_path.is_file():
            row = {'status': 'missing-pc' if not pc_path.is_file() else 'missing-android'}
        else:
            pc_sha, android_sha = file_hash(pc_path), file_hash(android_path)
            old = prior.get('packages', {}).get(package, {}) if reusable else {}
            if old.get('pcSha256') == pc_sha and old.get('androidSha256') == android_sha and old['status'] not in ('error', 'unresolved'):
                row = {k: v for k, v in old.items() if k != 'references'}
                if 'pc' in row and 'android' in row:
                    row['pc'] = normalize_names(row['pc'])
                    row['android'] = normalize_names(row['android'])
                    row.update(compare(row['pc'], row['android']))
            else:
                try:
                    pc, android = inspect(pc_path), inspect(android_path)
                    row = {**compare(pc, android), 'pc': pc, 'android': android}
                except Exception as error:
                    row = {'status': 'unresolved' if isinstance(error, UnresolvedBundle) else 'error',
                           'error': f'{type(error).__name__}: {error}'}
                row.update(pcSha256=pc_sha, androidSha256=android_sha)
                gc.collect()
        row['references'] = references
        rows[package] = row
        if index % 10 == 0 or index == len(refs):
            result['summary'] = dict(Counter(row['status'] for row in rows.values()))
            args.output.parent.mkdir(parents=True, exist_ok=True)
            temporary = args.output.with_suffix('.tmp')
            temporary.write_text(json.dumps(result, ensure_ascii=False, indent=2, allow_nan=False), 'utf8')
            temporary.replace(args.output)
            print(f'{index}/{len(refs)} {json.dumps(result["summary"])}', flush=True)


if __name__ == '__main__':
    main()
