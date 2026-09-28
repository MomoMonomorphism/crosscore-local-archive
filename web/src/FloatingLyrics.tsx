import { useLayoutEffect, useRef, type PointerEvent } from 'react'

/** Drag the whole subtitle box; passthrough is an explicit toolbar option. */
export function FloatingLyrics({ visible, text, passthrough, resetSerial }: { visible: boolean; text: string; passthrough: boolean; resetSerial: number }) {
  const box = useRef<HTMLDivElement>(null)
  // Position in the available travel area, preserved between lines and viewport changes.
  const position = useRef({ x: .5, y: 1 })
  const drag = useRef<{ id: number; x: number; y: number; left: number; top: number } | null>(null)
  const bounds = () => {
    const element = box.current, parent = element?.parentElement
    if (!element || !parent) return null
    return { x: Math.max(0, parent.clientWidth - element.offsetWidth - 24),
      y: Math.max(0, parent.clientHeight - element.offsetHeight - 24) }
  }
  const place = () => {
    const size = bounds(), element = box.current
    if (!size || !element) return
    element.style.left = `${12 + position.current.x * size.x}px`
    element.style.top = `${12 + position.current.y * size.y}px`
  }
  const move = (left: number, top: number) => {
    const size = bounds()
    if (!size) return
    position.current = {
      x: size.x ? Math.max(0, Math.min(1, (left - 12) / size.x)) : .5,
      y: size.y ? Math.max(0, Math.min(1, (top - 12) / size.y)) : 1,
    }
    place()
  }
  useLayoutEffect(() => {
    drag.current = null
    if (!visible || !text || !box.current) return
    place()
    const observer = new ResizeObserver(place)
    observer.observe(box.current)
    if (box.current.parentElement) observer.observe(box.current.parentElement)
    return () => observer.disconnect()
  }, [visible, text])
  useLayoutEffect(() => {
    position.current = { x: .5, y: 1 }; place()
  }, [resetSerial])
  useLayoutEffect(() => { drag.current = null }, [passthrough])
  const end = (event: PointerEvent<HTMLDivElement>) => {
    event.stopPropagation()
    if (drag.current?.id === event.pointerId) drag.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
  }
  return <div ref={box} className={`gallery-floating-lyric ${passthrough ? 'lyric-passthrough' : 'lyric-draggable'}`} hidden={!visible || !text}
      tabIndex={passthrough ? -1 : 0} aria-label="移动台词框" title={passthrough ? undefined : "拖动字幕框移动 · 双击复位 · 方向键微调"}
      onPointerDown={event => {
        if (passthrough || event.button !== 0 || drag.current || !box.current) return
        event.preventDefault(); event.stopPropagation()
        drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY,
          left: box.current.offsetLeft, top: box.current.offsetTop }
        event.currentTarget.setPointerCapture(event.pointerId)
      }}
      onPointerMove={event => {
        const start = drag.current
        if (!start || start.id !== event.pointerId) return
        event.preventDefault(); event.stopPropagation()
        move(start.left + event.clientX - start.x, start.top + event.clientY - start.y)
      }} onPointerUp={end} onPointerCancel={end} onLostPointerCapture={() => { drag.current = null }}
      onClick={event => event.stopPropagation()}
      onDoubleClick={event => { event.stopPropagation(); position.current = { x: .5, y: 1 }; place() }}
      onKeyDown={event => {
        if (passthrough || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home'].includes(event.key) || !box.current) return
        event.preventDefault(); event.stopPropagation()
        if (event.key === 'Home') { position.current = { x: .5, y: 1 }; place(); return }
        const step = event.shiftKey ? 40 : 10
        move(box.current.offsetLeft + (event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0),
          box.current.offsetTop + (event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0))
      }}>
    <span role="status" aria-label="画布台词">{text}</span>
  </div>
}
