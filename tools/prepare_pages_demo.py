"""Build a local, ignored static demo pack; never publish game assets itself.

Includes interactive characters, linked CG/illustrations, and an ASMR excerpt.
Run this before a Vite build with VITE_STATIC_DEMO=1.
"""
import copy
import json
from pathlib import Path
import shutil
import sys
import wave

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from asset_cache import DEFAULT_CENSUS, load_catalog
from display_names import build_display_names
from hall_entry import entry_manifest
from portrait_cache import extract_portrait
from runtime_paths import PATHS
from spine_action import pos_space_of
from spine_runtime_settings import runtime_settings
from tools.prepare_offline_ui import main as prepare_ui
from voice_cache import decode_stream

CHARACTERS = ('character:crestedplume', 'character:machairodus',
              'character:poseidon', 'character:vodkamirror',
              'character:melody', 'character:lycorisradiata')
CG_BY_ARCHIVE = {
    '1': 'cg:cg02',
    '78': 'cg:cg0054_sandsofsummerheat',
    '102': 'cg:cg0077_changinginprivate_a',
    '117': 'cg:cg0085_twinstarattendantsa_spine',
}
# These are later poses of the same picture interaction, not separate gallery cards.
CG_POSE_ENTRIES = {
    'cg:cg0077_changinginprivate_a': ('cg:cg0077_changinginprivate_b',),
    'cg:cg0085_twinstarattendantsa_spine': ('cg:cg0085_twinstarattendantsb_spine',),
}
ARCHIVES = tuple(CG_BY_ARCHIVE)
ASMR_VOICE = 1006
PUBLIC = ROOT / 'pages-pack/public'
API = PUBLIC / 'static-api'
ASSETS = PUBLIC / 'assets'
CACHE = PATHS['cache']
SOURCE = PATHS['source']


def read(name):
    return json.loads((CACHE / f'{name}.generated.json').read_text(encoding='utf-8'))


def emit(name, value):
    target = API / (name + '.json')
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(value, ensure_ascii=False), encoding='utf-8')


def copy_asset(path, source=None):
    relative = Path(path)
    if relative.is_absolute() or '..' in relative.parts:
        raise ValueError(f'Unsafe demo asset path: {path}')
    origin = source or CACHE / relative
    if not origin.is_file():
        raise FileNotFoundError(origin)
    target = ASSETS / relative
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(origin, target)
    return target.stat().st_size


def copy_model(asset, folders):
    folders.add(asset['folder'])
    return sum(copy_asset(path) for path in
               [asset['jsonPath'], asset['atlasPath'], *asset['texturePaths']])


def selected_manifest():
    manifest = read('assets')
    source_entries = {entry['id']: entry for entry in manifest['entries']}
    included = set(CHARACTERS) | set(CG_BY_ARCHIVE.values())
    manifest['entries'] = [entry for entry in manifest['entries'] if entry['id'] in included]
    for primary, extras in CG_POSE_ENTRIES.items():
        for extra in extras:
            source_entries[primary]['variants'].extend(source_entries[extra]['variants'])
    variants = {variant['id'] for entry in manifest['entries'] for variant in entry['variants']}
    pose_parent = {extra: primary for primary, extras in CG_POSE_ENTRIES.items() for extra in extras}
    manifest['entryAliases'] = {key: pose_parent.get(value, value)
                                for key, value in manifest.get('entryAliases', {}).items()
                                if value in included or value in pose_parent}
    manifest['variantAliases'] = {key: value for key, value in manifest.get('variantAliases', {}).items() if value in variants}
    manifest['entryDefaultVariants'] = {key: value for key, value in manifest.get('entryDefaultVariants', {}).items() if value in variants}
    manifest['entryCount'] = len(manifest['entries'])
    manifest['characterCount'] = len(CHARACTERS)
    manifest['cgCount'] = len(CG_BY_ARCHIVE)
    manifest['variantCount'] = len(variants)
    return manifest, variants


def copy_portraits(manifest):
    for entry in manifest['entries']:
        for portrait in entry.get('portraits', []):
            name = portrait['image']
            source = extract_portrait(name, SOURCE, CACHE)
            copy_asset(f'portrait/{name}.png', source)


def trim_bank(bank):
    output = copy.deepcopy(bank)
    root = CACHE / 'voice' / bank['id']
    output['streams'] = [stream for stream in bank.get('streams', [])
                         if (root / f"{stream['index']}.wav").is_file()]
    output['streamCount'] = len(output['streams'])
    for stream in output['streams']:
        copy_asset(f"voice/{bank['id']}/{stream['index']}.wav", root / f"{stream['index']}.wav")
    return output


def complete_picture_bank(bank):
    for stream in bank.get('streams', []):
        decode_stream(bank, stream['index'])
    return trim_bank(bank)


def selected_model_ids(interactions, folders):
    packs = {f'prefabs_spine_{folder}' for folder in folders}
    return {model_id for model_id, display in interactions['display'].items()
            if packs.intersection(display.get('packs', []))}


