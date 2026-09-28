export type DeadlineClock = {
  now: () => number
  set: (callback: () => void, delayMs: number) => number
  clear: (id: number) => void
}

/** Timers may wake before a fractional performance.now deadline. Keep checking
 * until it is due, as the source Lua Update does, without changing the deadline. */
export function scheduleDeadline(deadline: number, fire: (now: number) => void, clock: DeadlineClock = {
  now: () => performance.now(),
  set: (callback, delay) => window.setTimeout(callback, delay),
  clear: id => window.clearTimeout(id),
}): () => void {
  let cancelled = false, timer = 0
  const check = () => {
    if (cancelled) return
    const now = clock.now()
    if (now < deadline) { arm(now); return }
    cancelled = true
    fire(now)
  }
  const arm = (now: number) => {
    timer = clock.set(check, Math.max(1, Math.ceil(deadline - now)))
  }
  arm(clock.now())
  return () => { cancelled = true; clock.clear(timer) }
}
