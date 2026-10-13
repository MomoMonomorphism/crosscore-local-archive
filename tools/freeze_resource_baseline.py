"""Copy a local resource baseline and verify every byte without changing inputs."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import sys
from datetime import datetime, timezone

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from runtime_paths import PATHS

CACHE_DIRS = {'spine', 'asmr', 'voice', 'archive', 'portraits', 'thumbnails',
              'spine-ui', 'spine-ui-audio', 'drag', 'hall-effects', 'spine-runtime'}


def sha(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def files(root):
    for parent, dirs, names in os.walk(root):
        for name in dirs:
            path = Path(parent) / name
            if path.is_symlink() or path.is_junction():
                raise ValueError(f'Unexpected linked directory: {path}')
        for name in names:
            path = Path(parent) / name
            if path.is_symlink():
                raise ValueError(f'Unexpected linked file: {path}')
            yield path


def copy_verified(source, target):
    before = source.stat()
    target.parent.mkdir(parents=True, exist_ok=True)
    digest = hashlib.sha256()
    with source.open('rb') as incoming, target.open('xb') as outgoing:
        while chunk := incoming.read(4 * 1024 * 1024):
            digest.update(chunk)
            outgoing.write(chunk)
    after = source.stat()
    if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
        raise RuntimeError(f'Source changed while copying: {source}')
    if sha(target) != digest.hexdigest():
        raise RuntimeError(f'Copy digest mismatch: {target}')
    shutil.copystat(source, target)
    return {'bytes': before.st_size, 'mtimeNs': before.st_mtime_ns, 'sha256': digest.hexdigest()}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--destination', type=Path, required=True)
    args = parser.parse_args()
    dest = args.destination.resolve()
    pairs = {}
    client = PATHS['game_data'].parent
    for p in files(client):
        rel = p.relative_to(client)
        if 'BrowserProfile' in rel.parts:
            continue
        if p.parent == PATHS['game_data'] / 'GameHotRes':
            continue  # Account state, announcements and login preferences.
        pairs['client/' + rel.as_posix()] = p
    for p in files(PATHS['cache']):
        rel = p.relative_to(PATHS['cache'])
        if len(rel.parts) == 1 or rel.parts[0] in CACHE_DIRS:
            pairs['cache-seed/' + rel.as_posix()] = p
    pairs['external/census_full.json'] = PATHS['census']
    for p in files(PATHS['decoder'].parent):
        pairs['tools/vgmstream/' + p.relative_to(PATHS['decoder'].parent).as_posix()] = p
    for p in files(ROOT / 'dist'):
        pairs['dist/' + p.relative_to(ROOT / 'dist').as_posix()] = p
    names = subprocess.check_output(['git', 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], cwd=ROOT).decode().split('\0')
    for name in names:
        p = ROOT / name
        if name and p.is_file():
            pairs['source/' + name] = p
    for name in ['luascripts', 'fixluascripts']:
        p = ROOT / '.scratch/android_cn' / name
        if p.is_file():
            pairs['android-reference-20260925/' + name] = p
    total = sum(p.stat().st_size for p in pairs.values())
    if shutil.disk_usage(dest.parent).free < total + 2 * 1024**3:
        raise RuntimeError('Insufficient free space')
    dest.mkdir(exist_ok=False)
    print(f'Copying {len(pairs)} files, {total / 1024**3:.2f} GiB', flush=True)
    rows = []
    for n, (relative, source) in enumerate(sorted(pairs.items()), 1):
        info = copy_verified(source, dest / relative)
        rows.append({'path': relative, 'source': str(source), **info})
        if n % 250 == 0:
            print(f'Verified {n}/{len(pairs)} files', flush=True)
    for row in rows:
        current = Path(row['source']).stat()
        if (current.st_size, current.st_mtime_ns) != (row['bytes'], row['mtimeNs']):
            raise RuntimeError(f'Source changed during snapshot: {row["source"]}')
    manifest = {'schema': 1, 'status': 'verified', 'createdAt': datetime.now(timezone.utc).isoformat(),
                'label': dest.name, 'workspace': str(ROOT),
                'commit': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip(),
                'sourceIncludesWorkingChanges': True, 'sourcePaths': {k: str(v) for k, v in PATHS.items()},
                'bytes': sum(row['bytes'] for row in rows), 'files': rows,
                'limitations': ['Captures locally present assets; not proof of a complete game download.',
                                'Android reference contains Lua only; not a full Android baseline.',
                                'Python, Node and Unity installations are not included.']}
    (dest / 'snapshot.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding='utf8')
    # The running viewer uses a separate writable cache, never this seed.
    for row in rows:
        path = dest / row['path']
        path.chmod(path.stat().st_mode & ~stat.S_IWRITE)
    (dest / 'snapshot.json').chmod(stat.S_IREAD)
    print(json.dumps({'status': 'verified', 'files': len(rows), 'bytes': manifest['bytes'],
                      'manifestSha256': sha(dest / 'snapshot.json')}, ensure_ascii=False), flush=True)


if __name__ == '__main__':
    main()
