"""Commit only prepared + runtime-checked compatible references to the local registry.

Does not publish or rewrite game Lua, configs, snapshots or live asset files.
"""
import argparse
import json
import os
from pathlib import Path
import sys
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from runtime_paths import PATHS
from tools.audit_spine_platforms import ANDROID, OUTPUT, file_hash
from tools.prepare_spine_references import REPORT


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    audit = json.loads(OUTPUT.read_text('utf8'))
    prepared = json.loads(REPORT.read_text('utf8'))
    checked = json.loads((REPORT.parent / 'runtime-check.json').read_text('utf8'))
    hall = json.loads((REPORT.parent / 'hall-runtime-check.json').read_text('utf8'))
    eligible = {p: row for p, row in audit['packages'].items() if row['status'] == 'compatible'}
    holds = json.loads((REPORT.parent / 'runtime-holds.json').read_text('utf8'))['packages']
    assert set(checked['excludedRuntimePackages']) == set(holds)
    original_check = json.loads((REPORT.parent / 'runtime-check-initial.json').read_text('utf8'))
    assert set(holds) <= {'prefabs_spine_' + row['asset'].split('/')[0] for row in original_check['failures']}
    for p, hold in holds.items():
        assert eligible[p]['pcSha256'] == hold['pcSha256'] and eligible[p]['androidSha256'] == hold['androidSha256']
    candidates = {p: row for p, row in eligible.items() if p not in holds}
    assert set(prepared['packages']) == set(eligible)
    assert all(row['status'] == 'prepared' for row in prepared['packages'].values())
    assert not checked['failures'] and all(r['status'] != 'failed' for r in hall['results'])
    manifest = json.loads((PATHS['cache'] / 'assets.generated.json').read_text('utf8'))
    expected = {v['main']['id'] for e in manifest['entries'] if e['category'] == 'character'
                for v in e['variants'] if 'prefabs_spine_' + v['main']['folder'] in candidates}
    checked_main = {row['asset'] for row in checked['results']}
    assert expected <= checked_main, sorted(expected - checked_main)
    registry_path = ROOT / 'spine_resource_references.json'
    registry = json.loads(registry_path.read_text('utf8'))
    before = set(registry)
    base_source = Path(os.path.relpath(PATHS['source'], ROOT)).as_posix()
    for package, row in candidates.items():
        assert file_hash(PATHS['source'] / package) == row['pcSha256']
        assert file_hash(ANDROID / package) == row['androidSha256']
        if package in registry:
            assert registry[package]['sha256'] == row['androidSha256']
            registry[package]['baseSource'] = base_source
            continue
        registry[package] = {
            'source': Path(os.path.relpath(ANDROID / package, ROOT)).as_posix(),
            'baseSource': base_source, 'platform': 'android-cn',
            'baseline': 'android-cn-3.3.0-20261001-d92fccc3',
            'baseSha256': row['pcSha256'], 'sha256': row['androidSha256'],
            'spineVersion': next(iter(row['android']['models'].values()))['header']['spine'],
            'reason': 'Batch audited: unchanged skeleton/action/atlas/native layout and render settings; Android original textures do not reduce resolution.',
        }
    # Preserve the separately reviewed Crestedplume03 entrance correction.
    for package in before:
        assert file_hash(PATHS['source'] / package) == registry[package]['baseSha256']
        registry[package]['baseSource'] = base_source
    report = {'newReferences': len(set(registry) - before), 'totalReferences': len(registry),
              'compatiblePrepared': len(eligible), 'runtimeHeld': len(holds), 'runtimeModels': len(checked['results']),
              'replacedEntrances': checked['replacedEntrances'], 'applied': args.apply}
    if args.apply:
        backup = REPORT.parent / 'registry-before.json'
        if not backup.exists():
            backup.write_bytes(registry_path.read_bytes())
        temporary = registry_path.with_suffix('.tmp')
        temporary.write_text(json.dumps(dict(sorted(registry.items())), ensure_ascii=False, indent=2) + '\n', 'utf8')
        temporary.replace(registry_path)
    (REPORT.parent / ('adoption.json' if args.apply else 'adoption-plan.json')).write_text(json.dumps(report, indent=2), 'utf8')
    print(json.dumps(report))


if __name__ == '__main__':
    main()
