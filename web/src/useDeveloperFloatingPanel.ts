import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'

/** Each tool window owns its position; resizing and collapsing one cannot move
 * the other. Dragging is restricted to non-interactive parts of its header. */
export function useDeveloperFloatingPanel(open: boolean, collapsed: boolean) {
  const ref = useRef<HTMLElement>(null)
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null)
  const [viewport, setViewport] = useState(() => ({ width: window.innerWidth, height: window.innerHeight }))
  const drag = useRef<{ pointerId: number; x: number; y: number; left: number; top: number; target: HTMLElement } | null>(null)
  const measurementPauses = useRef(0)
  const clampRef = useRef<(() => void) | null>(null)
  const cancelDrag = () => {
    const current = drag.current
    drag.current = null
    if (current) try { if (current.target.hasPointerCapture(current.pointerId)) current.target.releasePointerCapture(current.pointerId) } catch { /* Window closed. */ }
  }
  useEffect(() => {
    const resize = () => setViewport({ width: window.innerWidth, height: window.innerHeight })
    window.addEventListener('resize', resize)
    return () => window.removeEventListener('resize', resize)
  }, [])
  useEffect(() => { if (!open) cancelDrag(); return cancelDrag }, [open])
  useLayoutEffect(() => {
    if (!open || !ref.current) return
    const panel = ref.current
    const clamp = () => { if (measurementPauses.current) return; setPosition(current => {
      const bounds = panel.getBoundingClientRect()
      const point = current ?? { x: bounds.left, y: bounds.top }
      const x = Math.max(0, Math.min(Math.max(0, viewport.width - panel.offsetWidth - 8), point.x))
      const y = Math.max(0, Math.min(Math.max(0, viewport.height - panel.offsetHeight - 12), point.y))
      return x === point.x && y === point.y ? current : { x, y }
    }) }
    clampRef.current = clamp
    clamp()
    const observer = new ResizeObserver(clamp)
    observer.observe(panel)
    return () => { observer.disconnect(); if (clampRef.current === clamp) clampRef.current = null }
  }, [open, collapsed, viewport.width, viewport.height])
  const stopDrag = (event: ReactPointerEvent<HTMLElement>) => {
    if (drag.current?.pointerId !== event.pointerId) return
    cancelDrag()
  }
  return { ref, cancelDrag,
    pauseMeasure: () => {
      measurementPauses.current++
      let released = false
      return () => { if (released) return; released = true; measurementPauses.current--; if (!measurementPauses.current) clampRef.current?.() }
    },
    style: { ...(position ? { left: position.x, top: position.y, right: 'auto' } : {}),
      maxHeight: Math.max(110, viewport.height - (viewport.width <= 1100 ? 72 : 92)) },
    headerEvents: {
      onPointerDown: (event: ReactPointerEvent<HTMLElement>) => {
        if (!open || !event.isPrimary || (event.target as HTMLElement).closest('button,a,input,select,textarea,label,summary,[role="button"],[contenteditable]') || event.button !== 0) return
        const bounds = ref.current?.getBoundingClientRect()
        if (!bounds) return
        drag.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, left: bounds.left, top: bounds.top, target: event.currentTarget }
        try { event.currentTarget.setPointerCapture(event.pointerId) } catch { drag.current = null; return }
        event.preventDefault()
      },
      onPointerMove: (event: ReactPointerEvent<HTMLElement>) => {
        const current = drag.current, panel = ref.current
        if (!current || !panel || current.pointerId !== event.pointerId) return
        setPosition({ x: Math.max(0, Math.min(Math.max(0, window.innerWidth - panel.offsetWidth - 8), current.left + event.clientX - current.x)),
          y: Math.max(0, Math.min(Math.max(0, window.innerHeight - panel.offsetHeight - 12), current.top + event.clientY - current.y)) })
      },
      onPointerUp: stopDrag, onPointerCancel: stopDrag, onLostPointerCapture: stopDrag,
    },
  }
}
