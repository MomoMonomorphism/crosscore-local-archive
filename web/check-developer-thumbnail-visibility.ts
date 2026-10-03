import assert from 'node:assert/strict'
import { createDeveloperThumbnailResultGate, createDeveloperThumbnailVisibility } from './src/developerThumbnailVisibility.ts'

let rootVisible = true, tileVisible = true
const root = { getClientRects: () => rootVisible ? [{}] : [] } as unknown as HTMLElement
const tile = { getClientRects: () => tileVisible ? [{}] : [] } as unknown as HTMLElement
const second = { getClientRects: () => [{}] } as unknown as HTMLElement
let callback: IntersectionObserverCallback | null = null
let options: IntersectionObserverInit | null = null
const observed = new Set<Element>()
let disconnected = false, factories = 0
const visibility = createDeveloperThumbnailVisibility(root, (notify, configuration) => {
  callback = notify; options = configuration; factories++
  return { observe: element => { observed.add(element) }, unobserve: element => { observed.delete(element) },
    disconnect: () => { disconnected = true; observed.clear() } }
})
function emit(target: Element, intersecting: boolean) {
  callback!([{ target, isIntersecting: intersecting } as IntersectionObserverEntry], {} as IntersectionObserver)
}
const values: boolean[] = [], secondValues: boolean[] = []
const stop = visibility.observe(tile, value => values.push(value))
visibility.observe(second, value => secondValues.push(value))
assert.equal(factories, 1)
assert.equal(observed.size, 2)
assert.equal(options!.root, root)
assert.equal(options!.rootMargin, '80px')
assert.deepEqual(values, []) // Merely mounting never starts a thumbnail.
emit(tile, true); emit(tile, true)
assert.deepEqual(values, [true]) // Repeated visible notifications do not request again.
emit(second, false)
assert.deepEqual(secondValues, [false])

// A hidden browser body suppresses even a stale intersecting IO notification.
rootVisible = false; emit(tile, true)
assert.deepEqual(values, [true, false])
rootVisible = true; emit(tile, true)
assert.deepEqual(values, [true, false, true])
tileVisible = false; emit(tile, true)
assert.deepEqual(values, [true, false, true, false])
stop(); tileVisible = true; emit(tile, true)
assert.equal(observed.has(tile), false)
assert.deepEqual(values, [true, false, true, false])
visibility.dispose(); emit(second, true)
assert.equal(disconnected, true)
assert.deepEqual(secondValues, [false])
visibility.observe(tile, value => values.push(value))
assert.equal(observed.size, 0)

// IO-unavailable fallback never requests all artwork as an eager fallback.
const unsupported: boolean[] = []
createDeveloperThumbnailVisibility(root, null).observe(tile, value => unsupported.push(value))
assert.deepEqual(unsupported, [false])

// Leaving the grid, changing the filter/scene/version, or unmounting rejects
// pending results. Re-entering creates an independent valid generation.
const gate = createDeveloperThumbnailResultGate()
const first = gate.updateVisible(true)
assert.equal(gate.accepts(first), true)
gate.updateVisible(false)
assert.equal(gate.accepts(first), false)
const newer = gate.updateVisible(true)
assert.equal(gate.accepts(first), false)
assert.equal(gate.accepts(newer), true)
gate.invalidate()
assert.equal(gate.accepts(newer), false)

console.log('Developer thumbnail visibility checks passed: shared observer, hidden layout, lifecycle, and stale results.')
