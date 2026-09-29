import { useRef, useState } from 'react'
import { useViewAdjustment, useViewReset, usePinchZoom } from './ImmersiveMode'
import type { CharacterPortrait } from './types'
import { sitePath } from './sitePaths'
import { hitStaticPicture, type StaticPictureTouch } from './staticPictureTouch'
import { ResourceLoadingNotice } from './ResourceLoadingNotice'

export default function CharacterPortraitStage(props: {
  portrait: CharacterPortrait; flipped: boolean; zoom: number
  pan: { x: number; y: number }; onPan: (pan: { x: number; y: number }) => void
  onZoom: (zoom: number) => void
  onTouch: (row: StaticPictureTouch) => void
}) {
  return <PortraitSession key={`${props.portrait.modelId}:${props.portrait.url}`} {...props}/>
}

function PortraitSession({ portrait, flipped, zoom, pan, onPan, onZoom, onTouch }: Parameters<typeof CharacterPortraitStage>[0]) {
  const viewControl = useViewAdjustment()
  const pinch = usePinchZoom(ratio => onZoom(Math.max(.25, Math.min(4, zoom * ratio))))
  useViewReset(() => { onZoom(1); onPan({ x: 0, y: 0 }) })
  const image = useRef<HTMLImageElement>(null)
  const drag = useRef<{ x: number; y: number; pan: { x: number; y: number }; moved: boolean } | null>(null)
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [attempt, setAttempt] = useState(0)
  const source = sitePath(portrait.url)
  const url = attempt ? `${source}${source.includes('?') ? '&' : '?'}portraitRetry=${attempt}` : source
  return <div aria-busy={state === 'loading'} style={{ position: 'absolute', inset: 0, overflow: 'hidden', touchAction: 'none' }}
    onWheel={(event) => { if (viewControl.allowed) onZoom(Math.max(.25, Math.min(4, zoom * (event.deltaY > 0 ? .9 : 1.1)))) }}
    onPointerDown={(event) => { if (state !== 'ready') return; if (pinch.down(event)) { if (drag.current) drag.current.moved = true; return }; drag.current = { x: event.clientX, y: event.clientY, pan, moved: false }; event.currentTarget.setPointerCapture(event.pointerId) }}
    onPointerMove={(event) => {
      if (pinch.move(event)) return
      const start = drag.current
      if (!start || !event.buttons) return
      const x = event.clientX - start.x, y = event.clientY - start.y
      if (Math.hypot(x, y) > 5) start.moved = true
      if (start.moved && viewControl.allowed) onPan({ x: start.pan.x + x, y: start.pan.y + y })
    }}
    onPointerUp={(event) => {
      if (pinch.up(event)) { drag.current = null; return }
      const start = drag.current
      drag.current = null
      const img = image.current
      if (state !== 'ready' || !img || !start || start.moved) return
      const box = img.getBoundingClientRect()
      const x = flipped ? box.left + box.right - event.clientX : event.clientX
      const hit = hitStaticPicture(img, x, event.clientY, portrait.touches)
      if (hit) onTouch(hit)
    }} onPointerCancel={(event) => { pinch.up(event); drag.current = null }}>
    <img key={url} ref={image} src={url} alt={portrait.label} draggable={false}
      style={{ width: '100%', height: '100%', objectFit: 'contain', opacity: state === 'ready' ? 1 : 0, transform: `translate(${pan.x}px, ${pan.y}px) scale(${flipped ? -zoom : zoom}, ${zoom})` }}
      onLoad={(event) => setState(event.currentTarget.naturalWidth > 0 ? 'ready' : 'error')}
      onError={() => setState('error')}/>
    {state === 'loading' && <ResourceLoadingNotice title="正在加载立绘"/>}
    {state === 'error' && <div className="error-state" role="alert">
      <strong>立绘加载失败</strong><span>图片未能载入，请检查网络连接后重试。</span>
      <button onClick={() => { drag.current = null; setState('loading'); setAttempt(value => value + 1) }}>重新载入</button>
    </div>}
    <div hidden={viewControl.active || state !== 'ready'} style={{ position: 'absolute', bottom: 12, left: 16, pointerEvents: 'none', color: '#ddd', background: '#15181ccc', padding: '6px 10px' }}>
      {`静态原图 · 完整透明画布${portrait.touches.length ? ' · 点击配置区域播放语音' : ''}`}
    </div>
  </div>
}
