import { useRef, useState } from 'react'
import { useViewAdjustment, useViewReset, usePinchZoom } from './ImmersiveMode'
import type { CharacterPortrait } from './types'
import { sitePath } from './sitePaths'
import { hitStaticPicture, type StaticPictureTouch } from './staticPictureTouch'

export default function CharacterPortraitStage({ portrait, flipped, zoom, pan, onPan, onZoom, onTouch }: {
  portrait: CharacterPortrait; flipped: boolean; zoom: number
  pan: { x: number; y: number }; onPan: (pan: { x: number; y: number }) => void
  onZoom: (zoom: number) => void
  onTouch: (row: StaticPictureTouch) => void
}) {
  const viewControl = useViewAdjustment()
  const pinch = usePinchZoom(ratio => onZoom(Math.max(.25, Math.min(4, zoom * ratio))))
  useViewReset(() => { onZoom(1); onPan({ x: 0, y: 0 }) })
  const image = useRef<HTMLImageElement>(null)
  const drag = useRef<{ x: number; y: number; pan: { x: number; y: number }; moved: boolean } | null>(null)
  const [error, setError] = useState('')
  return <div style={{ position: 'absolute', inset: 0, overflow: 'hidden', touchAction: 'none' }}
    onWheel={(event) => { if (viewControl.allowed) onZoom(Math.max(.25, Math.min(4, zoom * (event.deltaY > 0 ? .9 : 1.1)))) }}
    onPointerDown={(event) => { if (pinch.down(event)) { if (drag.current) drag.current.moved = true; return }; drag.current = { x: event.clientX, y: event.clientY, pan, moved: false }; event.currentTarget.setPointerCapture(event.pointerId) }}
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
      if (!img || !start || start.moved) return
      const box = img.getBoundingClientRect()
      const x = flipped ? box.left + box.right - event.clientX : event.clientX
      const hit = hitStaticPicture(img, x, event.clientY, portrait.touches)
      if (hit) onTouch(hit)
    }} onPointerCancel={(event) => { pinch.up(event); drag.current = null }}>
    <img ref={image} src={sitePath(portrait.url)} alt={portrait.label} draggable={false}
      style={{ width: '100%', height: '100%', objectFit: 'contain', transform: `translate(${pan.x}px, ${pan.y}px) scale(${flipped ? -zoom : zoom}, ${zoom})` }}
      onError={() => setError('静态立绘加载失败，请检查本地资源与服务日志')}
      />
    <div hidden={viewControl.active && !error} style={{ position: 'absolute', bottom: 12, left: 16, pointerEvents: 'none', color: '#ddd', background: '#15181ccc', padding: '6px 10px' }}>
      {error || `静态原图 · 完整透明画布${portrait.touches.length ? ' · 点击配置区域播放语音' : ''}`}
    </div>
  </div>
}
