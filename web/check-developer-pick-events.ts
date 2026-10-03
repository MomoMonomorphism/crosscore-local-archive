import assert from 'node:assert/strict'
import { installDeveloperPickEvents } from './src/developerPickEvents.ts'
import type { DeveloperPickCandidate, DeveloperSceneHandle } from './src/developerControls.ts'

type Origin = 'canvas' | 'inspector' | 'tile' | 'outside'
class FakeMouseEvent extends Event {
  clientX: number
  clientY: number
  origin: Origin
  constructor(type: string, x = 20, y = 30, origin: Origin = 'canvas') {
    super(type, { cancelable: true })
    this.clientX = x; this.clientY = y; this.origin = origin
  }
}
class FakePointerEvent extends FakeMouseEvent {
  pointerId = 1
  isPrimary = true
  button = 0
}

const candidates: DeveloperPickCandidate[] = [
  { id: 'main::front', kind: 'slot', layerId: 'main', label: 'front', attachment: 'front-image' },
  { id: 'main::behind', kind: 'slot', layerId: 'main', label: 'behind', attachment: 'behind-image' },
]
function fixture() {
  const document = new EventTarget()
  const window = new EventTarget()
  const blurListeners = new Set<EventListenerOrEventListenerObject>()
  const addWindowListener = window.addEventListener.bind(window)
  const removeWindowListener = window.removeEventListener.bind(window)
  window.addEventListener = (name, listener, options) => {
    if (name === 'blur' && listener) blurListeners.add(listener)
    addWindowListener(name, listener, options)
  }
  window.removeEventListener = (name, listener, options) => {
    if (name === 'blur' && listener) blurListeners.delete(listener)
    removeWindowListener(name, listener, options)
  }
  const state = { enabled: true, visible: true, registered: true, throwOnPick: false, hidden: false }
  const picks: Array<{ handle: DeveloperSceneHandle; candidates: DeveloperPickCandidate[] }> = []
  const errors: unknown[] = []
  const gameEvents: string[] = []
  const menuEvents: string[] = []
  const handle: DeveloperSceneHandle = {
    id: 'gallery:test', label: 'Test', snapshot: () => ({ id: 'gallery:test', label: 'Test', layers: [], slots: [] }),
    active: () => state.visible, surface: () => null,
    pick: (x, y) => {
      assert.equal(x, 20); assert.equal(y, 30)
      if (state.throwOnPick) throw new Error('Renderer unloaded during picking')
      return candidates
    },
  }
  const dispose = installDeveloperPickEvents(document, {
    // Tool windows can cover the canvas rectangle. Simulate that geometric
    // fallback so the controller's panel exclusion is what protects them.
    findHandle: event => state.enabled && state.visible && state.registered && (event as FakeMouseEvent).origin !== 'outside' ? handle : undefined,
    canPick: current => state.enabled && state.visible && state.registered && current === handle,
    onPick: (current, found) => picks.push({ handle: current, candidates: found }),
    onError: error => errors.push(error),
    isPanelTarget: event => ['inspector', 'tile'].includes((event as FakeMouseEvent).origin),
    blurTarget: window,
    isHidden: () => state.hidden,
  })
  for (const name of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'click']) document.addEventListener(name, event => {
    if ((event as FakeMouseEvent).origin === 'canvas') gameEvents.push(event.type)
    else if (['inspector', 'tile'].includes((event as FakeMouseEvent).origin)) menuEvents.push(event.type)
  })
  const pointer = (name: string, x = 20, y = 30, origin: Origin = 'canvas') => {
    const event = new FakePointerEvent(name, x, y, origin)
    document.dispatchEvent(event)
    return event
  }
  const click = (x = 20, y = 30, origin: Origin = 'canvas') => {
    const event = new FakeMouseEvent('click', x, y, origin)
    document.dispatchEvent(event)
    return event
  }
  return { state, picks, errors, gameEvents, menuEvents, handle, pointer, click, dispose,
    blur: () => window.dispatchEvent(new Event('blur')),
    visibility: () => document.dispatchEvent(new Event('visibilitychange')),
    blurListenerCount: () => blurListeners.size }
}

// Blocking starts at down, before gameplay can start entrance skipping, long
// presses or drags. All overlap candidates and their renderer order survive.
{
  const test = fixture()
  assert.equal(test.pointer('pointerdown').defaultPrevented, true)
  assert.deepEqual(test.gameEvents, [])
  assert.equal(test.pointer('pointermove', 23, 31).defaultPrevented, true)
  assert.equal(test.pointer('pointerup').defaultPrevented, true)
  assert.equal(test.click().defaultPrevented, true)
  assert.deepEqual(test.gameEvents, [])
  assert.equal(test.picks.length, 1)
  assert.equal(test.picks[0].handle, test.handle)
  assert.equal(test.picks[0].candidates, candidates)
  test.dispose()
}

// A drag that returns to its starting point is still a drag, not a click.
{
  const test = fixture()
  test.pointer('pointerdown')
  test.pointer('pointermove', 42, 30)
  test.pointer('pointermove')
  test.pointer('pointerup')
  test.click()
  assert.deepEqual(test.gameEvents, [])
  assert.equal(test.picks.length, 0)
  test.dispose()
}

