export type MotionPresenceState = { present: boolean; phase: 'enter' | 'open' | 'exit' | 'closed'; settled: boolean }
export type MotionPresenceScheduler = {
  frame: (callback: () => void) => number; cancelFrame: (id: number) => void
  delay: (callback: () => void, milliseconds: number) => number; cancelDelay: (id: number) => void
}

/** A bounded presence transition: two paint frames for entry, one completion
 * timer. Every reversal invalidates the previous generation before cancelling. */
export function createMotionPresence(notify: (state: MotionPresenceState) => void, scheduler: MotionPresenceScheduler,
  { enterMs = 190, exitMs = 130 }: { enterMs?: number; exitMs?: number } = {}) {
  let state: MotionPresenceState = { present: false, phase: 'closed', settled: true }
  let generation = 0, frame: number | null = null, timer: number | null = null, disposed = false
  const cancel = () => {
    generation++
    if (frame !== null) scheduler.cancelFrame(frame)
    if (timer !== null) scheduler.cancelDelay(timer)
    frame = timer = null
  }
  const publish = (next: MotionPresenceState) => { state = next; notify(next) }
  return {
    update(open: boolean, reducedMotion = false) {
      if (disposed) return
      cancel()
      const current = generation
      if (reducedMotion) { publish({ present: open, phase: open ? 'open' : 'closed', settled: true }); return }
      if (open) {
        if (state.phase === 'open' && state.settled) return
        // Reopening during exit keeps the existing DOM and its current visual
        // opacity. A new mount needs a painted initial state before transition.
        const mounted = state.present
        publish({ present: true, phase: mounted ? 'open' : 'enter', settled: false })
        const finishEntry = () => {
          if (disposed || current !== generation) return
          frame = null
          publish({ present: true, phase: 'open', settled: false })
          timer = scheduler.delay(() => {
            if (disposed || current !== generation) return
            timer = null; publish({ present: true, phase: 'open', settled: true })
          }, enterMs)
        }
        if (mounted) finishEntry()
        else frame = scheduler.frame(() => {
          if (disposed || current !== generation) return
          frame = scheduler.frame(finishEntry)
        })
      } else {
        if (!state.present) { publish({ present: false, phase: 'closed', settled: true }); return }
        publish({ present: true, phase: 'exit', settled: false })
        timer = scheduler.delay(() => {
          if (disposed || current !== generation) return
          timer = null; publish({ present: false, phase: 'closed', settled: true })
        }, exitMs)
      }
    },
    current: () => state,
    dispose() { cancel(); disposed = true },
  }
}
