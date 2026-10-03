import { useLayoutEffect, useRef, useState } from 'react'
import { animateDeveloperCollapse } from './developerCollapseMotion'

export function useDeveloperCollapseMotion(collapsed: boolean, open: boolean, reducedMotion: boolean,
  pauseMeasure: () => () => void) {
  const shellRef = useRef<HTMLDivElement>(null), contentRef = useRef<HTMLDivElement>(null)
  const [retained, setRetained] = useState(!collapsed)
  const [animating, setAnimating] = useState(false)
  const preparation = useRef<{ height: number; opacity: number; release: () => void } | null>(null)
  const cancel = useRef<(() => void) | null>(null)
  const captureToggle = () => {
    // Capture the rendered height before cancelling an interrupted transition.
    const height = shellRef.current?.getBoundingClientRect().height ?? 0
    const content = contentRef.current
    const opacity = !content || content.hidden ? 0 : Number.parseFloat(getComputedStyle(content).opacity)
    cancel.current?.(); cancel.current = null
    preparation.current?.release()
    preparation.current = { height, opacity, release: pauseMeasure() }
    setRetained(true)
    setAnimating(true)
  }
  useLayoutEffect(() => {
    const prepared = preparation.current
    preparation.current = null
    if (!open || !prepared || !shellRef.current || !contentRef.current) {
      prepared?.release(); setRetained(!collapsed); setAnimating(false)
      return
    }
    let cancelled = false
    cancel.current = animateDeveloperCollapse(shellRef.current, contentRef.current, prepared.height, collapsed, {
      reducedMotion, fromOpacity: prepared.opacity, releaseMeasure: prepared.release,
      onComplete: () => { if (!cancelled) { setRetained(!collapsed); setAnimating(false) } },
    })
    return () => { cancelled = true; cancel.current?.(); cancel.current = null }
  }, [collapsed, open, reducedMotion])
  useLayoutEffect(() => () => { cancel.current?.(); preparation.current?.release() }, [])
  return { shellRef, contentRef, contentPresent: !collapsed || retained, animating, captureToggle }
}
