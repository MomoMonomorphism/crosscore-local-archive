"""Extract the UI scene graph used by the original miniature-game Lua scripts."""
import json
import zlib
from pathlib import Path
import UnityPy
from asset_cache import unwrap_bundle, DEFAULT_SOURCE, DEFAULT_CACHE
from ui_clip import decode_clip
from ui_material import export_material

MODELS = {
    '7003005': '70030_skin_Poseidon05_spine',
    '7501003': '75010_skin_VodkaMirror03_spine',
    '2008006': '20080_skin_Melody06_spine',
    '7040003': '70400_skin_LycorisRadiata03a_spine',
    '3018005': '30180_skin_Machairodus05a_spine',
}


def extract(model, source=DEFAULT_SOURCE, cache=DEFAULT_CACHE):
    name = MODELS[model]
    env = UnityPy.load(unwrap_bundle(source / ('prefabs_uis_spine_' + name.lower()))[2])
    objects = {o.path_id: o for o in env.objects}
    gos, transforms, scripts, components = {}, {}, {}, {}
    animators = {}
    canvas_groups = {}
    component_ids = {}
    for o in env.objects:
        if o.type.name == 'CanvasGroup':
            d=o.read_typetree();canvas_groups[d['m_GameObject']['m_PathID']]=d
        if o.type.name == 'Animator':
            d=o.read_typetree();animators[d['m_GameObject']['m_PathID']]=d
        if o.type.name not in ('GameObject', 'RectTransform', 'Transform', 'MonoScript', 'MonoBehaviour'): continue
        d = o.read_typetree()
        if o.type.name == 'GameObject': gos[o.path_id] = d
        elif o.type.name in ('RectTransform', 'Transform'): transforms[o.path_id] = d
        elif o.type.name == 'MonoScript': scripts[o.path_id] = d['m_ClassName']
        else:
            components.setdefault(d['m_GameObject']['m_PathID'], []).append(d)
            component_ids[id(d)] = o.path_id
    folder = cache / 'spine-ui' / model
    folder.mkdir(parents=True, exist_ok=True)
    images = {}
    cross_images = {}
    unsupported = []
    def export_sprite(obj, key):
        d = obj.read()
        path = folder / (key + '.png')
        if not path.exists(): d.image.save(path)
        meta = {'name':d.m_Name, 'url':'/assets/' + path.relative_to(cache).as_posix(),
                'width':d.m_Rect.width, 'height':d.m_Rect.height,
                'border':[d.m_Border.x,d.m_Border.y,d.m_Border.z,d.m_Border.w], 'ppu':d.m_PixelsToUnits}
        images[key] = meta
        return meta
    for o in env.objects:
        if o.type.name == 'Sprite': export_sprite(o, str(o.path_id))
    # AutoLoadResFromCrossAB explicitly identifies both the target component and bundle.
    # Path IDs alone are not globally unique across serialized files.
    for cs in components.values():
        for c in cs:
            if scripts.get(c['m_Script']['m_PathID']) != 'AutoLoadResFromCrossAB': continue
            for item in c.get('infoList', []):
                target = objects.get(item['com']['m_PathID'])
                pack = source / item['abName']
                if not target or not pack.is_file():
                    unsupported.append({'kind':'cross-bundle','reference':item});continue
                dependency = UnityPy.load(unwrap_bundle(pack)[2])
                sprites = [o for o in dependency.objects if o.type.name == 'Sprite' and o.read().m_Name == item['resName']]
                if len(sprites) != 1:
                    unsupported.append({'kind':'cross-sprite','reference':item});continue
                key = 'cross-' + str(zlib.crc32((item['abName']+'/'+item['resName']).encode()))
                cross_images[target.path_id] = export_sprite(sprites[0], key)
    nodes = {}
    for pid, t in transforms.items():
        go_id = t['m_GameObject']['m_PathID']; go = gos[go_id]
        n = {'id': str(pid), 'name': go['m_Name'], 'active': bool(go['m_IsActive']),
             'children': [str(c['m_PathID']) for c in t.get('m_Children', [])],
             'rect': {k: t.get(k) for k in ('m_AnchorMin','m_AnchorMax','m_AnchoredPosition','m_SizeDelta','m_Pivot','m_LocalScale','m_LocalRotation','m_LocalPosition')},
             'parent': str(t['m_Father']['m_PathID'])}
        if go_id in canvas_groups: n['alpha'] = canvas_groups[go_id]['m_Alpha']
        for c in components.get(go_id, []):
            cls = scripts.get(c['m_Script']['m_PathID'])
            # XLuaMono.Init enumerates parameter components without testing enabled.
            # These are declarative bindings, including Poseidon's disabled btnBack param.
            if cls == 'XLuaParam_GO':
                n['binding'] = c.get('key') or go['m_Name']
                continue
            if c.get('m_Enabled', 1) == 0: continue
            if cls == 'XLuaMono': n['lua'] = c['luaFile']
            elif cls in ('ButtonCallLua', 'ClickCallLua'):
                n['click'] = c.get('funcName') or c.get('funcNameOnClick')
                n['clickInterval'] = c.get('clickSpaceTime', 0) / 1000
            elif cls == 'Image':
                sprite = c.get('m_Sprite', {})
                component_id = component_ids[id(c)]
                n['imageMeta'] = cross_images.get(component_id) or (images.get(str(sprite.get('m_PathID'))) if not sprite.get('m_FileID') else None)
                if sprite.get('m_PathID') and not n['imageMeta']:
                    unsupported.append({'kind':'sprite-reference','node':n['name'],'reference':sprite})
                if c.get('m_Material',{}).get('m_PathID'):
                    n['material'] = export_material(c['m_Material'], objects, source, folder, cache, sprite)
                    if not n['material']['supported']:
                        unsupported.append({'kind':'material','node':n['name'],'reference':c['m_Material'], 'reason':n['material']['reason']})
                n['image'] = (n['imageMeta'] or {}).get('url')
                n['imageType'] = c.get('m_Type',0)
                n['preserveAspect'] = bool(c.get('m_PreserveAspect'))
                n['fillClockwise'] = bool(c.get('m_FillClockwise',1))
                n['fillCenter'] = bool(c.get('m_FillCenter',1))
                n['ppuMultiplier'] = c.get('m_PixelsPerUnitMultiplier',1)
                n['color'] = c.get('m_Color'); n['fill'] = c.get('m_FillAmount', 1)
                n['filled'] = c.get('m_Type') == 3
                n['fillMethod'] = c.get('m_FillMethod', 0); n['fillOrigin'] = c.get('m_FillOrigin', 0)
            elif cls == 'Mask': n['mask'] = {'showGraphic':bool(c.get('m_ShowMaskGraphic',1))}
            elif cls == 'RectMask2D': n['rectMask'] = True
            elif cls == 'ContentSizeFitter': n['fitter'] = {'x':c['m_HorizontalFit'],'y':c['m_VerticalFit']}
            elif cls == 'Text': n['text'] = c.get('m_Text', ''); n['fontSize'] = c.get('m_FontData', {}).get('m_FontSize', 24)
            elif cls in ('HorizontalLayoutGroup', 'GridLayoutGroup'):
                n['layout'] = {'class': cls, **{k: v for k, v in c.items() if k not in ('m_GameObject', 'm_Script')}}
            elif cls == 'ActionFade': n['fade'] = {k:c[k] for k in ('autoPlay','delay','time','from','to','delayValue','playMode')}
        nodes[str(pid)] = n
        if go_id in animators:
            ctrl = objects.get(animators[go_id]['m_Controller']['m_PathID'])
            if ctrl:
                controller=ctrl.read_typetree()
                sm=controller['m_Controller']['m_StateMachineArray'][0]['data']
                default=sm['m_StateConstantArray'][sm['m_DefaultState']]['data']
                ci=default['m_BlendTreeConstantArray'][0]['data']['m_NodeArray'][0]['data']['m_ClipID']
                clipids=controller['m_AnimationClips']
                n['keepAnimatorState'] = bool(animators[go_id].get('m_KeepAnimatorControllerStateOnDisable',False))
                n['animatorClips']=[str(v['m_PathID']) for v in clipids]
                n['defaultClip']=str(clipids[ci]['m_PathID'])
                states=[v['data'] for v in sm['m_StateConstantArray']]
                def state_clip(s):
                    ix=s['m_BlendTreeConstantArray'][0]['data']['m_NodeArray'][0]['data']['m_ClipID']
                    return str(clipids[ix]['m_PathID'])
                n['transitions']={}
                for state in states:
                    for wrapped in state['m_TransitionConstantArray']:
                        transition=wrapped['data']
                        if transition['m_HasExitTime'] and not transition['m_ConditionConstantArray']:
                            n['transitions'][state_clip(state)]={'to':state_clip(states[transition['m_DestinationState']]),
                                'exit':transition['m_ExitTime'],'duration':transition['m_TransitionDuration'],
                                'fixedDuration':bool(transition.get('m_HasFixedDuration',True)),
                                'offset':transition.get('m_TransitionOffset',0)}
    paths={0:''}
    def visit(pid, path):
        paths[zlib.crc32(path.encode()) if path else 0]=path
        for cid in nodes[pid]['children']: visit(cid, '/'.join(filter(None,[path,nodes[cid]['name']])))
    for pid in nodes: visit(pid,'')
    clips={str(o.path_id):decode_clip(o.read_typetree(),paths) for o in env.objects if o.type.name=='AnimationClip'}
    templates = {n['name']: n['id'] for n in nodes.values() if n['parent'] not in nodes}
    result = {'model': model, 'name': name, 'nodes': nodes, 'templates': templates,
              'images': {v['name']: v['url'] for v in images.values()},
              'imageMetadata':{v['url']:v for v in images.values()}, 'clips':clips, 'version':6, 'unsupported':unsupported}
    if model == '2008006':
        native = UnityPy.load(unwrap_bundle(source / ('prefabs_spine_' + name.lower()))[2])
        result['camera'] = {o.read_typetree()['m_Name']: decode_clip(o.read_typetree(), {0:'',zlib.crc32(b'pos'):'pos'})
                            for o in native.objects if o.type.name == 'AnimationClip'}
    (folder / 'scene.json').write_text(json.dumps(result, ensure_ascii=False), encoding='utf-8')
    return result


if __name__ == '__main__':
    for mid in MODELS:
        result = extract(mid)
        print(mid, len(result['nodes']), len(result['images']), result['templates'])
