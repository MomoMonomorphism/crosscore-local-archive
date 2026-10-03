import assert from 'node:assert/strict'
import { createMotionPresence, type MotionPresenceState } from './src/motionPresence.ts'
import { createWindowMotionScheduler } from './src/windowMotionScheduler.ts'

let nextId = 0
const frames = new Map<number, () => void>(), timers = new Map<number, { callback: () => void; milliseconds: number }>()
const calls: string[] = []
const requireReceiver = (receiver: unknown, name: string) => {
  if (receiver !== owner) throw new TypeError(`Illegal invocation: ${name}`)
  calls.push(name)
}
const owner = {
  requestAnimationFrame(callback: () => void) {
    requireReceiver(this, 'requestAnimationFrame')
    const id = ++nextId; frames.set(id, callback); return id
  },
  cancelAnimationFrame(id: number) { requireReceiver(this, 'cancelAnimationFrame'); frames.delete(id) },
  setTimeout(callback: () => void, milliseconds: number) {
    requireReceiver(this, 'setTimeout')
    const id = ++nextId; timers.set(id, { callback, milliseconds }); return id
  },
  clearTimeout(id: number) { requireReceiver(this, 'clearTimeout'); timers.delete(id) },
}

// This is the original integration: the scheduler becomes each method's `this`.
// A plain fake scheduler did not model the browser's receiver check and missed it.
const bare = { frame: owner.requestAnimationFrame, cancelFrame: owner.cancelAnimationFrame,
  delay: owner.setTimeout, cancelDelay: owner.clearTimeout }
const old = createMotionPresence(() => {}, bare)
assert.throws(() => old.update(true), /Illegal invocation: requestAnimationFrame/, 'The old first-open path reproduces the black-screen exception')
assert.throws(() => bare.cancelFrame(1), /Illegal invocation: cancelAnimationFrame/)
assert.throws(() => bare.delay(() => {}, 1), /Illegal invocation: setTimeout/)
assert.throws(() => bare.cancelDelay(1), /Illegal invocation: clearTimeout/)
old.dispose()

const changes: MotionPresenceState[] = []
const scheduler = createWindowMotionScheduler(owner as unknown as Window)
const current = createMotionPresence(value => changes.push(value), scheduler)
const paint = () => { const pending = [...frames]; frames.clear(); for (const [, callback] of pending) callback() }
const finish = () => { const pending = [...timers]; timers.clear(); for (const [, timer] of pending) timer.callback() }
assert.doesNotThrow(() => current.update(true))
assert.equal(current.current().phase, 'enter'); assert.equal(frames.size, 1)
assert.doesNotThrow(paint); assert.equal(current.current().phase, 'enter'); assert.equal(frames.size, 1)
assert.doesNotThrow(paint); assert.equal(current.current().phase, 'open'); assert.equal(frames.size, 0)
assert.equal([...timers.values()][0].milliseconds, 190)
finish(); assert.equal(current.current().settled, true)
current.update(false)
const staleExit = [...timers.values()][0].callback
assert.equal([...timers.values()][0].milliseconds, 130)
assert.doesNotThrow(() => current.update(true), 'Reopening cancels the old timer with the Window receiver')
staleExit(); assert.equal(current.current().present, true)
finish(); current.update(false); finish()
assert.equal(current.current().present, false)

// Cancelling between the two entry frames exercises cancelAnimationFrame.
current.update(true); paint()
const staleFrame = [...frames.values()][0]
current.update(false)
staleFrame(); assert.equal(frames.size, 0); assert.equal(current.current().phase, 'exit')
finish()
current.update(true)
assert.equal(frames.size, 1)
const count = changes.length
assert.doesNotThrow(() => current.dispose())
assert.equal(frames.size, 0); assert.equal(timers.size, 0)
staleFrame(); assert.equal(changes.length, count, 'Disposed owners receive no stale frame callback')
assert(calls.includes('requestAnimationFrame') && calls.includes('cancelAnimationFrame')
  && calls.includes('setTimeout') && calls.includes('clearTimeout'), 'All four APIs were exercised with their original receiver')
console.log(JSON.stringify({ windowMotionScheduler: 'passed', verified: 'old Illegal invocation reproduced; first entry, double frame, rapid reopening, cancellation and disposal keep Window receiver' }))
