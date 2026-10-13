"""Import explicitly selected Android archive metadata and local static previews."""
import argparse
import hashlib
import json
import shutil
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from PIL import Image
from archive_supplement import FILENAME, PREFIX, select_additions
from asset_cache import DEFAULT_CACHE, DEFAULT_SOURCE, extract_archive_image
from lua_bundle import LuaBundle
from luatable import parse_config


def save(path, data):
    temporary = path.with_suffix('.tmp')
    temporary.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding='utf8')
    temporary.replace(path)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--bundle', type=Path, required=True)
    parser.add_argument('--ids', type=int, nargs='+', required=True)
    parser.add_argument('--cache', type=Path, default=DEFAULT_CACHE)
    parser.add_argument('--source', type=Path, default=DEFAULT_SOURCE)
    parser.add_argument('--backup', type=Path, required=True)
    args = parser.parse_args()
    multi_path = args.cache / 'multi_picture_action.generated.json'
    thumbs_path = args.cache / 'thumbnails.generated.json'
    multi = json.loads(multi_path.read_text('utf8'))
    thumbs = json.loads(thumbs_path.read_text('utf8'))
    bundle = LuaBundle(args.bundle)
    rows = parse_config(bundle.read('cfgCfgArchiveMultiPicture.lua'))
    if isinstance(rows, dict):
        rows = list(rows.values())
    digest = hashlib.sha256(args.bundle.read_bytes()).hexdigest()
    available = {p.name[len(PREFIX):].lower(): p.name[len(PREFIX):]
                 for p in args.source.glob(PREFIX + '*') if p.is_file()}
    additions = select_additions(rows, multi['archive'], available, digest, set(args.ids))
    args.backup.mkdir(parents=True, exist_ok=True)
    for path in [multi_path, thumbs_path, args.cache / FILENAME]:
        if path.is_file() and not (args.backup / path.name).exists():
            shutil.copy2(path, args.backup / path.name)
    # Verify extraction before publishing any new entries to the manifest.
    for key, row in additions.items():
        image_path, _ = extract_archive_image(row['img'], args.source, args.cache)
        with Image.open(image_path) as original:
            scaled = original.convert('RGBA')
            scaled.thumbnail((424, 198), Image.Resampling.LANCZOS)
        image = Image.new('RGBA', (424, 198), (20, 20, 22, 255))
        image.alpha_composite(scaled, ((424-scaled.width)//2, (198-scaled.height)//2))
        relative = 'thumbnails/archive-' + key.replace(':', '-') + '.png'
        target = args.cache / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        image.save(target, format='PNG', optimize=True)
        thumbs.setdefault('archiveEntries', {})[key] = {
            'path': relative, 'sourceName': 'archive:' + row['img'],
            'width': 424, 'height': 198, 'bytes': target.stat().st_size,
        }
    previous = args.cache / FILENAME
    supplement = json.loads(previous.read_text('utf8')) if previous.is_file() else {'archive': {}}
    supplement['archive'].update(additions)
    multi['supplementalArchive'] = supplement['archive']
    thumbs['archiveEntryCount'] = len(thumbs['archiveEntries'])
    save(previous, supplement)
    save(thumbs_path, thumbs)
    save(multi_path, multi)
    print(json.dumps({'added': list(additions), 'pcArchiveRows': len(multi['archive'])}))


if __name__ == '__main__':
    main()
