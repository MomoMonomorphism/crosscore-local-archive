"""Fill missing voice text or proven usage; preserve playback identity."""
from collections import Counter
from copy import deepcopy
import hashlib
from pathlib import PurePosixPath
import re
from voice_semantics import cue_of, fold_label, semantic_category

GROUPS = ('entries', 'variantEntries', 'auxiliaryEntries', 'chineseEntries',
          'chineseVariantEntries', 'pictureEntries')


def cue_sheet(bank):
    prefix = {'cv': 'cv/', 'cv_cn': 'cv/', 'cv_skin': 'cv/cv_skin/',
              'picture': 'picture/'}.get(bank.get('sourceGroup', 'cv'))
    return prefix + bank['sourceFile'].lower() if prefix else None


def unique_banks(manifest, groups=GROUPS):
    banks = {}
    for group in groups:
        for bank in manifest.get(group, {}).values():
            banks.setdefault(bank['id'], bank)
    return list(banks.values())


def verified_sound_aliases(sound, source_root, aliases, android=None):
    """Only registered bank pairs with matching original hashes may share labels.

    Registration is supported by exact decoded PCM equality for every listed
    cue. No filename normalization or search across unrelated banks is used.
    """
    result = dict(sound)
    active = []
    for alias in aliases:
        canonical_group = alias.get('canonicalGroup', alias['sourceGroup'])
        if alias['sourceGroup'] not in ('cv', 'cv_skin', 'picture') or canonical_group not in ('cv', 'cv_skin', 'picture'):
            raise ValueError('Unsupported bank alias group')
        from voice_cache import VOICE_SOURCE_SUBDIRS
        directories = [source_root.joinpath(*VOICE_SOURCE_SUBDIRS[group])
                       for group in (alias['sourceGroup'], canonical_group)]
        names = (alias['sourceFile'], alias['canonicalFile'])
        if any(PurePosixPath(name).name != name or '\\' in name for name in names):
            raise ValueError('Invalid bank alias filename')
        files = [directory / name for directory, name in zip(directories, names)]
        if not all(path.is_file() for path in files):
            continue
        digests = []
        for path in files:
            with path.open('rb') as file:
                digests.append(hashlib.file_digest(file, 'sha256').hexdigest())
        if digests != [alias['sourceSha256'], alias['canonicalSha256']]:
            continue
        prefixes = {'cv': 'cv/', 'cv_skin': 'cv/cv_skin/', 'picture': 'picture/'}
        source_sheet = prefixes[alias['sourceGroup']] + names[0].lower()
        canonical_sheet = prefixes[canonical_group] + names[1].lower()
        for mapping in alias['cues']:
            cue = mapping if isinstance(mapping, str) else mapping['sourceCue']
            canonical_cue = mapping if isinstance(mapping, str) else mapping['canonicalCue']
            record = sound.get((canonical_sheet, canonical_cue))
            if not record and android:
                original = android.get('voices', {}).get(canonical_sheet + '|' + canonical_cue.lower())
                if original:
                    record = {**original, 'platform': 'android'}
            if not record or (source_sheet, cue) in result:
                continue
            result[(source_sheet, cue)] = {**record, 'bankAlias': {
                'canonicalSheet': canonical_sheet, 'canonicalCue': canonical_cue, 'sourceSha256': digests[0],
                'canonicalSha256': digests[1], 'verification': 'decoded-pcm-equality'}}
        active.append(names[0])
    return result, active


