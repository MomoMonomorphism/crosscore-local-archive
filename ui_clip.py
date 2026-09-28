"""Read shipped Unity streamed/dense/constant curves without reconstructing keyframes."""
import math
import struct
import zlib

PROPS = {zlib.crc32(n.encode()): n for n in (
    'm_AnchoredPosition.x','m_AnchoredPosition.y','m_SizeDelta.x','m_SizeDelta.y',
    'm_Color.r','m_Color.g','m_Color.b','m_Color.a','m_IsActive','m_FillAmount','m_Alpha',
    'm_LocalPosition.x','m_LocalPosition.y','m_LocalPosition.z')}


def decode_clip(d, paths, renderer_colors=()):
    muscle = d.get('m_MuscleClip', {})
    data = muscle.get('m_Clip', {}).get('data', {})
    stream = data.get('m_StreamedClip', {})
    dense = data.get('m_DenseClip', {})
    raw = struct.pack('<' + 'I' * len(stream.get('data', [])), *stream.get('data', []))
    keys = {}; offset = 0
    while offset + 8 <= len(raw):
        t, count = struct.unpack_from('<fI', raw, offset);offset += 8
        for _ in range(count):
            index, a, b, c, v = struct.unpack_from('<Iffff', raw, offset);offset += 20
            if not math.isfinite(t): continue
            if t < 0: t=-1;a=b=c=0
            keys.setdefault(index, []).append([t,a,b,c,v])
    stream_count = stream.get('curveCount', 0)
    dense_count = dense.get('m_CurveCount', 0)
    samples = dense.get('m_SampleArray', [])
    rate = dense.get('m_SampleRate', 60) or 60
    for channel in range(dense_count):
        values = samples[channel::dense_count]
        keys[stream_count+channel] = [[dense.get('m_BeginTime', 0)+i/rate,0,0,
            (values[i+1]-v)*rate if i+1<len(values) else 0,v] for i,v in enumerate(values)]
    for i,v in enumerate(data.get('m_ConstantClip', {}).get('data', [])):
        keys[stream_count+dense_count+i] = [[0,0,0,0,v]]
    # Renderer customType 22 color bindings store channel in bits 28..31 and
    # the shader property CRC in the low 28 bits. Resolve only supplied names;
    # preserve target type so a renderer tint never becomes a UI Image color.
    color_bindings = {}
    for name in renderer_colors:
        for channel, axis in enumerate('rgba'):
            attr = (zlib.crc32(name.encode()) & 0x0fffffff) | ((4 + channel) << 28)
            if attr in color_bindings and color_bindings[attr] != (name, axis):
                raise ValueError('ambiguous renderer color binding')
            color_bindings[attr] = (name, axis)
    index = 0; curves = []; unsupported=[]; material_curves=[]
    for b in d.get('m_ClipBindingConstant', {}).get('genericBindings', []):
        attr=b['attribute'];typ=b['typeID']
        size = (4 if attr==2 else 3) if typ==4 and attr in (1,2,3,4) else 1
        prop = {1:'position',2:'quaternion',3:'scale',4:'euler'}.get(attr) if typ==4 else PROPS.get(attr)
        path = paths.get(b['path'])
        color = color_bindings.get(attr) if typ in (23, 199) and b.get('customType') == 22 else None
        if color and path is not None:
            material_curves.append({'path': path, 'rendererType': typ, 'property': color[0],
                                    'channel': color[1], 'binding': b,
                                    'channels': [keys.get(index, [])]})
        elif prop and path is not None:
            curves.append({'path':path,'property':prop,'channels':[keys.get(index+i,[]) for i in range(size)]})
        else: unsupported.append(b)
        index += size
    return {'name':d['m_Name'],'duration':muscle.get('m_StopTime',0), 'loop':muscle.get('m_LoopTime',False),
            'curves':curves,'unsupported':unsupported, 'materialCurves': material_curves}
