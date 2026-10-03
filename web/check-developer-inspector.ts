import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { developerCandidateIndex, findDeveloperPlayback, patchDeveloperObject, restoreDeveloperObject, stepDeveloperCandidate } from './src/developerInspector.ts'
import type { DeveloperOverrides, DeveloperPickCandidate, DeveloperPlaybackHandle } from './src/developerControls.ts'

registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier)) {
    try { return nextResolve(`${specifier}.ts`, context) } catch { /* Use regular resolution for non-TS files. */ }
  }
  return nextResolve(specifier, context)
} })
const { developerLayerPresentation } = await import('./src/developerControls.ts')

const original: DeveloperOverrides = {
  layers: { main: { opacity: 0.6 }, back: { hidden: true } },
  slots: { 'main::eyes': { hidden: true, opacity: 0.3 }, 'main::clip': { disableClipping: true }, 'main::hair': { opacity: 0.8 } },
  solo: { kind: 'slot', id: 'main::eyes' },
}
Object.freeze(original.layers); Object.freeze(original.slots); Object.freeze(original)

// Restoring a selected slot clears only that slot and its matching solo.
const restoredSlot = restoreDeveloperObject(original, 'slot', 'main::eyes')
assert.equal(Object.hasOwn(restoredSlot.slots, 'main::eyes'), false)
assert.equal(Object.hasOwn(restoredSlot, 'solo'), false)
assert.equal(restoredSlot.layers, original.layers)
assert.deepEqual(restoredSlot.slots['main::clip'], { disableClipping: true })
assert.deepEqual(restoredSlot.slots['main::hair'], { opacity: 0.8 })
assert.deepEqual(original.slots['main::eyes'], { hidden: true, opacity: 0.3 })

// Layer restore preserves independently edited child slots and another solo.
const restoredLayer = restoreDeveloperObject(original, 'layer', 'main')
assert.equal(Object.hasOwn(restoredLayer.layers, 'main'), false)
assert.equal(restoredLayer.slots, original.slots)
assert.equal(restoredLayer.solo, original.solo)
assert.deepEqual(restoredLayer.layers.back, { hidden: true })
const matchingLayerSolo = restoreDeveloperObject({ ...original, solo: { kind: 'layer', id: 'main' } }, 'layer', 'main')
assert.equal(Object.hasOwn(matchingLayerSolo, 'solo'), false)

// Native hidden layers can be temporarily forced visible, then exactly restored
// by removing the rule rather than writing a potentially wrong visible value.
const native: DeveloperOverrides = { layers: {}, slots: {} }
assert.equal(developerLayerPresentation('native-hidden', false, 0.75, native).visible, false)
const forced = patchDeveloperObject(native, 'layer', 'native-hidden', { hidden: false })
assert.equal(developerLayerPresentation('native-hidden', false, 0.75, forced).visible, true)
const unforced = restoreDeveloperObject(forced, 'layer', 'native-hidden')
assert.equal(Object.hasOwn(unforced.layers, 'native-hidden'), false)
assert.deepEqual(developerLayerPresentation('native-hidden', false, 0.75, unforced), { visible: false, opacity: 0.75 })

// Hiding a solo slot or its owner layer must actually hide it. An unrelated
// object's solo remains; ordinary opacity changes do not exit solo mode.
const hiddenSlot = patchDeveloperObject(original, 'slot', 'main::eyes', { hidden: true })
assert.equal(Object.hasOwn(hiddenSlot, 'solo'), false)
const hiddenOwner = patchDeveloperObject(original, 'layer', 'main', { hidden: true })
assert.equal(Object.hasOwn(hiddenOwner, 'solo'), false)
assert.equal(developerLayerPresentation('main', true, 1, hiddenOwner).visible, false)
assert.equal(patchDeveloperObject(original, 'layer', 'back', { hidden: true }).solo, original.solo)
assert.equal(patchDeveloperObject(original, 'slot', 'main::eyes', { opacity: 0.5 }).solo, original.solo)
assert.deepEqual(hiddenSlot.slots['main::hair'], original.slots['main::hair'])

// Candidate identity includes kind as well as id. Hidden/cached objects stay
// addressable even though the visible renderer would no longer pick them.
const layer: DeveloperPickCandidate = { id: 'shared', kind: 'layer', layerId: 'shared', label: 'layer' }
const slot: DeveloperPickCandidate = { id: 'shared', kind: 'slot', layerId: 'shared', label: 'slot' }
const candidates = [layer, slot]
assert.equal(developerCandidateIndex(candidates, { ...slot, label: 'new snapshot label' }), 1)
assert.equal(developerCandidateIndex(candidates, layer), 0)
assert.equal(stepDeveloperCandidate(candidates, slot, 1), layer)
assert.equal(stepDeveloperCandidate(candidates, layer, -1), slot)
assert.equal(stepDeveloperCandidate(candidates, null, 1), layer)
assert.equal(stepDeveloperCandidate(candidates, null, -1), slot)
assert.equal(stepDeveloperCandidate([], slot, 1), null)

class FakeSurface {
  parent: FakeSurface | null
  constructor(parent: FakeSurface | null = null) { this.parent = parent }
  contains(other: FakeSurface | null): boolean {
    for (let current = other; current; current = current.parent) if (current === this) return true
    return false
  }
}
const html = (surface: FakeSurface) => surface as unknown as HTMLElement
const app = new FakeSurface(), illustration = new FakeSurface(app), canvas = new FakeSurface(illustration), unrelated = new FakeSurface()
function playback(id: string, owner: FakeSurface): DeveloperPlaybackHandle {
  const state = { playing: true, available: true }
  return { id, surface: () => html(owner), getState: () => state, setPlaying: playing => { state.playing = playing } }
}
const outerPlayback = playback('app', app), nestedPlayback = playback('illustration', illustration), unrelatedPlayback = playback('other', unrelated)
assert.equal(findDeveloperPlayback(html(canvas), [nestedPlayback, outerPlayback, unrelatedPlayback]), nestedPlayback)
assert.equal(findDeveloperPlayback(html(canvas), [outerPlayback, unrelatedPlayback, nestedPlayback]), nestedPlayback)
findDeveloperPlayback(html(canvas), [outerPlayback, nestedPlayback])!.setPlaying(false)
assert.equal(nestedPlayback.getState().playing, false)
assert.equal(outerPlayback.getState().playing, true)
assert.equal(findDeveloperPlayback(null, [outerPlayback, nestedPlayback]), null)
assert.equal(findDeveloperPlayback(html(unrelated), [outerPlayback]), null)

// Registry replacement/unmount is resolved afresh; stale nested controllers are
// never reused. A failing unloaded surface cannot prevent its owner resolving.
const registry = new Map([[outerPlayback.id, outerPlayback], [nestedPlayback.id, nestedPlayback]])
const replacement = playback('illustration', illustration)
registry.set(replacement.id, replacement)
assert.equal(findDeveloperPlayback(html(canvas), registry.values()), replacement)
registry.delete(replacement.id)
assert.equal(findDeveloperPlayback(html(canvas), registry.values()), outerPlayback)
const failed: DeveloperPlaybackHandle = { ...nestedPlayback, surface: () => { throw new Error('unmounted') } }
assert.equal(findDeveloperPlayback(html(canvas), [failed, outerPlayback]), outerPlayback)

console.log(JSON.stringify({ status: 'passed', verified: ['single-object restore preserves unrelated rules',
  'native hidden layer force/revert', 'hide cancels matching/child solo', 'candidate kind+id and empty stack',
  'nearest playback owner', 'replacement/unmount playback lifecycle'] }))
