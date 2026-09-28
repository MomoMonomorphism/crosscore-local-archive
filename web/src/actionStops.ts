/** SpineTools.stopDic semantics; entry identity is owned by SpineStage. */
export type ActionEntry = { trackTime: number; timeScale: number }
export type ActionStop = { stopAt: number | null; wait: number; elapsed: number; remaining: number }

export function createActionStop(duration: number, stopPerc: number, wait: number, count = 3): ActionStop {
  return { stopAt: duration * stopPerc, wait, elapsed: 0, remaining: count }
}

export function updateActionStop(entry: ActionEntry, stop: ActionStop, deltaSeconds: number) {
  // Original Update does not clamp TrackTime, and consumes the first stop once.
  if (stop.stopAt != null && entry.trackTime >= stop.stopAt && entry.timeScale !== 0) {
    entry.timeScale = 0
    stop.stopAt = null
  }
  if (entry.timeScale === 0) {
    stop.elapsed += deltaSeconds
    if (stop.elapsed > stop.wait) entry.timeScale = 1
  }
}

export function resetActionStop(entry: ActionEntry, stop: ActionStop, duration: number, perc: number, limit: number) {
  const start = perc * duration
  if (entry.trackTime >= start && entry.trackTime <= limit * duration && stop.remaining > 0) {
    stop.remaining -= 1
    entry.trackTime = start
    entry.timeScale = 1
  }
}
