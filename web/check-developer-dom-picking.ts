import assert from 'node:assert/strict'
import { createDeveloperDomPicker } from './src/developerDomPicking.ts'

function box(left = 0, top = 0, width = 100, height = 100) {
  return { left, top, width, height, right: left + width, bottom: top + height } as DOMRect
}
type Fake = ReturnType<typeof element>
const view = { getComputedStyle(value: Fake) { return value.computed } }
function element(parent: HTMLElement | null = null, rect = box()) {
  return {
    parentElement: parent, isConnected: true, ownerDocument: { defaultView: view },
    style: { outline: '1px solid gray', outlineOffset: '0px' },
    computed: { display: 'block', visibility: 'visible', opacity: '1', overflowX: 'visible', overflowY: 'visible', zIndex: 'auto' },
    getBoundingClientRect: () => rect, getClientRects: () => [rect],
    contains(target: HTMLElement) {
      for (let node: HTMLElement | null = target; node; node = node.parentElement) if (node === this as unknown) return true
      return false
    },
  }
}
const root = element()
const back = element(root as never)
const front = element(root as never, box(10, 10, 60, 60))
front.computed.opacity = '.4'
const candidates = [back, front].map((value, i) => ({ element: value as never,
  candidate: { id: `image-${i}`, layerId: `image-${i}`, kind: 'layer' as const, label: `image ${i}` } }))
const picker = createDeveloperDomPicker(() => root as never, () => candidates)
assert.deepEqual(picker.pick(20, 20).map(value => value.id), ['image-1', 'image-0'], 'Frontmost artwork precedes overlapping background')
assert.equal(picker.pick(20, 20)[0].opacity, .4)
back.computed.zIndex = '8'
front.computed.zIndex = '2'
assert.deepEqual(picker.pick(20, 20).map(value => value.id), ['image-0', 'image-1'], 'CSS z-index must precede reverse DOM order')
back.computed.zIndex = front.computed.zIndex = 'auto'
assert.deepEqual(picker.pick(90, 90).map(value => value.id), ['image-0'])
assert.deepEqual(picker.pick(120, 20), [])
front.computed.visibility = 'hidden'
assert.deepEqual(picker.pick(20, 20).map(value => value.id), ['image-0'], 'Hidden artwork must not be picked via its still-mounted hit wrapper')
front.computed.visibility = 'visible'
root.computed.opacity = '0'
assert.deepEqual(picker.pick(20, 20), [])
root.computed.opacity = '.5'
assert.equal(picker.pick(20, 20)[0].opacity, .2, 'Ancestor opacity participates')
root.computed.opacity = '1'
const crop = element(root as never, box(0, 0, 15, 15))
crop.computed.overflowX = 'hidden'
front.parentElement = crop as never
assert.deepEqual(picker.pick(20, 12).map(value => value.id), ['image-0'], 'Overflow clip excludes geometrically covered artwork')
front.parentElement = root as never
picker.highlight(candidates[1].candidate)
assert.equal(front.style.outline, '2px solid #56d8f0')
picker.highlight(candidates[0].candidate)
assert.equal(front.style.outline, '1px solid gray', 'Changing selection restores previous authored style')
assert.equal(back.style.outline, '2px solid #56d8f0')
picker.dispose(); picker.dispose()
assert.equal(back.style.outline, '1px solid gray')
assert.equal(back.style.outlineOffset, '0px')
front.isConnected = false
assert.deepEqual(picker.pick(20, 20).map(value => value.id), ['image-0'])
console.log('Developer DOM picking: overlap, visibility, opacity, clipping and highlight cleanup passed')
