"""Extract draggable UI images and source transforms from the actual prefab."""
import hashlib
import json
from pathlib import Path


def extract_drag_hosts(pack: Path, rows: list, cache: Path):
    import UnityPy
    from asset_cache import unwrap_bundle
    env = UnityPy.load(unwrap_bundle(pack)[2])
    objects = {o.path_id:o for o in env.objects}
    gos, rects, components = {}, {}, {}
    for obj in objects.values():
        if obj.type.name not in ['GameObject','RectTransform','MonoBehaviour']: continue
        try: data=obj.read_typetree()
        except Exception: continue
        if obj.type.name=='GameObject': gos[obj.path_id]=data
        elif obj.type.name=='RectTransform': rects[obj.path_id]=data
        else: components.setdefault(data.get('m_GameObject',{}).get('m_PathID'),[]).append(data)
    name = lambda r: gos.get(r['m_GameObject']['m_PathID'],{}).get('m_Name')
    pos_id = next(pid for pid,r in rects.items() if name(r)=='pos')
    children = {name(r):(pid,r) for pid,r in rects.items() if r['m_Father']['m_PathID']==pos_id}
    main = children['main'][1]
    scale=main['m_LocalScale']['x']; mx=main['m_AnchoredPosition']['x']; my=main['m_AnchoredPosition']['y']
    pos_scale=rects[pos_id]['m_LocalScale']['x']
    folder=pack.name.removeprefix('prefabs_spine_')
    def rect_size(r):
        parent=rects.get(r['m_Father']['m_PathID'])
        parent_size=rect_size(parent) if parent else {'x':0,'y':0}
        return {axis:r['m_SizeDelta'][axis]+parent_size[axis]*(r['m_AnchorMax'][axis]-r['m_AnchorMin'][axis]) for axis in ['x','y']}
    def local_position(r):
        # anchoredPosition is relative to the anchor reference, not the parent's
        # pivot. This matters for Atum's SoftMask (pivot.x = 0.1).
        parent=rects.get(r['m_Father']['m_PathID'])
        if not parent: return r['m_AnchoredPosition']
        size=rect_size(parent)
        return {axis:r['m_AnchoredPosition'][axis]+size[axis]*(
            r['m_AnchorMin'][axis]+(r['m_AnchorMax'][axis]-r['m_AnchorMin'][axis])*r['m_Pivot'][axis]
            -parent['m_Pivot'][axis]) for axis in ['x','y']}
    main_position=local_position(main);mx=main_position['x'];my=main_position['y']
    def geometry(r):
        p=local_position(r);q=r['m_LocalRotation'];s=r['m_LocalScale'];size=rect_size(r)
        return {'x':(p['x']-mx)/scale, 'y':-(p['y']-my)/scale,
                'a':(1-2*(q['y']**2+q['z']**2))*s['x']/scale,
                'b':-2*(q['x']*q['y']+q['z']*q['w'])*s['x']/scale,
                'c':-2*(q['x']*q['y']-q['z']*q['w'])*s['y']/scale,
                'd':(1-2*(q['x']**2+q['z']**2))*s['y']/scale,
                'width':size['x'],'height':size['y'],
                'pivotX':r['m_Pivot']['x'],'pivotY':1-r['m_Pivot']['y']}
    results={}
    for row in rows:
        drag=row['content'].get('drag')
        if not drag: continue
        obj_name=drag['targetObjName']
        _,r=children[obj_name]
        host={'sourcePack':pack.name,'object':obj_name,**geometry(r),
              'distanceScale':abs(scale*pos_scale),'targets':[]}
        comps=components.get(r['m_GameObject']['m_PathID'],[])
        pointer=next((c[k] for c in comps for k in ['m_Sprite','_sprite'] if c.get(k,{}).get('m_PathID')),None)
        if not pointer or pointer['m_FileID']!=0: raise ValueError(f'Unresolved sprite: {pack.name}/{obj_name}')
        sprite=objects[pointer['m_PathID']].read()
        image=sprite.image
        digest=hashlib.sha256(image.tobytes()).hexdigest()[:12]
        relative=f'drag/{folder}/{obj_name}_{digest}.png'
        path=cache/relative;path.parent.mkdir(parents=True,exist_ok=True);image.save(path)
        host['image']=relative
        # Child Image layers (e.g. Atum's phone bezel) are independent of the
        # SoftMask sprite; retaining only the mask loses actual prefab artwork.
        host['overlays'] = []
        for child_id, child in rects.items():
            if child['m_Father']['m_PathID'] != children[obj_name][0]: continue
            child_components = components.get(child['m_GameObject']['m_PathID'], [])
            image_component = next((c for c in child_components if c.get('m_Sprite', {}).get('m_PathID')), None)
            if not image_component: continue
            pointer = image_component['m_Sprite']
            if pointer['m_FileID'] != 0: raise ValueError('Unresolved drag child image')
            child_image = objects[pointer['m_PathID']].read().image
            child_path = f'drag/{folder}/{name(child)}_{hashlib.sha256(child_image.tobytes()).hexdigest()[:12]}.png'
            child_image.save(cache / child_path)
            p = local_position(child); size = rect_size(child)
            fade = next((c for c in child_components if 'autoPlay' in c and 'from' in c and 'to' in c), None)
            host['overlays'].append({'image': child_path, 'x': p['x'], 'y': -p['y'],
                'width': size['x'], 'height': size['y'], 'scaleX': child['m_LocalScale']['x'], 'scaleY': child['m_LocalScale']['y'],
                'pivotX': child['m_Pivot']['x'], 'pivotY': 1-child['m_Pivot']['y'],
                'fade': {'delay':fade['delay']/1000,'duration':fade['time']/1000,'from':fade['from'],'to':fade['to']} if fade else None})
        if drag.get('hideSpine'):
            def multiply(a,b):
                return [a[0]*b[0]+a[2]*b[1],a[1]*b[0]+a[3]*b[1],
                        a[0]*b[2]+a[2]*b[3],a[1]*b[2]+a[3]*b[3],
                        a[0]*b[4]+a[2]*b[5]+a[4],a[1]*b[4]+a[3]*b[5]+a[5]]
            node=pos_id
            for part in drag['hideSpine'].split('/')+['pos','main']:
                node=next(pid for pid,rt in rects.items() if rt['m_Father']['m_PathID']==node and name(rt)==part)
            chain=[];cursor=node
            while cursor!=pos_id:
                rt=rects[cursor]; geo=geometry(rt)
                # Undo main-space normalization to obtain a local matrix.
                chain.insert(0,[geo['a']*scale,geo['b']*scale,geo['c']*scale,geo['d']*scale,
                                geo['x']*scale+mx,geo['y']*scale-my])
                cursor=rt['m_Father']['m_PathID']
            matrix=[1/scale,0,0,1/scale,-mx/scale,my/scale]
            for local in chain: matrix=multiply(matrix,local)
            wanted=drag['hideSpine'].split('/')[-1].removesuffix('_spine')
            gallery=json.loads((cache/'assets.generated.json').read_text('utf-8'))
            asset=next(v['main'] for e in gallery['entries'] for v in e['variants']
                       if v['main']['folder']==folder and v['main']['sourceName']==wanted)
            host['nested']={'asset':asset,'matrix':matrix,'idle':next((c['startingAnimation'] for c in components.get(rects[node]['m_GameObject']['m_PathID'],[]) if c.get('startingAnimation')),'idle1')}
        for target in drag.get('targetPosObjNames',[]):
            target_name,animation=target.split('_',1)
            _,target_rect=children[target_name]
            geo=geometry(target_rect)
            host['targets'].append({'name':target_name,'animation':animation,'x':geo['x'],'y':geo['y']})
        results[row['index']]=host
    return results


def enrich_drag_hosts(payload, source, cache):
    for mid, rows in payload['models'].items():
        for role,pose in payload['poses'][mid]['poses'].items():
            targets=[r for r in rows if str(r.get('role') or 1)==role and r['content'].get('drag')]
            if not targets: continue
            pack=source/('prefabs_spine_'+pose['l2dName'].lower())
            hosts=extract_drag_hosts(pack,targets,cache)
            for row in targets: row['dragHost']=hosts[row['index']]
    return payload
