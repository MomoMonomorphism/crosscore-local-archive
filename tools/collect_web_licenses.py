"""Collect license notices for packages included by the production lockfile.

Run after npm ci and before the Pages build. The output is generated, not an
assertion that unrelated game assets or the Spine integration are licensed.
"""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WEB = ROOT / 'web'
LOCK = json.loads((WEB / 'package-lock.json').read_text(encoding='utf-8'))
OUTPUT = ROOT / 'pages-pack/public/licenses/WEB_DEPENDENCIES.txt'
LICENSE_NAMES = ('LICENSE', 'LICENSE.txt', 'LICENSE.md', 'LICENSE-MIT.txt',
                 'LICENCE', 'LICENCE.txt', 'COPYING')
MIT_TEXT = (ROOT / 'LICENSE').read_text(encoding='utf-8').split('Permission is hereby')[1]


def package_dir(name):
    for root in (WEB, ROOT / '.scratch/fengari-sandbox'):
        candidate = root / name
        if candidate.is_dir():
            return candidate
    raise FileNotFoundError(f'Run npm ci in web first: {name}')


def notice_for(name, locked):
    folder = package_dir(name)
    metadata = json.loads((folder / 'package.json').read_text(encoding='utf-8'))
    version = locked['version']
    if metadata.get('version') != version:
        raise ValueError(f'Installed version differs from lockfile: {name}')
    license_id = metadata.get('license', locked.get('license', 'unspecified'))
    author = metadata.get('author', '')
    if isinstance(author, dict):
        author = author.get('name', '')
    content = next(((folder / filename).read_text(encoding='utf-8', errors='replace')
                    for filename in LICENSE_NAMES if (folder / filename).is_file()), None)
    if content is None and name == 'node_modules/@esotericsoftware/spine-pixi-v7':
        content = (ROOT / 'third_party/SPINE_RUNTIMES_LICENSE.txt').read_text(encoding='utf-8')
    if content is None and license_id == 'MIT':
        content = f'Copyright holder/author: {author or metadata["name"]}\n\nPermission is hereby{MIT_TEXT}'
    if content is None:
        raise FileNotFoundError(f'No license text for {name} ({license_id})')
    return f'===== {metadata["name"]} {version} | {license_id} =====\n{content.strip()}\n'


def main():
    packages = [(name, data) for name, data in LOCK['packages'].items()
                if name.startswith('node_modules/') and not data.get('dev')]
    sections = [notice_for(name, data) for name, data in sorted(packages)]
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text('Web dependency license notices\n'
                      'Generated from web/package-lock.json and installed package metadata.\n\n'
                      + '\n'.join(sections), encoding='utf-8')
    print(json.dumps({'packages': len(packages), 'bytes': OUTPUT.stat().st_size,
                      'output': str(OUTPUT)}))


if __name__ == '__main__':
    main()
