"""Export the five original miniature-game Lua scenes for a static browser build.

Only reads existing local cache and game Lua bundles. Generated game-derived
files stay under ignored web/public/offline, outside the source commit.
"""
import hashlib
import json
from pathlib import Path
import re
import shutil
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from lua_bundle import get_bundle
from tools.run_game_lua import lua_literal
from runtime_paths import PATHS

MODELS = ('7003005', '7501003', '2008006', '7040003', '3018005')
DEST = ROOT / 'web/public/offline'
SOUND = re.compile(r'Play(?:TempSound|BGM)\(\s*["\']([^"\']+)["\']\s*\)')


def prepare(model, cache, bundle, manifest, host, utility):
    scene_file = cache / 'spine-ui' / model / 'scene.json'
    scene = json.loads(scene_file.read_text(encoding='utf-8'))
    if scene.get('version') != 6:
        raise ValueError(f'{model}: expected reviewed Spine UI scene version 6')
    rows = {str(row['index']): {'track': row['track'], 'multi': bool(row['content'].get('clicks'))}
            for row in manifest['models'][model]}
    scripts = {name: bundle.read(name + '.lua')
               for name in sorted({node['lua'] for node in scene['nodes'].values() if node.get('lua')})}
    scripts['__split_number'] = 'local this={}\n' + utility[utility.index('function this:SplitNumber(num)'):]
    audio_names = sorted({name for code in scripts.values() for name in SOUND.findall(code)})

    old_prefix = f'/assets/spine-ui/{model}/'
    new_prefix = f'/offline/spine-ui/{model}/'
    copied = set()

    def replace(value):
        if isinstance(value, dict):
            return {replace(key): replace(child) for key, child in value.items()}
        if isinstance(value, list):
            return [replace(child) for child in value]
        if isinstance(value, str) and value.startswith(old_prefix):
            source = cache / value.removeprefix('/assets/')
            if not source.is_file():
                raise FileNotFoundError(source)
            target = DEST / value.removeprefix('/assets/')
            target.parent.mkdir(parents=True, exist_ok=True)
            if value not in copied:
                shutil.copyfile(source, target)
                copied.add(value)
            return new_prefix + value[len(old_prefix):]
        return value

    scene = replace(scene)
    program = '\n'.join((
        'SPEC=' + lua_literal(scene),
        'SOURCES=' + lua_literal(scripts),
        'ROWS=' + lua_literal(rows),
        'MODEL=' + lua_literal(model),
        'CALLBACK_PREFIX="browser:"',
        host,
    ))
    ui_dir = DEST / 'ui'
    ui_dir.mkdir(parents=True, exist_ok=True)
    (ui_dir / f'{model}.lua').write_text(program, encoding='utf-8')
    for name in audio_names:
        source = cache / 'spine-ui-audio' / (name + '.wav')
        if not source.is_file():
            raise FileNotFoundError(f'{source}; decode this source audio before export')
        target = DEST / 'audio' / (name + '.wav')
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target)
    (ui_dir / f'{model}.assets.json').write_text(json.dumps({
        'images': sorted(new_prefix + path[len(old_prefix):] for path in copied),
        'audio': audio_names,
    }, ensure_ascii=False), encoding='utf-8')
    return {'model': model, 'sceneVersion': 6, 'luaScripts': sorted(scripts),
            'imageCount': len(copied), 'audioCount': len(audio_names),
            'luaBytes': len(program.encode()),
            'sourceSceneSha256': hashlib.sha256(scene_file.read_bytes()).hexdigest()}


def main():
    cache = PATHS['cache']
    manifest_file = cache / 'spine_action.generated.json'
    manifest = json.loads(manifest_file.read_text(encoding='utf-8'))
    bundle = get_bundle()
    utility = bundle.read('StringUtil.lua')
    host = (ROOT / 'tools/spine_ui_host.lua').read_text(encoding='utf-8')
    report = [prepare(model, cache, bundle, manifest, host, utility) for model in MODELS]
    meta = {'models': report,
            'sourceManifestSha256': hashlib.sha256(manifest_file.read_bytes()).hexdigest()}
    (DEST / 'ui' / 'meta.json').write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(meta, ensure_ascii=False))


if __name__ == '__main__':
    main()
