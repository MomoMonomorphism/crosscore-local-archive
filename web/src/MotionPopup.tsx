import { cloneElement, useRef, type ReactElement } from 'react'
import { useMotionPresence } from './useMotionPresence'

/** Keep only the popup's last visual content during its brief exit. Its logical
 * close is immediate: it cannot receive input or keep an accessible control. */
export function MotionPopup({ open, children }: { open: boolean; children: ReactElement }) {
  const motion = useMotionPresence(open, { enterMs: 190, exitMs: 130 })
  const last = useRef(children)
  if (open) last.current = children
  if (!motion.present) return null
  return cloneElement((open ? children : last.current) as ReactElement<Record<string, unknown>>, {
    'data-ui-motion': motion.phase,
    'data-ui-interactive': String(open),
    'aria-hidden': open ? undefined : true,
    inert: open ? undefined : '',
  })
}
