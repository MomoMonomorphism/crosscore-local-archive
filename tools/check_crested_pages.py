"""Check the selected Android resource families and manifest before publishing."""
import hashlib
import json
from pathlib import Path
import struct

ROOT = Path(__file__).resolve().parents[1]
PUBLIC = ROOT / 'pages-pack/public'
references = json.loads((ROOT / 'pages-pack/spine-references.json').read_text('utf8'))
manifest = json.loads((PUBLIC / 'static-api/manifest.json').read_text('utf8'))
checked = 0
for folder, reference in references.items():
    assert reference['platform'] == 'android-cn'
    for name, digest in reference['files'].items():
        data = (PUBLIC / 'assets/spine' / folder / name).read_bytes()
        assert hashlib.sha256(data).hexdigest() == digest, (folder, name)
        checked += 1
    for entry in manifest['entries']:
        for variant in entry['variants']:
            for model in [variant['main'], *[effect['asset'] for effect in variant.get('effects', [])]]:
                if model['folder'] != folder:
                    continue
                data = (PUBLIC / 'assets' / model['jsonPath']).read_bytes()
                assert model['contentSha256'] == hashlib.sha256(data).hexdigest()
                assert model['spineVersion'] == json.loads(data)['skeleton']['spine']
                assert model['resourceReference']['bundleSha256'] == reference['bundleSha256']

skin = PUBLIC / 'assets/spine/3006_skin_crestedplume03_spine'
data = json.loads((skin / '3006_skin_CrestedPlume03.json').read_text('utf8'))
assert data['skeleton']['spine'] == '4.2.38'
assert data['skeleton']['hash'] == 'rJv8BufZf/0'
assert 'in' in data['animations'] and 'idle1' in data['animations']
texture = (skin / '3006_skin_CrestedPlume03.png').read_bytes()
assert struct.unpack('>II', texture[16:24]) == (4096, 4096)
print(json.dumps({'androidFamilies': len(references), 'verifiedFiles': checked,
                  'skinVersion': '4.2.38', 'texture': [4096, 4096]}))
