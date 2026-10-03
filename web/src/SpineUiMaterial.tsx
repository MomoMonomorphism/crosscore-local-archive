import { useEffect, useRef, useState } from 'react'
import type { UiNode } from './spineUiLayout'

export type UiMaterial = {
  name: string; shader: string; supported: boolean; reason?: string; keywords: string[];
  floats: Record<string, number>; colors: Record<string, { r: number; g: number; b: number; a: number }>;
  textures: Record<string, { url?: string; scale: { x: number; y: number }; offset: { x: number; y: number };
    wrapU?: number; wrapV?: number; filter?: number }>;
}

// Ported from the shipped D3D11 Effect/Additive and Effect/AlphaBlend programs.
// See UI_MATERIAL_REVERSE_2026-09-26.md for supported variants and boundaries.
const vertex = `#version 300 es
in vec2 position; out vec2 uv;
void main(){uv=position*.5+.5;gl_Position=vec4(position,0.,1.);}`
const fragment = `#version 300 es
precision highp float;
in vec2 uv; out vec4 result;
uniform sampler2D mainTex, maskTex, dissolveTex, noiseTex, noiseMaskTex;
uniform vec4 mainST, maskST, dissolveST, noiseST, noiseMaskST;
uniform vec4 tint, color, noiseScroll;
uniform vec4 flags; // mask, dissolve, uv scroll, distortion
uniform vec2 mainSpeed, maskSpeed, dissolveSpeed;
uniform float clockTime, glow, alphaScale, dissolve, dissolveWidth, distortion, additive;
vec2 st(vec2 p,vec4 v){return p*v.xy+v.zw;}
void main(){
 vec2 p=st(uv,mainST);
 if(flags.z>0.) p+=clockTime*mainSpeed;
 if(flags.w>0.) {
   vec2 noise=texture(noiseTex,st(uv,noiseST)+clockTime*noiseScroll.xy).rg;
   float noiseMask=texture(noiseMaskTex,st(uv,noiseMaskST)).r;
   p+=noise*noiseMask*distortion*noiseScroll.zw;
 }
 vec4 tex=texture(mainTex,p);
 vec4 v=color*tint;
 vec4 c;
 if(additive>0.) c=2.*v*tex*glow;
 else c=vec4(2.*v.rgb*tex.rgb*glow,clamp(2.*v.a*tex.a,0.,1.)*alphaScale*tex.a);
 if(flags.x>0.) {
   vec4 m=texture(maskTex,st(uv,maskST)+clockTime*maskSpeed);
   c*=vec4(m.rgb,m.r);
   c.a=clamp(c.a*m.a,0.,1.);
 }
 if(flags.y>0.) {
   float n=texture(dissolveTex,st(uv,dissolveST)+clockTime*dissolveSpeed).r;
   float edge=dissolve*(dissolveWidth+1.)-dissolveWidth;
   float q=dissolveWidth>0.?clamp((n-edge)/dissolveWidth,0.,1.):step(edge,n);
   c.a*=q*q*(3.-2.*q);
 }
 c.a=clamp(c.a,0.,1.);
 // Premultiplied source-over with alpha=0 is additive RGB, without occluding the DOM backdrop.
 // Keep contribution unclamped until multiplied by alpha (HDR source may exceed one).
 result=vec4(max(c.rgb,vec3(0.))*c.a,additive>0.?0.:c.a);
}`

