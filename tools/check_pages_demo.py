"""Verify the ignored Pages demo pack resolves every published manifest file."""
import json
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
PUBLIC = ROOT / 'pages-pack/public'
API = PUBLIC / 'static-api'
ASSETS = PUBLIC / 'assets'
DIST = ROOT / 'dist-pages'


def read(name):
    return json.loads((API / (name + '.json')).read_text(encoding='utf-8'))


def check_model(asset, missing, folders, expected):
    folders.add(asset['folder'])
    for path in [asset['jsonPath'], asset['atlasPath'], *asset['texturePaths']]:
        expected.add(path)
        if not (ASSETS / path).is_file():
            missing.append(path)


def figure_key(name):
    return re.sub(r'spine$', '', re.sub(r'[^a-z0-9]', '', name.lower()))


def main():
    missing = []
    folders = set()
    expected_assets = set()
    manifest = read('manifest')
    assert len(manifest['entries']) == 10
    for entry in manifest['entries']:
        for variant in entry['variants']:
            check_model(variant['main'], missing, folders, expected_assets)
            for item in variant.get('effects', []):
                check_model(item['asset'], missing, folders, expected_assets)
        for portrait in entry.get('portraits', []):
            path = portrait['url'].removeprefix('/assets/')
            expected_assets.add(path)
            if not (ASSETS / path).is_file():
                missing.append(path)
    interactions = read('interactions')
    packs = {f'prefabs_spine_{folder}' for folder in folders}
    for model_id, display in interactions['display'].items():
        if not packs.intersection(display.get('packs', [])):
            continue
        for row in interactions['models'].get(model_id, []):
            host = row.get('dragHost') or {}
            for image in [host.get('image'), *(overlay.get('image') for overlay in host.get('overlays', []))]:
                if image and not (ASSETS / image).is_file():
                    missing.append(image)
                if image:
                    expected_assets.add(image)
    thumbs = read('thumbnails')
    for thumb in [*thumbs['entries'].values(), *thumbs['archiveEntries'].values()]:
        expected_assets.add(thumb['path'])
        if not (ASSETS / thumb['path']).is_file():
            missing.append(thumb['path'])
    voices = read('voices')
    for section in ('entries', 'variantEntries', 'auxiliaryEntries', 'pictureEntries'):
        for bank in voices[section].values():
            for stream in bank['streams']:
                path = f"voice/{bank['id']}/{stream['index']}.wav"
                expected_assets.add(path)
                if not (ASSETS / path).is_file():
                    missing.append(path)
    indexed_cues = {
        cue for section in ('entries', 'variantEntries', 'auxiliaryEntries')
        for bank in voices[section].values() for stream in bank['streams']
        for cue in [(stream.get('semantic') or {}).get('audioId'), stream.get('interactionAudioId'),
                    *(stream.get('interactionAudioIds') or [])] if cue is not None
    }
    for row in interactions['models']['3006003']:
        for cue in row.get('audio', []):
            if cue not in indexed_cues:
                missing.append(f'voice cue {cue} for Crestedplume skin 03')
    picture = read('multi-interactions')
    assert set(picture['archive']) == {'1', '78', '102', '117'}
    cg_entries = {entry['id']: entry for entry in manifest['entries'] if entry['category'] == 'cg'}
    for archive_id, archive in picture['archive'].items():
        image = f"archive/{archive['img']}.png"
        expected_assets.add(image)
        if not (ASSETS / image).is_file():
            missing.append(image)
        entry_id = archive['entryMatches'][0][0]
        entry = cg_entries[entry_id]
        available = {figure_key(asset['sourceName']) for variant in entry['variants']
                     for asset in [variant['main'], *(effect['asset'] for effect in variant.get('effects', []))]}
        pose = picture['poses'][archive_id]
        for name in [pose['initialSpine'], *(row['poseSwitch'][field]
                      for row in picture['models'][archive_id] if row.get('poseSwitch')
                      for field in ('targetSpine', 'interludeSpine'))]:
            if figure_key(name) not in available:
                missing.append(f'archive {archive_id} pose {name}')
        for bank_id in archive['pictureBankIds']:
            if bank_id not in voices['pictureEntries']:
                missing.append(f'picture voice bank {bank_id}')
        for row in picture['models'][archive_id]:
            for cue in row.get('audio', []):
                location = picture['audioLookup'].get(str(cue))
                bank = voices['pictureEntries'].get(location['bankId']) if location else None
                if not bank or not any(stream['index'] == location['streamIndex'] for stream in bank['streams']):
                    missing.append(f'archive {archive_id} voice cue {cue}')
    for album in read('asmr')['albums']:
        check_model(album['spine'], missing, folders, expected_assets)
        for suffix in ('', '-preview'):
            path = f"asmr/{album['voice']}{suffix}.wav"
            expected_assets.add(path)
            if not (ASSETS / path).is_file():
                missing.append(path)
    for folder in folders:
        for kind in ('spine-runtime', 'spine-layout'):
            if not (API / kind / (folder + '.json')).is_file():
                missing.append(f'{kind}/{folder}.json')
    expected_offline = set()
    for model in ('7003005', '7501003', '2008006', '7040003', '3018005'):
        expected_offline.update((f'ui/{model}.assets.json', f'ui/{model}.lua'))
        asset_list = json.loads((PUBLIC / 'offline/ui' / (model + '.assets.json')).read_text(encoding='utf-8'))
        if not (PUBLIC / 'offline/ui' / (model + '.lua')).is_file():
            missing.append(f'offline/ui/{model}.lua')
        for image in asset_list['images']:
            expected_offline.add(image.removeprefix('/offline/').lstrip('/'))
            if not (PUBLIC / image.lstrip('/')).is_file():
                missing.append(image)
        for name in asset_list['audio']:
            expected_offline.add(f'audio/{name}.wav')
            if not (PUBLIC / 'offline/audio' / (name + '.wav')).is_file():
                missing.append(f'offline/audio/{name}.wav')
    extra_offline = {path.relative_to(PUBLIC / 'offline').as_posix()
                     for path in (PUBLIC / 'offline').rglob('*') if path.is_file()} - expected_offline
    if extra_offline:
        missing.extend(f'unreferenced offline file: {path}' for path in sorted(extra_offline))
    for name in ('manifest', 'display-names', 'interactions', 'hall-entries', 'voices',
                 'thumbnails', 'multi-interactions', 'archive-images', 'asmr', 'spine-audit'):
        if not (API / (name + '.json')).is_file():
            missing.append('static-api/' + name + '.json')
    expected_assets.add(f"thumbnails/asmr-{read('asmr')['albums'][0]['voice']}.png")
    extra_assets = {path.relative_to(ASSETS).as_posix() for path in ASSETS.rglob('*')
                    if path.is_file()} - expected_assets
    if extra_assets:
        missing.extend(f'unreferenced asset: {path}' for path in sorted(extra_assets))
    assert not missing, '\n'.join(missing[:30])
    assert (DIST / 'index.html').is_file(), 'Build the static Pages bundle first'
    assert (DIST / 'static-api/manifest.json').is_file(), 'Vite did not copy static API files'
    for name in ('LICENSE', 'THIRD_PARTY_NOTICES.md', 'licenses/SPINE_RUNTIMES_LICENSE.txt'):
        assert (PUBLIC / name).is_file(), f'Missing Pages notice: {name}'
        assert (DIST / name).is_file(), f'Vite did not copy Pages notice: {name}'
    print(json.dumps({'entries': len(manifest['entries']), 'variants': sum(len(e['variants']) for e in manifest['entries']),
                      'spineFolders': len(folders), 'checked': True}))


if __name__ == '__main__':
    main()
