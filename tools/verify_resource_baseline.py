"""Read-only SHA-256 verification of a frozen PC or Android resource snapshot."""
import argparse
import hashlib
import json
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('baseline', type=Path)
    args = parser.parse_args()
    root = args.baseline.resolve()
    manifest = json.loads((root / 'snapshot.json').read_text(encoding='utf8'))
    if manifest.get('status') != 'verified':
        raise ValueError('Snapshot is not marked verified')
    for index, row in enumerate(manifest['files'], 1):
        target = (root / row['path']).resolve()
        if not target.is_relative_to(root):
            raise ValueError('Path outside baseline')
        if target.stat().st_size != row['bytes']:
            raise ValueError(f'Size mismatch: {row["path"]}')
        with target.open('rb') as stream:
            digest = hashlib.file_digest(stream, 'sha256').hexdigest()
        if digest != row['sha256']:
            raise ValueError(f'SHA-256 mismatch: {row["path"]}')
        if index % 1000 == 0:
            print(f'Checked {index}/{len(manifest["files"])}', flush=True)
    print(f'Verified {len(manifest["files"])} files: {root}')


if __name__ == '__main__':
    main()
