import type { MotionPresenceScheduler } from './motionPresence'

type MotionWindow = Pick<Window, 'requestAnimationFrame' | 'cancelAnimationFrame' | 'setTimeout' | 'clearTimeout'>

/** Window APIs require their original receiver. Storing the bare methods in a
 * scheduler would call them with the scheduler as `this` and throw in browsers. */
export function createWindowMotionScheduler(owner: MotionWindow): MotionPresenceScheduler {
  return {
    frame: callback => owner.requestAnimationFrame(callback),
    cancelFrame: id => owner.cancelAnimationFrame(id),
    delay: (callback, milliseconds) => owner.setTimeout(callback, milliseconds),
    cancelDelay: id => owner.clearTimeout(id),
  }
}
