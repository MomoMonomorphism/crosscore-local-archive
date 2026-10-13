"""Prepare audited compatible Android bundles in isolation; never changes production selection."""
from collections import Counter
import hashlib
import json
from pathlib import Path
import sys
import gc
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from PIL import Image
from asset_cache import extract_package
from spine_runtime_settings import runtime_settings
from tools.audit_spine_platforms import ANDROID, OUTPUT, digest, file_hash

STAGE = ROOT / '.scratch/spine-android-batch/cache'
REPORT = ROOT / '.scratch/spine-android-batch/prepared.json'


def prepare(package, row):
    assert row['status'] == 'compatible'
    if file_hash(ANDROID / package) != row['androidSha256']:
        raise ValueError('Android source changed after audit')
    manifest = extract_package(package, ANDROID, STAGE)
    if manifest['sourceIdentity']['sha256'] != row['androidSha256']:
        raise ValueError('Staged bundle hash differs')
    folder = STAGE / 'spine' / manifest['folder']
    for model in manifest['models']:
        actual = json.loads((folder / model['json']).read_text('utf8'))
        expected = row['android']['models'][model['sourceName']]
        assert actual.get('skeleton', {}) == expected['header']
        assert {k: digest(v) for k, v in actual.items() if k not in ('skeleton', 'animations')} == expected['sections']
        assert {k: digest(v) for k, v in actual.get('animations', {}).items()} == expected['animations']
    for name in manifest['atlases']:
        assert hashlib.sha256((folder / name).read_bytes()).hexdigest() == row['android']['atlases'][name]
    textures = {k.lower(): v for k, v in row['android']['textures'].items()}
    for name in manifest['pages']:
        expected = textures[Path(name).stem.lower()]
        with Image.open(folder / name) as image:
            assert image.size == (expected['width'], expected['height'])
            image.verify()
    native = runtime_settings(package, ANDROID, STAGE)
    assert not native['warnings']
    assert {n: {k: v for k, v in p.items() if k != 'sources'} for n, p in native['models'].items()} == row['android']['profiles']
    return {'status': 'prepared', 'pcSha256': row['pcSha256'], 'androidSha256': row['androidSha256'],
            'folder': manifest['folder'], 'models': manifest['models'],
            'pngBytes': sum((folder / name).stat().st_size for name in manifest['pages'])}


def main():
    audit = json.loads(OUTPUT.read_text('utf8'))
    candidates = {p: r for p, r in audit['packages'].items() if r['status'] == 'compatible'}
    result = {'stage': str(STAGE), 'audit': str(OUTPUT), 'candidates': len(candidates), 'packages': {}}
    for index, (package, row) in enumerate(candidates.items(), 1):
        try:
            result['packages'][package] = prepare(package, row)
        except Exception as error:
            result['packages'][package] = {'status': 'failed', 'error': f'{type(error).__name__}: {error}'}
        gc.collect()
        if index % 10 == 0 or index == len(candidates):
            result['summary'] = dict(Counter(r['status'] for r in result['packages'].values()))
            REPORT.parent.mkdir(parents=True, exist_ok=True)
            temporary = REPORT.with_suffix('.tmp')
            temporary.write_text(json.dumps(result, ensure_ascii=False, indent=2), 'utf8')
            temporary.replace(REPORT)
            print(f'{index}/{len(candidates)} {result["summary"]}', flush=True)
    if result['summary'].get('failed'):
        raise SystemExit('Preparation failed; production references unchanged')


if __name__ == '__main__':
    main()
