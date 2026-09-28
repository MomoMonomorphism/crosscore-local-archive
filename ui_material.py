"""Export source UI materials; never treat a material-only Image as a white sprite."""
from functools import lru_cache
import UnityPy
from asset_cache import unwrap_bundle


@lru_cache(maxsize=4)
def shader_files(source):
    files = {}
    for name in ('shader', 'shader_base', 'common_tex'):
        path = source / name
        if path.exists():
            env = UnityPy.load(unwrap_bundle(path)[2])
            for obj in env.objects:
                files[obj.assets_file.name.lower()] = obj.assets_file
    return files


def export_material(ref, objects, source, folder, cache, sprite=None):
    obj = objects.get(ref.get('m_PathID')) if not ref.get('m_FileID') else None
    if not obj or obj.type.name != 'Material':
        return {'supported': False, 'reason': 'unresolved material reference', 'reference': ref}
    d = obj.read_typetree()
    sr = d['m_Shader']
    sf = obj.assets_file
    if sr['m_FileID']:
        external = sf.externals[sr['m_FileID'] - 1].path.rsplit('/', 1)[-1].lower()
        sf = shader_files(source).get(external)
    shader = sf.objects.get(sr['m_PathID']) if sf else None
    shader_data = shader.read_typetree()['m_ParsedForm'] if shader else {}
    shader_name = shader_data.get('m_Name', '<unresolved>')
    default_floats, default_colors = {}, {}
    for prop in shader_data.get('m_PropInfo', {}).get('m_Props', []):
        if prop['m_Type'] in (2, 3): default_floats[prop['m_Name']] = prop['m_DefValue[0]']
        elif prop['m_Type'] in (0, 1):
            default_colors[prop['m_Name']] = {key: prop[f'm_DefValue[{i}]'] for i, key in enumerate('rgba')}
    props = d['m_SavedProperties']
    textures = {}
    gaps = []
    tex_envs = dict(props['m_TexEnvs'])
    if sprite and not sprite.get('m_FileID') and sprite.get('m_PathID') in objects:
        sd = objects[sprite['m_PathID']].read_typetree()
        # Unity Image.mainTexture overrides the material's _MainTex when it has a Sprite.
        tex_envs['_MainTex'] = {**tex_envs.get('_MainTex', {'m_Scale':{'x':1,'y':1}, 'm_Offset':{'x':0,'y':0}}),
                                'm_Texture': sd['m_RD']['texture']}
        if sd['m_RD']['settingsRaw'] & 1: gaps.append('packed sprite UV mapping')
    for name, tex in tex_envs.items():
        tr = tex['m_Texture']
        info = {'scale': tex['m_Scale'], 'offset': tex['m_Offset']}
        if tr['m_PathID']:
            texture_file = obj.assets_file
            if tr['m_FileID']:
                external = texture_file.externals[tr['m_FileID'] - 1].path.rsplit('/', 1)[-1].lower()
                texture_file = shader_files(source).get(external)
            to = texture_file.objects.get(tr['m_PathID']) if texture_file else None
            if to and to.type.name == 'Texture2D':
                td = to.read()
                path = folder / f'material-texture-{texture_file.name}-{to.path_id}.png'
                if not path.exists(): td.image.save(path)
                info.update(url='/assets/' + path.relative_to(cache).as_posix(),
                            name=td.m_Name, wrapU=td.m_TextureSettings.m_WrapU,
                            wrapV=td.m_TextureSettings.m_WrapV,
                            filter=td.m_TextureSettings.m_FilterMode)
            else:
                gaps.append(f'unresolved texture {name}: {tr}')
        textures[name] = info
    keywords = d['m_ValidKeywords']
    allowed = {'_USEMASK_ON', '_USEDISSOLVE_ON', '_USEUVANI_ON', '_USEUVDISTORTION_ON'}
    if shader_name not in ('Effect/Additive', 'Effect/AlphaBlend'):
        gaps.append(f'unsupported shader {shader_name}')
    if set(keywords) - allowed: gaps.append('unsupported keywords: ' + ', '.join(set(keywords) - allowed))
    floats = {**default_floats, **dict(props['m_Floats'])}
    # UI vertices have no particle dissolve/custom-stream data. These prefabs use defaults.
    if floats.get('_Transparency', 1) != 1: gaps.append('battle transparency dithering')
    return {'name': d['m_Name'], 'shader': shader_name, 'keywords': keywords,
            'floats': floats, 'colors': {**default_colors, **dict(props['m_Colors'])}, 'textures': textures,
            'supported': not gaps, 'reason': '; '.join(gaps)}