def selected_interactions(interactions, model_ids):
    """The browser only reads these four fields; do not export other roles."""
    return {
        key: {model_id: value for model_id, value in interactions[key].items()
              if model_id in model_ids}
        for key in ('display', 'poses', 'models')
    } | {'interludeDefaults': {}}


def copy_interaction_images(interactions, model_ids):
    for model_id in model_ids:
        for row in interactions['models'].get(model_id, []):
            host = row.get('dragHost') or {}
            for image in [host.get('image'), *(overlay.get('image') for overlay in host.get('overlays', []))]:
                if image:
                    copy_asset(image)


def selected_voices(variant_ids, interactions, model_ids, picture_ids):
    source = read('voices')
    voices = {key: source[key] for key in ('availableBankCount', 'matchedBankCount',
              'voiceEntryCount', 'streamCount', 'semanticRoleCount', 'semanticEntryCount')}
    voices['entries'] = {key: trim_bank(bank) for key, bank in source['entries'].items() if key in CHARACTERS}
    voices['variantEntries'] = {key: trim_bank(bank) for key, bank in source['variantEntries'].items() if key in variant_ids}
    cues = {cue for model_id in model_ids for row in interactions['models'].get(model_id, [])
            for cue in row.get('audio', [])}
    voices['auxiliaryEntries'] = {
        key: trim_bank(bank) for key, bank in source.get('auxiliaryEntries', {}).items()
        if any(cue in cues for stream in bank.get('streams', [])
               for cue in [stream.get('interactionAudioId'), (stream.get('semantic') or {}).get('audioId'),
                           *(stream.get('interactionAudioIds') or [])] if cue is not None)
    }
    voices['chineseEntries'] = {}
    voices['chineseVariantEntries'] = {}
    voices['pictureEntries'] = {key: complete_picture_bank(bank)
                                for key, bank in source['pictureEntries'].items() if key in picture_ids}
    banks = [*voices['entries'].values(), *voices['variantEntries'].values(),
             *voices['auxiliaryEntries'].values(), *voices['pictureEntries'].values()]
    voices['availableBankCount'] = voices['matchedBankCount'] = len(banks)
    voices['voiceEntryCount'] = len(voices['entries']) + len(voices['variantEntries'])
    voices['streamCount'] = sum(bank['streamCount'] for bank in banks)
    voices['semanticRoleCount'] = len(voices['entries'])
    voices['semanticEntryCount'] = len(voices['entries']) + len(voices['variantEntries'])
    emit('voices', voices)
    return voices


def selected_display_names(manifest, voices):
    names = build_display_names(manifest, SOURCE / 'luascripts')
    names['entryNames'] = {key: value for key, value in names['entryNames'].items()
                           if key in {entry['id'] for entry in manifest['entries']}}
    role_ids = {str(role_id) for entry in manifest['entries'] for role_id in entry.get('characterIds', [])}
    role_ids.update(str(portrait['roleId']) for entry in manifest['entries']
                    for portrait in entry.get('portraits', []) if portrait.get('roleId'))
    role_ids.update(str(stream['semantic']['characterRoleId'])
                    for bank in voices['pictureEntries'].values()
                    for stream in bank['streams'] if (stream.get('semantic') or {}).get('characterRoleId'))
    names['roleNames'] = {key: value for key, value in names['roleNames'].items()
                          if key in role_ids}
    names['namedEntryCount'] = len(names['entryNames'])
    emit('display-names', names)


def selected_asmr(folders):
    data = read('asmr')
    album = copy.deepcopy(next(item for item in data['albums'] if item['voice'] == ASMR_VOICE))
    seconds = album['previewSeconds']
    album['seconds'] = seconds
    album['lines'] = [line for line in album['lines'] if line['time'] < seconds]
    album['lineCount'] = len(album['lines'])
    data['albums'] = [album]
    data['albumCount'] = 1
    data['lineCount'] = album['lineCount']
    data['totalSeconds'] = seconds
    emit('asmr', data)
    copy_model(album['spine'], folders)
    source = CACHE / 'asmr' / f'{ASMR_VOICE}.wav'
    for suffix in ('', '-preview'):
        target = ASSETS / 'asmr' / f'{ASMR_VOICE}{suffix}.wav'
        target.parent.mkdir(parents=True, exist_ok=True)
        with wave.open(str(source), 'rb') as reader, wave.open(str(target), 'wb') as writer:
            writer.setparams(reader.getparams())
            remaining = round(seconds * reader.getframerate())
            while remaining:
                count = min(remaining, reader.getframerate())
                frames = reader.readframes(count)
                if not frames:
                    break
                writer.writeframes(frames)
                remaining -= count
    copy_asset(f'thumbnails/asmr-{ASMR_VOICE}.png')


