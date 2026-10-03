import assert from 'node:assert/strict'
import { createMotionPresence, type MotionPresenceState } from './src/motionPresence.ts'

let nextId = 0
const frames = new Map<number, () => void>(), timers = new Map<number, { callback: () => void; milliseconds: number }>()
const changes: MotionPresenceState[] = []
const presence = createMotionPresence(value => changes.push(value), {
  frame(callback) { const id = ++nextId; frames.set(id, callback); return id }, cancelFrame(id) { frames.delete(id) },
  delay(callback, milliseconds) { const id = ++nextId; timers.set(id, { callback, milliseconds }); return id }, cancelDelay(id) { timers.delete(id) },
})
const paint = () => { const pending = [...frames]; frames.clear(); for (const [, callback] of pending) callback() }
const finish = () => { const pending = [...timers]; timers.clear(); for (const [, timer] of pending) timer.callback() }
assert.deepEqual(presence.current(), { present: false, phase: 'closed', settled: true })
presence.update(true)
assert.deepEqual(presence.current(), { present: true, phase: 'enter', settled: false })
assert.equal(frames.size, 1); assert.equal(timers.size, 0)
paint(); assert.equal(presence.current().phase, 'enter', 'Initial state needs a painted frame')
paint(); assert.equal(presence.current().phase, 'open'); assert.equal(presence.current().settled, false)
assert.equal([...timers.values()][0].milliseconds, 190)
finish(); assert.equal(presence.current().settled, true)
presence.update(false)
assert.deepEqual(presence.current(), { present: true, phase: 'exit', settled: false }, 'Logical close retains only its exit shell')
assert.equal([...timers.values()][0].milliseconds, 130)
const staleExit = [...timers.values()][0].callback
presence.update(true)
assert.equal(presence.current().phase, 'open', 'Rapid reopening keeps mounted content instead of restarting opacity at zero')
staleExit(); assert.equal(presence.current().present, true, 'Cancelled exit cannot unmount the reopened window')
finish(); assert.equal(presence.current().settled, true)

presence.update(false); finish()
assert.deepEqual(presence.current(), { present: false, phase: 'closed', settled: true })
presence.update(true)
const staleEntry = [...frames.values()][0]
presence.update(false)
staleEntry(); assert.equal(frames.size, 0); assert.equal(presence.current().phase, 'exit')
finish(); assert.equal(presence.current().present, false)

// Preference changes cancel both frame and completion work immediately.
presence.update(true); presence.update(true, true)
assert.deepEqual(presence.current(), { present: true, phase: 'open', settled: true })
assert.equal(frames.size, 0); assert.equal(timers.size, 0)
presence.update(false, true)
assert.deepEqual(presence.current(), { present: false, phase: 'closed', settled: true })
presence.update(true); paint(); paint()
const staleFinish = [...timers.values()][0].callback
presence.dispose()
assert.equal(frames.size, 0); assert.equal(timers.size, 0)
const count = changes.length
staleFinish(); presence.update(false)
assert.equal(changes.length, count, 'Unmounted owner receives no stale callbacks')

// Independent windows cannot cancel each other's lifecycle.
const second = createMotionPresence(() => {}, {
  frame(callback) { const id = ++nextId; frames.set(id, callback); return id }, cancelFrame(id) { frames.delete(id) },
  delay(callback, milliseconds) { const id = ++nextId; timers.set(id, { callback, milliseconds }); return id }, cancelDelay(id) { timers.delete(id) },
}, { enterMs: 210, exitMs: 120 })
second.update(true); paint(); paint()
assert.equal([...timers.values()][0].milliseconds, 210)
second.dispose(); assert.equal(timers.size, 0)
console.log(JSON.stringify({ motionPresence: 'passed', verified: 'painted entry, retained exit, reversal races, reduced motion, lifecycle cleanup, independent owners' }))
