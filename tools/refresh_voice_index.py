"""Verify original audio metadata and recover proven missing text or usage."""
import argparse
import hashlib
import json
from pathlib import Path
import sys
import time
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from runtime_paths import PATHS
from voice_cache import probe_bank, DEFAULT_DECODER, VOICE_SOURCE_SUBDIRS
from voice_semantics import load_sound_book, load_short_name_index, sound_book_status
from voice_index_refresh import refresh_missing, unique_banks, verified_sound_aliases
from text_localization import FILENAME
from voice_annotations import verified_annotations


def digest(path):
    with path.open('rb') as file:
        return hashlib.file_digest(file, 'sha256').hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    target = PATHS['cache'] / 'voices.generated.json'
    raw = target.read_bytes()
    original = json.loads(raw)
    catalog_path = PATHS['cache'] / FILENAME
    android = json.loads(catalog_path.read_text('utf8'))
    alias_path = ROOT / 'voice_bank_aliases.json'
    aliases = json.loads(alias_path.read_text('utf8'))['aliases'] if alias_path.is_file() else []
    sound, active = verified_sound_aliases(load_sound_book(), PATHS['voice_source'], aliases, android)
    annotations_path = ROOT / 'voice_annotations.json'
    registry = json.loads(annotations_path.read_text('utf8')) if annotations_path.is_file() else {}
    lua_paths = {'pc': PATHS['lua_bundle'], **{k: (ROOT / v['path']).resolve()
                 for k, v in registry.get('luaSources', {}).items()}}
    roots = {group: PATHS['voice_source'].joinpath(*parts) for group, parts in VOICE_SOURCE_SUBDIRS.items()}
    roots['cv_cn'] = PATHS['chinese_source']
    annotations = verified_annotations(registry, roots, lua_paths)
    updated, report = refresh_missing(original, sound, android, load_short_name_index(), annotations)
    report['activeBankAliases'] = active
    affected = {r['bank'] for r in report['added'] + report['usageAdded']}
    verified = []
    banks = {b['id']: b for b in unique_banks(original)}
    for bank_id in sorted(affected):
        bank = banks[bank_id]
        group = bank.get('sourceGroup', 'cv')
        directory = PATHS['chinese_source'] if group == 'cv_cn' else PATHS['voice_source'].joinpath(*VOICE_SOURCE_SUBDIRS.get(group, ()))
        source = (directory / bank['sourceFile']).resolve()
        assert source.parent == directory.resolve() and source.stat().st_size == bank['bytes'], bank_id
        actual = probe_bank(DEFAULT_DECODER, source)
        triples = lambda streams: [(s['index'], s['name'], s['duration']) for s in streams]
        assert triples(actual) == triples(bank['streams']), 'Changed audio stream identity: ' + bank_id
        verified.append({'bank': bank_id, 'streams': len(actual), 'sha256': digest(source)})
        if len(verified) % 10 == 0:
            print(f'Verified {len(verified)}/{len(affected)} affected audio banks', flush=True)
    # Playback identities, existing semantics and runtime aliases never change.
    for group in ('entries', 'variantEntries', 'auxiliaryEntries', 'chineseEntries', 'chineseVariantEntries', 'pictureEntries'):
        assert set(original.get(group, {})) == set(updated.get(group, {}))
        for key, before in original.get(group, {}).items():
            after = updated[group][key]
            for field in ('id', 'sourceFile', 'sourceGroup', 'bytes', 'streamCount'):
                assert before.get(field) == after.get(field)
            for old, new in zip(before['streams'], after['streams'], strict=True):
                assert {k: v for k, v in new.items() if k not in ('semantic', 'usage')} == {k: v for k, v in old.items() if k not in ('semantic', 'usage')}
                if old.get('usage'):
                    assert old['usage'] == new['usage']
                if old.get('semantic'):
                    assert old['semantic'] == new['semantic']
    updated['soundBook'] = sound_book_status()
    updated['semanticsRefreshedAt'] = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
    updated['semanticIndexSource'] = {'version': 1, 'luaSha256': digest(PATHS['lua_bundle']),
                                      'androidTextSha256': digest(catalog_path),
                                      'bankAliasesSha256': digest(alias_path) if alias_path.is_file() else None,
                                      'annotationsSha256': digest(annotations_path) if annotations_path.is_file() else None}
    scratch = ROOT / '.scratch/voice-index-review'
    scratch.mkdir(exist_ok=True)
    backup = scratch / 'voices-before-refresh.json'
    if not backup.exists(): backup.write_bytes(raw)
    candidate = scratch / 'voices.refreshed.json'
    candidate.write_text(json.dumps(updated, ensure_ascii=False, indent=2) + '\n', 'utf8')
    report.update({'verifiedBanks': verified, 'beforeSha256': hashlib.sha256(raw).hexdigest(),
                   'afterSha256': digest(candidate), 'applied': args.apply,
                   'source': updated['semanticIndexSource'], 'oldSoundBook': original.get('soundBook'),
                   'currentSoundBook': updated['soundBook']})
    (scratch / ('refresh-applied.json' if args.apply else 'refresh-plan.json')).write_text(json.dumps(report, ensure_ascii=False, indent=2), 'utf8')
    if args.apply:
        assert target.read_bytes() == raw, 'Voice manifest changed during verification'
        temporary = target.with_suffix('.tmp')
        temporary.write_bytes(candidate.read_bytes())
        temporary.replace(target)
    print(json.dumps({k: v for k, v in report.items() if k not in ('added', 'usageAdded', 'verifiedBanks')}, ensure_ascii=False))


if __name__ == '__main__': main()
