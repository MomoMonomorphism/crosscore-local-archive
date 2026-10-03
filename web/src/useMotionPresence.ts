import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createMotionPresence, type MotionPresenceState } from './motionPresence'
import { createWindowMotionScheduler } from './windowMotionScheduler'

export function useReducedMotion() {
  const [reduced, setReduced] = useState(() => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches)
  useEffect(() => {
    if (typeof matchMedia !== 'function') return
    const query = matchMedia('(prefers-reduced-motion: reduce)')
    const update = () => setReduced(query.matches)
    update(); query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [])
  return reduced
}

/** Render while present. During exit, callers must immediately mark their
 * logical closed content inert and aria-hidden; animation never owns input. */
export function useMotionPresence(open: boolean, options: { enterMs?: number; exitMs?: number } = {}) {
  const reducedMotion = useReducedMotion()
  const [state, setState] = useState<MotionPresenceState>({ present: false, phase: 'closed', settled: true })
  const controllerRef = useRef<ReturnType<typeof createMotionPresence> | null>(null)
  const { enterMs = 190, exitMs = 130 } = options
  useLayoutEffect(() => {
    const controller = createMotionPresence(setState, createWindowMotionScheduler(window), { enterMs, exitMs })
    controllerRef.current = controller
    return () => { controller.dispose(); controllerRef.current = null }
  }, [enterMs, exitMs])
  useLayoutEffect(() => { controllerRef.current?.update(open, reducedMotion) }, [open, reducedMotion, enterMs, exitMs])
  // The render caused by a user action already excludes input, before effects.
  const present = reducedMotion ? open : open || state.present
  const phase = reducedMotion ? open ? 'open' : 'closed' : !open && present ? 'exit' : open && !state.present ? 'enter' : state.phase
  return { present, phase, settled: reducedMotion || (state.settled && (open ? state.phase === 'open' : !state.present)), reducedMotion }
}
