/** Source: CardTouchItem.OnDragXY + SpineTools.PlayByDrag/Recover. */
export function gestureProgress(current: number, gesture: number, dx: number, dy: number,
  spaceScale: number, speed: number, limit: number) {
  // Viewer skeleton Y is down; Unity anchored/local Y is up.
  const x = dx * spaceScale, y = -dy * spaceScale
  const delta = gesture <= 2 ? (gesture === 1 ? -x : x) : (gesture === 3 ? y : -y)
  return Math.max(0, Math.min(limit, current + delta * speed * 0.001))
}

export function gestureRecovery(progress: number, config: { stopTime?: number; splitPerc?: number }) {
  if (config.stopTime == null || config.stopTime < 0) return null
  const split = config.splitPerc ?? 1
  return { remaining: config.stopTime, forward: split !== 1 && split - progress < 0.01 }
}

export function updateGestureRecovery(entry: { trackTime: number; timeScale: number; alpha: number },
  recovery: { remaining: number; forward: boolean }, duration: number, delta: number, body: boolean) {
  if (body && !recovery.forward) entry.alpha = Math.max(0, entry.alpha - delta / 0.2)
  recovery.remaining -= delta
  if (recovery.remaining >= 0) return false
  entry.timeScale = recovery.forward ? 1 : -1
  if (entry.trackTime >= duration || entry.trackTime <= 0) {
    entry.timeScale = 0
    entry.trackTime = 0
    return true
  }
  return false
}
