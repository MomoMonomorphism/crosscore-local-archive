"""Export one stopped Android game's installed APKs and downloaded resources."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import shlex
import stat
import subprocess
import zipfile

PACKAGE = 'com.megagame.crosscore'
REMOTE = f'/sdcard/Android/data/{PACKAGE}/files'
GROUPS = ['Custom', 'sounds', 'sounds_cn', 'videos']


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--adb', required=True)
    parser.add_argument('--serial', required=True)
    parser.add_argument('--destination', type=Path, required=True)
    args = parser.parse_args()
    prefix = [args.adb, '-s', args.serial]
    def shell(command, check=True):
        return subprocess.run(prefix + ['shell', command], check=check, capture_output=True, text=True).stdout.strip()
    def stopped():
        if shell(f'pidof {PACKAGE}', check=False):
            raise RuntimeError('Close the game before exporting a consistent resource baseline')
    stopped()
    package_paths = [line.removeprefix('package:') for line in shell(f'pm path {PACKAGE}').splitlines()]
    if not package_paths or not all(p.startswith('/data/app/') and p.endswith('.apk') for p in package_paths):
        raise RuntimeError('Unexpected APK path')
    version = [line.strip() for line in shell(f'dumpsys package {PACKAGE}').splitlines()
               if any(key in line for key in ['versionCode=', 'versionName=', 'lastUpdateTime='])]
    roots = [REMOTE + '/' + group for group in GROUPS]
    obb = f'/sdcard/Android/obb/{PACKAGE}'
    if shell(f'find {shlex.quote(obb)} -type f', check=False):
        roots.append(obb)
    inputs = ' '.join(shlex.quote(p) for p in roots + package_paths)
    def listing():
        return shell(f"find {inputs} -type f -exec stat -c '%s %Y %n' {{}} \\;")
    before = listing()
    dest = args.destination.resolve()
    dest.mkdir(parents=True, exist_ok=False)
    (dest/'source-stat-before.txt').write_text(before, encoding='utf8')
    print('Hashing Android source files before export', flush=True)
    hashes_text = shell(f'find {inputs} -type f -exec sha256sum {{}} +')
    hashes = {line.split(None, 1)[1].strip(): line.split(None, 1)[0] for line in hashes_text.splitlines()}
    (dest/'source-sha256.txt').write_text(hashes_text, encoding='utf8')
    (dest/'resources').mkdir()
    (dest/'apk').mkdir()
    with (dest/'transfer.log').open('w',encoding='utf8') as log:
        for remote in roots:
            target = dest/'obb' if remote == obb else dest/'resources'/remote.rsplit('/',1)[1]
            print('Exporting ' + remote, flush=True)
            subprocess.run(prefix+['pull','-a',remote,str(target)],stdout=log,stderr=log,check=True)
        for remote in package_paths:
            subprocess.run(prefix+['pull','-a',remote,str(dest/'apk'/remote.rsplit('/',1)[1])],stdout=log,stderr=log,check=True)
    stopped()
    after = listing()
    if sorted(before.splitlines()) != sorted(after.splitlines()):
        raise RuntimeError('Remote resources changed during export')
    rows = []
    for remote, expected in sorted(hashes.items()):
        if remote in package_paths:
            relative = 'apk/' + remote.rsplit('/',1)[1]
        elif remote.startswith(obb+'/'):
            relative = 'obb/' + remote[len(obb)+1:]
        else:
            relative = 'resources/' + remote[len(REMOTE)+1:]
        path = dest/relative
        with path.open('rb') as stream:
            actual = hashlib.file_digest(stream,'sha256').hexdigest()
        if actual != expected:
            raise RuntimeError(f'Android copy digest mismatch: {relative}')
        rows.append({'path':relative,'source':remote,'bytes':path.stat().st_size,'sha256':actual})
    actual_files = {p.relative_to(dest).as_posix() for d in ['resources','apk','obb'] for p in (dest/d).rglob('*') if p.is_file()}
    if actual_files != {r['path'] for r in rows}:
        raise RuntimeError('Exported file set differs from source')
    apk_assets = []
    for path in (dest/'apk').glob('*.apk'):
        with zipfile.ZipFile(path) as z:
            apk_assets.extend({'apk':path.name,'name':i.filename,'bytes':i.file_size}
                              for i in z.infolist() if i.filename.startswith('assets/') and not i.is_dir())
    (dest/'apk-assets-index.json').write_text(json.dumps(apk_assets,ensure_ascii=False,indent=2),encoding='utf8')
    manifest={'schema':1,'status':'verified','createdAt':datetime.now(timezone.utc).isoformat(),
              'label':dest.name,'package':PACKAGE,'versionEvidence':version,'files':rows,
              'bytes':sum(r['bytes'] for r in rows),'apkAssetCount':len(apk_assets),
              'scope':'Installed APKs plus all locally present Custom/sounds/sounds_cn/videos and OBB files',
              'limitations':['Does not prove every optional game resource has been downloaded.',
                             'Account state, SDK data, preferences and logs from the device are excluded.',
                             'No PC configuration was replaced by this Android snapshot.']}
    (dest/'snapshot.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2),encoding='utf8')
    for path in dest.rglob('*'):
        if path.is_file(): path.chmod(path.stat().st_mode & ~stat.S_IWRITE)
    print(json.dumps({'status':'verified','files':len(rows),'bytes':manifest['bytes'],'version':version}),flush=True)


if __name__ == '__main__':
    main()