def refresh_missing(manifest, sound, android, short_names=None, annotations=None):
    result = deepcopy(manifest)
    # JSON duplicates shared banks. Change every occurrence, but count each
    # sourceGroup/file/index only once, independent of gallery references.
    added = {}; rejected = {}; usage_added = {}; short_names = short_names or {}
    annotations = annotations or {}
    for group in GROUPS:
        for bank in result.get(group, {}).values():
            sheet = cue_sheet(bank)
            if not sheet:
                continue
            for stream in bank['streams']:
                if stream.get('semantic'):
                    continue
                key = (sheet, stream['name'])
                identity = (bank.get('sourceGroup', 'cv'), bank['sourceFile'], stream['index'], stream['name'])
                record = sound.get(key)
                platform = record.get('platform', 'pc') if record else 'pc'
                asset = record.get('asset', 'cfgSound.lua') if record else 'cfgSound.lua'
                if not record:
                    record = android.get('voices', {}).get(sheet + '|' + stream['name'].lower())
                    platform = 'android'
                    asset = record.get('asset') if record else None
                supplemental = annotations.get(identity)
                if not record and supplemental and supplemental.get('script'):
                    record = supplemental
                    platform, asset = record['platform'], record['asset']
                if not record and supplemental and supplemental.get('usage') and not stream.get('usage'):
                    stream['usage'] = supplemental['usage']
                    usage_added[identity] = {'bank': bank['id'], 'index': stream['index'], 'name': stream['name'],
                                             'label': supplemental['usage']['label']}
                if not record or not record.get('label') or not record.get('script'):
                    continue
                identity = (bank.get('sourceGroup', 'cv'), bank['sourceFile'], stream['index'])
                audio_id = record.get('audioId')
                annotation_only = bool(record.get('bankAlias') or record.get('annotationOnly'))
                if not annotation_only and stream.get('interactionAudioId') not in (None, audio_id):
                    rejected[identity] = {'bank': bank['id'], 'index': stream['index'],
                                          'reason': 'Existing playback ID conflicts with exact config'}
                    continue
                semantic = {'audioId': audio_id, 'cue': cue_of(stream), 'position': None,
                            'type': record.get('type'), 'label': record['label'],
                            'labelSimplified': fold_label(record['label']),
                            'category': record.get('category') or semantic_category(record['label'], record.get('type')),
                            'script': record['script'], 'openLv': record.get('openLv'), 'source': 'soundBook',
                            'textProvenance': {'platform': platform, 'asset': asset,
                                               'audioId': audio_id, 'cueSheet': sheet, 'cueName': stream['name']}}
                if record.get('bankAlias'):
                    semantic['textProvenance']['bankAlias'] = record['bankAlias']
                    # A canonical bank's text ID labels the duplicate recording;
                    # it does not register that file as a new interaction target.
                    semantic['annotationOnly'] = True
                if record.get('originalConfig'):
                    semantic['textProvenance']['originalConfig'] = record['originalConfig']
                if record.get('annotationOnly'):
                    semantic['annotationOnly'] = True
                if platform == 'android':
                    semantic['textProvenance'].update(android['source'])
                if bank.get('sourceGroup') == 'picture':
                    # Same original label convention as build_picture_entries.
                    from voice_cache import split_picture_label
                    _, character = split_picture_label(record['label'])
                    semantic['character'] = character
                    semantic['characterRoleId'] = short_names.get(fold_label(re.sub(r'\d+$', '', character).strip())) if character else None
                stream['semantic'] = semantic
                added[identity] = {'bank': bank['id'], 'index': stream['index'], 'name': stream['name'],
                                   'platform': platform, 'audioId': audio_id, 'label': semantic['labelSimplified']}
            bank['semanticStreamCount'] = sum(bool(s.get('semantic')) for s in bank['streams'])
            if bank['semanticStreamCount'] and bank.get('labelSource') in (None, 'none'):
                bank['labelSource'] = 'soundBook'
            if bank.get('sourceGroup') == 'picture':
                speakers = {}
                for stream in bank['streams']:
                    semantic = stream.get('semantic', {})
                    character = semantic.get('character')
                    if character:
                        from voice_cache import PICTURE_TEST_MARKER
                        speaker = speakers.setdefault(character, {'name': character, 'roleId': semantic.get('characterRoleId'),
                                                                 'streamIndexes': [], 'test': PICTURE_TEST_MARKER in character})
                        speaker['streamIndexes'].append(stream['index'])
                bank['speakers'] = sorted(speakers.values(), key=lambda s: (-len(s['streamIndexes']), s['name']))
    jp = unique_banks(result, ('entries', 'variantEntries', 'auxiliaryEntries'))
    result['semanticStreamCount'] = sum(b['semanticStreamCount'] for b in jp)
    result['semanticBankCount'] = sum(bool(b['semanticStreamCount']) for b in jp)
    result['semanticEntryCount'] = sum(bool(b['semanticStreamCount']) for b in result.get('entries', {}).values())
    if 'skinLabelledBankCount' in result:
        result['skinLabelledBankCount'] = sum(b.get('sourceGroup') == 'cv_skin' and bool(b['semanticStreamCount']) for b in jp)
    result['identityOnlyBankCount'] = sum(bool(b.get('roleId')) and not b['semanticStreamCount'] for b in jp)
    sources = Counter(s.get('semantic', {}).get('source') for b in jp for s in b['streams'] if s.get('semantic'))
    result['labelSourceCounts'] = dict(sources)
    result['soundBookStreamCount'] = sources['soundBook']
    if 'pictureEntries' in result:
        from voice_cache import refresh_picture_counts
        refresh_picture_counts(result)
    return result, {'addedCount': len(added), 'byPlatform': dict(Counter(a['platform'] for a in added.values())),
                    'added': list(added.values()), 'rejected': list(rejected.values()),
                    'usageAddedCount': len(usage_added), 'usageAdded': list(usage_added.values())}
