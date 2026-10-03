type CollapseOptions = { reducedMotion?: boolean; fromOpacity?: number; onComplete: () => void; releaseMeasure?: () => void }

/** Measure just the two endpoints of a user toggle. The positioning root never
 * receives a transform, and no animation callback measures per-frame geometry. */
export function animateDeveloperCollapse(shell: HTMLElement, content: HTMLElement, fromHeight: number, collapsed: boolean,
  { reducedMotion = false, fromOpacity, onComplete, releaseMeasure = () => {} }: CollapseOptions) {
  let finished = false
  const animations: Animation[] = []
  const originalOverflow = shell.style.overflow
  const complete = (notify: boolean) => {
    if (finished) return
    finished = true
    // Hide before cancelling fill, so a collapsed body's natural height cannot
    // flash between animation completion and React's batched state commit.
    if (collapsed) content.hidden = true
    for (const animation of animations) { animation.onfinish = null; animation.oncancel = null; animation.cancel() }
    shell.style.overflow = originalOverflow
    if (notify) onComplete()
    releaseMeasure()
  }
  try {
    content.hidden = false
    let targetHeight: number
    if (collapsed) {
      content.hidden = true; targetHeight = shell.getBoundingClientRect().height; content.hidden = false
    } else targetHeight = shell.getBoundingClientRect().height
    if (reducedMotion || typeof shell.animate !== 'function' || !Number.isFinite(fromHeight) || !Number.isFinite(targetHeight)
      || Math.abs(fromHeight - targetHeight) < .5) { complete(true); return () => complete(false) }
    shell.style.overflow = 'hidden'
    const options: KeyframeAnimationOptions = { duration: 190, easing: 'cubic-bezier(.2,.7,.25,1)', fill: 'both' }
    const height = shell.animate([{ height: `${fromHeight}px` }, { height: `${targetHeight}px` }], options)
    animations.push(height)
    const opacity = fromOpacity !== undefined && Number.isFinite(fromOpacity) ? Math.max(0, Math.min(1, fromOpacity)) : collapsed ? 1 : 0
    if (typeof content.animate === 'function') animations.push(content.animate([{ opacity }, { opacity: collapsed ? 0 : 1 }],
      { duration: collapsed ? 130 : 190, easing: 'ease-out', fill: 'both' }))
    height.onfinish = () => complete(true)
    height.oncancel = () => complete(true)
  } catch { complete(true) }
  return () => complete(false)
}
