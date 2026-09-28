"""Audit the built static site before considering a GitHub Pages upload.

This is a technical check only; it cannot establish permission to publish assets.
"""
import argparse
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MAX_SITE_BYTES = 1_000_000_000  # Conservative interpretation of Pages' 1 GB limit.
MAX_GIT_FILE_BYTES = 100 * 1024 * 1024
REQUIRED = (
    'index.html', 'mobile-acceptance.html', 'static-api/manifest.json',
    'LICENSE', 'THIRD_PARTY_NOTICES.md', 'licenses/SPINE_RUNTIMES_LICENSE.txt',
    'licenses/WEB_DEPENDENCIES.txt',
)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--site', type=Path, default=ROOT / 'dist-pages')
    parser.add_argument('--base', default='/', help='Expected Vite base, e.g. /crosscore-local-archive/')
    args = parser.parse_args()
    site = args.site.resolve()
    base = args.base
    if not (base.startswith('/') and base.endswith('/')):
        parser.error('--base must start and end with /')
    missing = [name for name in REQUIRED if not (site / name).is_file()]
    files = [path for path in site.rglob('*') if path.is_file()]
    links = [path.relative_to(site).as_posix() for path in site.rglob('*') if path.is_symlink()]
    oversized = [path.relative_to(site).as_posix() for path in files
                 if path.stat().st_size > MAX_GIT_FILE_BYTES]
    total = sum(path.stat().st_size for path in files)
    index = (site / 'index.html').read_text(encoding='utf-8') if not missing else ''
    entry = (site / 'mobile-acceptance.html').read_text(encoding='utf-8') if not missing else ''
    bad_base = base != '/' and f'{base}assets/' not in index
    # The acceptance page uses relative links so it remains valid below the base.
    bad_links = '/?entry=' in entry and './?entry=' not in entry
    report = {
        'site': str(site), 'base': base, 'files': len(files), 'bytes': total,
        'missing': missing, 'symlinks': links, 'filesOver100MiB': oversized,
        'overPages1GB': total > MAX_SITE_BYTES, 'baseMissingFromIndex': bad_base,
        'badAcceptanceLinks': bad_links,
        'assetPermissionVerified': False,
    }
    print(json.dumps(report, ensure_ascii=False, indent=2))
    if any((missing, links, oversized, total > MAX_SITE_BYTES, bad_base, bad_links)):
        raise SystemExit(1)


if __name__ == '__main__':
    main()