// Cancellation consumes the abandoned gesture and cannot select anything.
{
  const test = fixture()
  test.pointer('pointerdown')
  assert.equal(test.pointer('pointercancel').defaultPrevented, true)
  assert.equal(test.click().defaultPrevented, true)
  assert.equal(test.picks.length, 0)
  assert.deepEqual(test.gameEvents, [])
  test.dispose()
}

// Disabled point mode restores normal gameplay for fresh gestures immediately.
// Turning it off mid-gesture does not leak that old gesture's trailing click.
{
  const test = fixture()
  test.pointer('pointerdown')
  test.state.enabled = false
  test.pointer('pointerup')
  assert.equal(test.click().defaultPrevented, true)
  assert.equal(test.picks.length, 0)
  assert.deepEqual(test.gameEvents, [])
  assert.equal(test.pointer('pointerdown').defaultPrevented, false)
  assert.equal(test.pointer('pointermove').defaultPrevented, false)
  assert.equal(test.pointer('pointerup').defaultPrevented, false)
  assert.equal(test.click().defaultPrevented, false)
  assert.deepEqual(test.gameEvents, ['pointerdown', 'pointermove', 'pointerup', 'click'])
  test.dispose()
}

// A renderer disappearing between down and up cannot receive a stale pick.
{
  const test = fixture()
  test.pointer('pointerdown')
  test.state.registered = false
  test.pointer('pointerup')
  test.click()
  assert.equal(test.picks.length, 0)
  assert.deepEqual(test.gameEvents, [])
  test.dispose()
}

// Both independent tool windows remain usable while canvas picking is enabled.
// Their capture exclusion must cover non-button areas such as draggable titles.
for (const origin of ['inspector', 'tile'] as const) {
  const test = fixture()
  assert.equal(test.pointer('pointerdown', 200, 300, origin).defaultPrevented, false, `${origin} down remains usable`)
  assert.equal(test.pointer('pointermove', 220, 300, origin).defaultPrevented, false, `${origin} title drag remains usable`)
  assert.equal(test.pointer('pointerup', 220, 300, origin).defaultPrevented, false, `${origin} up remains usable`)
  assert.equal(test.click(220, 300, origin).defaultPrevented, false, `${origin} click remains usable`)
  assert.deepEqual(test.menuEvents, ['pointerdown', 'pointermove', 'pointerup', 'click'])
  assert.equal(test.picks.length, 0)
  assert.deepEqual(test.gameEvents, [])
  test.dispose()
}

// Errors stay in the developer UI and never dispatch the intercepted gesture
// back to gameplay. Removing the controller removes its capture listeners.
{
  const test = fixture()
  test.state.throwOnPick = true
  test.pointer('pointerdown'); test.pointer('pointerup'); test.click()
  assert.equal(test.errors.length, 1)
  assert.equal(test.picks.length, 0)
  assert.deepEqual(test.gameEvents, [])
  test.dispose()
  assert.equal(test.pointer('pointerdown').defaultPrevented, false)
  assert.equal(test.pointer('pointerup').defaultPrevented, false)
  assert.equal(test.click().defaultPrevented, false)
  assert.deepEqual(test.gameEvents, ['pointerdown', 'pointerup', 'click'])
}

// Focus loss can omit pointerup entirely. A late up with the old pointerId
// cannot complete an abandoned selection; a fresh gesture still works.
{
  const test = fixture()
  test.pointer('pointerdown'); test.blur(); test.pointer('pointerup'); test.click()
  assert.equal(test.picks.length, 0)
  assert.deepEqual(test.gameEvents, [])
  test.pointer('pointerdown'); test.pointer('pointerup'); test.click()
  assert.equal(test.picks.length, 1)
  test.dispose()
}

// A visibility event while visible must not cancel a gesture. Hiding the
// document must cancel it, including a subsequent late pointerup.
{
  const test = fixture()
  test.pointer('pointerdown'); test.visibility(); test.pointer('pointerup'); test.click()
  assert.equal(test.picks.length, 1)
  test.pointer('pointerdown'); test.state.hidden = true; test.visibility()
  test.state.hidden = false; test.pointer('pointerup'); test.click()
  assert.equal(test.picks.length, 1)
  assert.deepEqual(test.gameEvents, [])
  test.dispose()
}

// Disposal removes focus/visibility callbacks too, rather than leaving them
// attached to global browser surfaces after a provider is unmounted.
{
  const test = fixture()
  let visibilityChecks = 0
  Object.defineProperty(test.state, 'hidden', { get: () => { visibilityChecks++; return true } })
  test.visibility()
  assert.equal(visibilityChecks, 1)
  assert.equal(test.blurListenerCount(), 1)
  test.dispose()
  assert.equal(test.blurListenerCount(), 0)
  test.visibility(); test.blur()
  assert.equal(visibilityChecks, 1)
  assert.equal(test.pointer('pointerdown').defaultPrevented, false)
  assert.equal(test.pointer('pointerup').defaultPrevented, false)
  assert.deepEqual(test.gameEvents, ['pointerdown', 'pointerup'])
}

console.log(JSON.stringify({ status: 'passed', cases: 11,
  verified: ['down blocks gameplay', 'complete click consumed', 'drag/cancel not picked',
    'off restores fresh gestures', 'unloaded scenes not picked', 'both inspector/tile windows usable', 'controller cleanup',
    'blur/hidden cancel old gestures', 'focus/visibility listener cleanup'] }))