def main():
    prepare_ui()
    shutil.copytree(ROOT / 'web/public/offline', PUBLIC / 'offline', dirs_exist_ok=True)
    (PUBLIC / 'offline/ui/meta.json').unlink(missing_ok=True)
    shutil.copyfile(ROOT / 'LICENSE', PUBLIC / 'LICENSE')
    notices = (ROOT / 'THIRD_PARTY_NOTICES.md').read_text(encoding='utf-8')
    (PUBLIC / 'THIRD_PARTY_NOTICES.md').write_text(
        notices.replace('third_party/SPINE_RUNTIMES_LICENSE.txt',
                        'licenses/SPINE_RUNTIMES_LICENSE.txt'), encoding='utf-8')
    licenses = PUBLIC / 'licenses'
    licenses.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(ROOT / 'third_party/SPINE_RUNTIMES_LICENSE.txt',
                    licenses / 'SPINE_RUNTIMES_LICENSE.txt')
    manifest, variants = selected_manifest()
    folders = set()
    for entry in manifest['entries']:
        for variant in entry['variants']:
            copy_model(variant['main'], folders)
            for effect in variant.get('effects', []):
                copy_model(effect['asset'], folders)
    copy_portraits(manifest)
    emit('manifest', manifest)
    interactions = read('spine_action')
    model_ids = selected_model_ids(interactions, folders)
    copy_interaction_images(interactions, model_ids)
    emit('interactions', selected_interactions(interactions, model_ids))
    emit('hall-entries', {key: value for key, value in entry_manifest(SOURCE, CACHE).items()
                          if key in model_ids})
    picture = read('multi_picture_action')
    archive_ids = {int(archive_id) for archive_id in ARCHIVES}
    picture_ids = {bank_id for archive_id in ARCHIVES
                   for bank_id in picture['archive'][archive_id]['pictureBankIds']}
    voices = selected_voices(variants, interactions, model_ids, picture_ids)
    selected_display_names(manifest, voices)

    thumbs = read('thumbnails')
    thumbs['entries'] = {key: value for key, value in thumbs['entries'].items()
                         if key in set(CHARACTERS) | set(CG_BY_ARCHIVE.values())}
    thumbs['archiveEntries'] = {key: value for key, value in thumbs['archiveEntries'].items()
                                if key in ARCHIVES}
    thumbs['entryCount'] = len(thumbs['entries'])
    thumbs['archiveEntryCount'] = 1
    for thumb in [*thumbs['entries'].values(), *thumbs['archiveEntries'].values()]:
        copy_asset(thumb['path'])
    emit('thumbnails', thumbs)

    picture['archive'] = {key: value for key, value in picture['archive'].items() if key in ARCHIVES}
    picture['groups'] = [{**group, 'boardIds': [board_id for board_id in group['boardIds']
                                              if board_id in archive_ids]} for group in picture['groups']
                         if archive_ids.intersection(group['boardIds'])]
    picture['pictureLinks'] = {key: value for key, value in picture['pictureLinks'].items()
                               if value.get('archiveId') in archive_ids}
    picture['staticModels'] = {key: value for key, value in picture['staticModels'].items()
                               if key in ARCHIVES}
    picture = {key: picture[key] for key in ('summary', 'groups', 'archive', 'pictureLinks',
               'staticModels', 'interludeDefaults', 'poses', 'models', 'audioLookup')}
    for key in ('poses', 'models'):
        picture[key] = {model_id: value for model_id, value in picture[key].items()
                        if model_id in ARCHIVES}
    picture['entryByModel'] = {}
    picture['variantByModel'] = {}
    picture['unresolvedPictures'] = []
    picture['corrections'] = []
    cues = {cue for archive_id in ARCHIVES for row in picture['models'][archive_id]
            for cue in [*(row.get('audio') or []), *(row.get('audioId') or [])]}
    cues.update(cue for rows in picture['staticModels'].values() for row in rows
                for cue in (row.get('audioId') or []))
    picture['audioLookup'] = {key: value for key, value in picture['audioLookup'].items()
                              if int(key) in cues}
    picture['interludeDefaults'] = {key: value for key, value in picture['interludeDefaults'].items()
                                    if key in {row['poseSwitch'][field] for archive_id in ARCHIVES
                                               for row in picture['models'][archive_id] if row.get('poseSwitch')
                                               for field in ('targetSpine', 'interludeSpine')}}
    emit('multi-interactions', picture)
    archive_images = {picture['archive'][archive_id]['img'] for archive_id in ARCHIVES}
    emit('archive-images', {'names': sorted(archive_images)})
    for name in sorted(archive_images):
        copy_asset(f'archive/{name}.png')
    selected_asmr(folders)

    catalog = {item['folder']: item['package'] for item in load_catalog(DEFAULT_CENSUS)}
    for folder in sorted(folders):
        package = catalog[folder]
        emit(f'spine-runtime/{folder}', runtime_settings(package, SOURCE, CACHE))
        emit(f'spine-layout/{folder}', {'folder': folder, 'space': pos_space_of(SOURCE / package)})
    asset_bytes = sum(path.stat().st_size for path in ASSETS.rglob('*') if path.is_file())
    emit('cache-status', {'packages': len(folders), 'bytes': asset_bytes})
    emit('spine-audit', {'manifestRevision': manifest['revision'], 'results': {}})
    report = {'entries': manifest['entryCount'], 'variants': manifest['variantCount'],
              'spineFolders': len(folders), 'assetBytes': asset_bytes,
              'staticApiFiles': sum(1 for _ in API.rglob('*.json'))}
    print(json.dumps(report, ensure_ascii=False))


if __name__ == '__main__':
    main()
