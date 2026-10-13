"""Explicit Android archive additions; PC IDs and interaction rules stay separate."""
import json
from pathlib import Path

FILENAME = 'android_archive_supplement.generated.json'
PREFIX = 'textures_bigs_uis_multiimg_'


def select_additions(rows, existing, available_images, digest, selected_ids):
    images = {r.get('img', '').lower() for r in existing.values() if r.get('img')}
    result = {}
    for row in rows:
        if row['id'] not in selected_ids or (row.get('img') or '').lower() in images:
            continue
        name = available_images.get((row.get('img') or '').lower())
        if not name:
            raise ValueError(f"Missing local image for Android archive {row['id']}")
        identity = f"android:{row['id']}"
        result[identity] = {
            'id': row['id'], 'title': row.get('sName') or name, 'img': name,
            'icon': row.get('icon'), 'l2dName': row.get('l2dName'),
            'l2dPos': row.get('l2dPos'), 'imgPos': row.get('imgPos'),
            'show': row.get('show'), 'sort': row.get('sort'), 'groupIds': [],
            'entryMatches': [], 'pictureBankIds': [],
            'hasDynamicTouch': False, 'hasStaticTouch': False,
            'source': {'platform': 'android-cn', 'archiveId': row['id'], 'luaSha256': digest},
            'presentation': 'static-with-particles' if row.get('l2dName') else 'static',
        }
        images.add(name.lower())
    return result


def load_additions(cache: Path, source: Path, existing):
    path = cache / FILENAME
    if not path.is_file():
        return {}
    payload = json.loads(path.read_text('utf8'))
    existing_images = {(row.get('img') or '').lower() for row in existing.values()}
    return {key: row for key, row in payload['archive'].items()
            if key == f"android:{row['id']}" and row['img'].lower() not in existing_images
            and (source / (PREFIX + row['img'].lower())).is_file()}