export function UiMaterialImage({ node, width, height, time, disableClipping = false }: {
  node: UiNode; width: number; height: number; time: number; disableClipping?: boolean
}) {
  const container = useRef<HTMLDivElement>(null), draw = useRef<(() => void) | null>(null)
  const latest = useRef({ node, width, height, time, disableClipping });latest.current = { node, width, height, time, disableClipping }
  const [error, setError] = useState('')
  const [contextRevision, setContextRevision] = useState(0)
  const materialKey = JSON.stringify(node.material)
  useEffect(() => {
    const host = container.current, m = latest.current.node.material
    if (!host || !m) return
    setError('')
    if (!m.supported) { setError(m.reason ?? 'unsupported material');return }
    const el = document.createElement('canvas')
    el.dataset.uiMaterial = m.name
    Object.assign(el.style,{width:'100%',height:'100%',position:'absolute',inset:'0'})
    host.appendChild(el)
    const gl = el.getContext('webgl2', { alpha: true, premultipliedAlpha: true, antialias: false })
    if (!gl) { setError('WebGL2 unavailable');el.remove();return }
    let disposed = false
    const lost = (e: Event) => {e.preventDefault();if(!disposed)setError('WebGL context lost')}
    const restored = () => {if(!disposed)setContextRevision(v=>v+1)}
    el.addEventListener('webglcontextlost',lost);el.addEventListener('webglcontextrestored',restored)
    const textures: WebGLTexture[] = [], shaders: WebGLShader[] = []
    const program = gl.createProgram()!, buffer = gl.createBuffer()!
    try {
      for (const [type, source] of [[gl.VERTEX_SHADER, vertex], [gl.FRAGMENT_SHADER, fragment]] as const) {
        const shader = gl.createShader(type)!;shaders.push(shader);gl.shaderSource(shader, source);gl.compileShader(shader)
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw Error(gl.getShaderInfoLog(shader) ?? 'shader compilation')
        gl.attachShader(program, shader)
      }
      gl.linkProgram(program)
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw Error(gl.getProgramInfoLog(program) ?? 'shader link')
      gl.useProgram(program);gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1,1,-1,-1,1,-1,1,1,-1,1,1]), gl.STATIC_DRAW)
      const pos = gl.getAttribLocation(program, 'position');gl.enableVertexAttribArray(pos);gl.vertexAttribPointer(pos, 2, gl.FLOAT, false, 0, 0)
      const loc = (name: string) => gl.getUniformLocation(program, name)
      const f = (name: string, value: number) => gl.uniform1f(loc(name), value)
      const vec = (name: string, c: {r:number;g:number;b:number;a:number}) => gl.uniform4f(loc(name), c.r,c.g,c.b,c.a)
      const p = m.floats, white = {r:1,g:1,b:1,a:1}, keywords = new Set(Object.values(m.keywords))
      const enabled = (s: string) => keywords.has(s) ? 1 : 0
      gl.uniform4f(loc('flags'), enabled('_USEMASK_ON'), enabled('_USEDISSOLVE_ON'), enabled('_USEUVANI_ON'), enabled('_USEUVDISTORTION_ON'))
      vec('tint', m.colors._TintColor ?? white)
      vec('noiseScroll', m.colors._NoiseScroll ?? {r:0,g:0,b:1,a:1})
      f('additive', m.shader === 'Effect/Additive' ? 1 : 0);f('glow', p._GlowScale ?? 1);f('alphaScale', p._AlphaScale ?? 1)
      f('dissolve', p._Dissolve ?? 0);f('dissolveWidth', p._DissolveWidth ?? 0);f('distortion', p._Distortion ?? 0)
      for (const [name, x, y] of [['mainSpeed','_SpeedU','_SpeedV'],['maskSpeed','_MaskSpeedU','_MaskSpeedV'],['dissolveSpeed','_DissolveSpeedU','_DissolveSpeedV']])
        gl.uniform2f(loc(name), p[x] ?? 0, p[y] ?? 0)
      const slots = [['_MainTex','mainTex','mainST'],['_Mask','maskTex','maskST'],['_DissolveTex','dissolveTex','dissolveST'],['_UVNoiseTex','noiseTex','noiseST'],['_UVNoiseMask','noiseMaskTex','noiseMaskST']]
      const loads = slots.map(([key, sampler, stName], i) => {
        const spec = m.textures[key], tex = gl.createTexture()!;textures.push(tex)
        gl.activeTexture(gl.TEXTURE0+i);gl.bindTexture(gl.TEXTURE_2D, tex);gl.uniform1i(loc(sampler),i)
        gl.uniform4f(loc(stName),spec?.scale.x??1,spec?.scale.y??1,spec?.offset.x??0,spec?.offset.y??0)
        const wrap = (v?:number) => v === 1 ? gl.CLAMP_TO_EDGE : v === 2 ? gl.MIRRORED_REPEAT : gl.REPEAT
        gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,wrap(spec?.wrapU));gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,wrap(spec?.wrapV))
        gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,spec?.filter===0?gl.NEAREST:gl.LINEAR)
        gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,spec?.filter===0?gl.NEAREST:gl.LINEAR)
        const v = key === '_UVNoiseTex' ? 0 : 255
        gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,1,1,0,gl.RGBA,gl.UNSIGNED_BYTE,new Uint8Array([v,v,v,255]))
        if (!spec?.url) return Promise.resolve()
        return new Promise<void>((resolve,reject) => {
          const img = new Image()
          img.onload = () => { if(!disposed) {gl.activeTexture(gl.TEXTURE0+i);gl.bindTexture(gl.TEXTURE_2D,tex)
            gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL,true);gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL,false)
            gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,img)} resolve() }
          img.onerror = () => reject(Error(`texture load: ${spec.url}`));img.src=spec.url!
        })
      })
      void Promise.all(loads).then(() => {
        if(disposed) return
        draw.current = () => {
          const now=latest.current
          const w=Math.max(1,Math.ceil(now.width)), h=Math.max(1,Math.ceil(now.height))
          if(el.width!==w)el.width=w
          if(el.height!==h)el.height=h
          gl.viewport(0,0,el.width,el.height);gl.useProgram(program)
          gl.uniform4f(loc('flags'), now.disableClipping ? 0 : enabled('_USEMASK_ON'),
            now.disableClipping ? 0 : enabled('_USEDISSOLVE_ON'), enabled('_USEUVANI_ON'), enabled('_USEUVDISTORTION_ON'))
          vec('color',now.node.color??white);f('clockTime',now.time)
          gl.drawArrays(gl.TRIANGLES,0,6)
        };draw.current()
      }).catch(e => {if(!disposed)setError(String(e))})
    } catch(e) {setError(String(e))}
    return () => { disposed=true;draw.current=null
      for(const tex of textures)gl.deleteTexture(tex)
      for(const shader of shaders)gl.deleteShader(shader)
      gl.deleteBuffer(buffer);gl.deleteProgram(program)
      el.removeEventListener('webglcontextlost',lost);el.removeEventListener('webglcontextrestored',restored)
      gl.getExtension('WEBGL_lose_context')?.loseContext();el.remove()
    }
  }, [materialKey, contextRevision])
  useEffect(() => {draw.current?.()}, [time, width, height, node.color, disableClipping])
  return <><div ref={container} style={{position:'absolute',inset:0,pointerEvents:'none'}} />
    {error && <span role="alert" data-ui-material-error style={{position:'absolute',color:'#ffb347',background:'#281b24',fontSize:16}}>
      材质未还原：{node.material?.name}（{error}）</span>}</>
}
