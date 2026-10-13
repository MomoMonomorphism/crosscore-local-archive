"""Refresh only the shared host in existing reviewed offline game programs.

Use when the game-source pack is already exported. Resource/script prefixes are
preserved byte-for-byte; this does not certify a fresh source-resource export.
"""
import argparse
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MARKER = b'-- Bounded Unity UI host for the unmodified miniature-game Lua scripts.'
MODELS = ('7003005', '7501003', '2008006', '7040003', '3018005')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory', type=Path, action='append', help='offline/ui directory; may repeat')
    args = parser.parse_args()
    directories = args.directory or [ROOT/'web/public/offline/ui', ROOT/'pages-pack/public/offline/ui']
    host = (ROOT/'tools/spine_ui_host.lua').read_bytes().replace(b'\r\n', b'\n')
    assert host.startswith(MARKER)
    updates = []
    for folder in directories:
        for model in MODELS:
            path = folder/(model+'.lua')
            original = path.read_bytes()
            # The generator appends the host after exactly five Lua declarations.
            lines = original.splitlines(keepends=True)
            prefix = b''.join(lines[:5]); old_host = b''.join(lines[5:])
            if not prefix.startswith(b'SPEC=') or not old_host.startswith(MARKER):
                raise ValueError(f'Unexpected exported program structure: {path}')
            if not lines[3].strip() == ('MODEL="'+model+'"').encode():
                raise ValueError(f'Wrong model declaration: {path}')
            updates.append((path, prefix, host))
    report = []
    for path, prefix, host in updates:
        path.write_bytes(prefix+host)
        report.append({'file': str(path), 'preservedPrefixSha256': hashlib.sha256(prefix).hexdigest(),
                       'hostSha256': hashlib.sha256(host).hexdigest()})
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == '__main__': main()
