import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'

registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier)) {
    try { return nextResolve(`${specifier}.ts`, context) } catch { /* Regular resolution remains available. */ }
  }
  return nextResolve(specifier, context)
} })
const { createDeveloperTileScrollController, developerTileScrollDuration } = await import('./src/developerTileNavigation.ts')

function clock() {
  let now = 0, nextId = 0
  const frames = new Map<number, (time: number) => void>()
  return {
    scheduler: { now: () => now, request: (callback: (time: number) => void) => {
      const id = ++nextId; frames.set(id, callback); return id
    }, cancel: (id: number) => { frames.delete(id) } },
    frame(time: number) { now = time; const callbacks = [...frames.values()]; frames.clear(); for (const callback of callbacks) callback(time) },
    queued: () => frames.size,
    late: () => [...frames.values()][0],
  }
}

// Long lists jump directly; even a large viewport has an absolute movement
// bound. Reduced motion never queues interpolation for a nearby destination.
assert.equal(developerTileScrollDuration(0, 200, 400, false), 190)
assert.equal(developerTileScrollDuration(0, 241, 400, false), 0)
assert.equal(developerTileScrollDuration(0, 361, 1000, false), 0)
assert.equal(developerTileScrollDuration(0, 200, 400, true), 0)
assert.equal(developerTileScrollDuration(0, 2, 400, false), 0)
assert.equal(developerTileScrollDuration(0, 100, 0, false), 0)

{
  const time = clock(), controller = createDeveloperTileScrollController(time.scheduler)
  const grid = { scrollTop: 100, clientHeight: 400 }
  let completed = 0
  controller.locate(grid, 300, false, () => true, () => completed++)
  assert.equal(grid.scrollTop, 100)
  assert.equal(time.queued(), 1)
  time.frame(95)
  assert.ok(grid.scrollTop > 200 && grid.scrollTop < 300)
  assert.equal(controller.onScroll(grid), false) // A delayed programmatic event is not manual intent.
  time.frame(190)
  assert.equal(grid.scrollTop, 300)
  assert.equal(completed, 1)
  assert.equal(time.queued(), 0)
}

for (const reduced of [false, true]) {
  const time = clock(), controller = createDeveloperTileScrollController(time.scheduler)
  const grid = { scrollTop: 0, clientHeight: 400 }
  let completed = 0
  controller.locate(grid, reduced ? 100 : 20000, reduced, () => true, () => completed++)
  assert.equal(grid.scrollTop, reduced ? 100 : 20000)
  assert.equal(completed, 1)
  assert.equal(time.queued(), 0)
}

{
  const time = clock(), controller = createDeveloperTileScrollController(time.scheduler)
  const grid = { scrollTop: 0, clientHeight: 400 }
  let oldComplete = 0, newComplete = 0
  controller.locate(grid, 200, false, () => true, () => oldComplete++)
  const staleFrame = time.late()
  controller.locate(grid, 10000, false, () => true, () => newComplete++)
  // Simulate a callback already delivered by the platform before cancellation.
  staleFrame(300)
  assert.equal(grid.scrollTop, 10000)
  assert.equal(oldComplete, 0)
  assert.equal(newComplete, 1)
  assert.equal(time.queued(), 0)
}

{
  const time = clock(), controller = createDeveloperTileScrollController(time.scheduler)
  const grid = { scrollTop: 0, clientHeight: 400 }
  let completed = 0
  controller.locate(grid, 200, false, () => true, () => completed++)
  const staleFrame = time.late()
  controller.cancel() // Wheel, pointer, keyboard, filters, close or unmount.
  grid.scrollTop = 40
  staleFrame(300)
  assert.equal(grid.scrollTop, 40)
  assert.equal(completed, 0)
  assert.equal(time.queued(), 0)
}

{
  const time = clock(), controller = createDeveloperTileScrollController(time.scheduler)
  const grid = { scrollTop: 100, clientHeight: 400 }
  let current = true, completed = 0
  controller.locate(grid, 300, false, () => current, () => completed++)
  current = false // The scene/request/visible surface changed before the frame.
  time.frame(95)
  assert.equal(grid.scrollTop, 100)
  assert.equal(completed, 0)
  assert.equal(time.queued(), 0)
}

{
  const time = clock(), controller = createDeveloperTileScrollController(time.scheduler)
  const grid = { scrollTop: 0, clientHeight: 400 }
  let completed = 0
  controller.locate(grid, 200, false, () => true, () => completed++)
  time.frame(40)
  const staleFrame = time.late()
  grid.scrollTop = 250 // External scrollbar/assistive scroll after the last write.
  assert.equal(controller.onScroll(grid), true)
  staleFrame(300)
  assert.equal(grid.scrollTop, 250)
  assert.equal(completed, 0)
  assert.equal(time.queued(), 0)
  controller.locate(grid, Number.NaN, false, () => true, () => completed++)
  assert.equal(grid.scrollTop, 250)
  assert.equal(completed, 0)
}

console.log('Developer tile motion checks passed: bounded nearby motion, direct distant/reduced locate, and stale/manual/lifecycle cancellation.')
