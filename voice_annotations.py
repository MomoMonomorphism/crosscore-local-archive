"""Verify explicit original subtitles and usage-only bindings against fixed files."""
import hashlib
from pathlib import PurePosixPath
from lua_bundle import get_bundle
from tools.build_android_text import rows, sound_key

FIELD_LABELS = {'s_turn': '行动开始', 's_hit': '受击', 's_death': '战斗不能',
                's_overload': 'Overload', 's_mvp': '战斗胜利', 's_fail': '战斗失败',
                's_skipcast2': '技能跳过语音'}


def verified_annotations(registry, roots, lua_paths):
    result = {}; digests = {}; tables = {}; bundles = {}
    def digest(path):
        if path not in digests:
            with path.open('rb') as file:
                digests[path] = hashlib.file_digest(file, 'sha256').hexdigest()
        return digests[path]
    def table(platform, asset):
        key = (platform, asset)
        if key not in tables:
            tables[key] = rows(bundles[platform], asset)
        return tables[key]
    for entry in registry.get('entries', []):
        group, name = entry['sourceGroup'], entry['sourceFile']
        if group not in roots or PurePosixPath(name).name != name or '\\' in name:
            raise ValueError('Invalid annotation bank')
        path = roots[group] / name
        if not path.is_file() or digest(path) != entry['sourceSha256']:
            continue
        platform = entry['platform']
        lua = lua_paths[platform]
        if not lua.is_file() or digest(lua) != entry['luaSha256']:
            continue
        bundles.setdefault(platform, get_bundle(lua))
        identity = (group, name, entry['index'], entry['cue'])
        if identity in result:
            raise ValueError('Duplicate annotation identity')
        if entry['kind'] == 'original-text':
            key = 'cv/' + name.lower() + '|' + entry['cue'].lower()
            matches = [r for r in table(platform, 'cfgSound1.lua') if sound_key(r) == key]
            # This entry is deliberately distinct from dual-table recovery.
            if len(matches) != 1 or any(sound_key(r) == key or int(r['id']) == entry['audioId']
                                        for r in table(platform, 'cfgSound.lua')):
                continue
            row = matches[0]
            script = row.get('script1') or row.get('script2')
            if int(row['id']) != entry['audioId'] or not row.get('name') or not script:
                continue
            result[identity] = {'platform': platform, 'asset': 'cfgSound1.lua',
                                'label': row['name'], 'script': script, 'audioId': int(row['id']),
                                'annotationOnly': True, 'originalConfig': {
                                    'verification': 'exact-original-key', 'activeRecordPresent': False}}
        elif entry['kind'] == 'usage':
            labels = set(); proofs = []
            for proof in entry['proofs']:
                if proof['asset'] == 'cfgcharacter.lua':
                    matched = [r for r in table(platform, proof['asset']) if r['id'] == proof['modelId']]
                    if len(matched) != 1 or proof['field'] not in FIELD_LABELS:
                        raise ValueError('Unverified character usage')
                    if entry['cue'] not in matched[0].get(proof['field'], []):
                        raise ValueError('Cue not present in character usage')
                    labels.add(FIELD_LABELS[proof['field']])
                elif proof['asset'].startswith('FBD_'):
                    event = proof['event']
                    sheet = 'cv/' + name
                    if (event not in bundles[platform].read(proof['asset'])
                            or f'cue_sheet="{sheet}"' not in event
                            or f'cue_name="{entry["cue"]}"' not in event):
                        raise ValueError('Unverified effect usage')
                else:
                    raise ValueError('Unsupported usage source')
                proofs.append({'platform': platform, 'bundleSha256': entry['luaSha256'], **proof})
            if not proofs:
                raise ValueError('Usage requires source proof')
            result[identity] = {'usage': {'label': ' / '.join(sorted(labels)) if labels else '战斗技能语音',
                                          'category': 'battle', 'source': 'gameplayConfig',
                                          'provenance': proofs}}
        else:
            raise ValueError('Unsupported annotation kind')
    return result
