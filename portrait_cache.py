"""Full-size character Texture2D extraction; never trim the transparent canvas."""
import json
import re
from asset_cache import DEFAULT_SOURCE, DEFAULT_CACHE, unwrap_bundle, _package_lock
import UnityPy


def extract_portrait(name, source_root=DEFAULT_SOURCE, cache_root=DEFAULT_CACHE, thumbnail=False):
    if not re.fullmatch(r'[a-zA-Z0-9_-]+', name):
        raise ValueError('invalid character image name')
    name = name.lower()
    source = source_root / ('textures_bigs_character_' + name)
    stat = source.stat()
    root = cache_root / 'portraits'
    root.mkdir(parents=True, exist_ok=True)
    suffix = '.thumb' if thumbnail else ''
    output = root / (name + suffix + '.png')
    metadata = root / (name + suffix + '.json')
    stamp = {'sourceBytes': stat.st_size, 'sourceMtimeNs': stat.st_mtime_ns, 'version': 1}
    with _package_lock('portrait:' + name):
        if output.is_file() and metadata.is_file():
            if json.loads(metadata.read_text()) == stamp:
                return output
        environment = UnityPy.load(unwrap_bundle(source)[2])
        textures = [obj.read() for obj in environment.objects if obj.type.name == 'Texture2D']
        textures = [texture for texture in textures if texture.m_Name.lower() == 'img']
        if len(textures) != 1:
            raise ValueError('expected exactly one base Texture2D img')
        temporary = output.with_suffix('.tmp')
        image = textures[0].image.convert('RGBA')
        if thumbnail:
            image.thumbnail((160, 160))
        image.save(temporary, format='PNG')
        temporary.replace(output)
        metadata.write_text(json.dumps(stamp), encoding='utf-8')
    return output
