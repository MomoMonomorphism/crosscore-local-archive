import assert from 'node:assert/strict'
import { findDeveloperDomThumbnailSource, loadedDeveloperDomThumbnailSource } from './src/developerDomThumbnail.ts'
import type { DeveloperPickCandidate } from './src/developerControls.ts'

// A small DOM tree exercises the real lookup without fetching images, creating
// an Image, reading pixels, or needing browser layout for hidden resources.
class TestElement {
  isConnected = true
  complete = true
  naturalWidth = 512
  naturalHeight = 256
  width = 320
  height = 180
  parent: TestElement | null = null
  children: TestElement[] = []
  dataset: { developerPickId?: string } = {}
  style = { visibility: '', opacity: '' }
  tagName: string
  constructor(tagName: string, id?: string) { this.tagName = tagName; if (id) this.dataset.developerPickId = id }
  append(child: TestElement) { child.parent = this; this.children.push(child); return child }
  contains(element: TestElement): boolean { return element === this || this.children.some(child => child.contains(element)) }
  querySelectorAll(selector: string): TestElement[] {
    const matches = (element: TestElement) => selector === '[data-developer-pick-id]'
      ? !!element.dataset.developerPickId : ['img', 'canvas'].includes(element.tagName.toLowerCase())
    return this.children.flatMap(child => [...(matches(child) ? [child] : []), ...child.querySelectorAll(selector)])
  }
  closest(_selector: string): TestElement | null { return this.dataset.developerPickId ? this : this.parent?.closest(_selector) ?? null }
}
const asElement = (element: TestElement | null) => element as unknown as HTMLElement | null
const candidate = (id: string): DeveloperPickCandidate => ({ id, kind: 'layer', layerId: id, label: id })
const root = new TestElement('DIV')
const first = root.append(new TestElement('DIV', 'ui:first'))
const firstImage = first.append(new TestElement('IMG'))
const second = root.append(new TestElement('DIV', 'ui:second'))
const secondCanvas = second.append(new TestElement('CANVAS'))
const parent = root.append(new TestElement('DIV', 'ui:parent'))
const nested = parent.append(new TestElement('DIV', 'ui:nested'))
const nestedImage = nested.append(new TestElement('IMG'))

// Exact identity is required; no prefix/CSS selector interpolation can return
// neighboring artwork, and the ancestor may not borrow its child's image.
assert.equal(findDeveloperDomThumbnailSource(asElement(root), candidate('ui:first'))?.source, asElement(firstImage))
assert.equal(findDeveloperDomThumbnailSource(asElement(root), candidate('ui:second'))?.source, asElement(secondCanvas))
assert.equal(findDeveloperDomThumbnailSource(asElement(root), candidate('ui:nested'))?.source, asElement(nestedImage))
assert.equal(findDeveloperDomThumbnailSource(asElement(root), candidate('ui:parent')), null)
assert.equal(findDeveloperDomThumbnailSource(asElement(root), candidate('ui:fir')), null)
assert.equal(findDeveloperDomThumbnailSource(asElement(root), candidate('ui:first"] img')), null)
assert.equal(findDeveloperDomThumbnailSource(asElement(root), { ...candidate('ui:first'), kind: 'slot' }), null)
assert.equal(findDeveloperDomThumbnailSource(asElement(root), { ...candidate('ui:first'), layerId: 'ui:second' }), null)
assert.equal(findDeveloperDomThumbnailSource(null, candidate('ui:first')), null)

// Resource dimensions stay intrinsic; hidden/transparent artwork still has a
// preview, without changing styles or copying another element's rendered box.
firstImage.style = { visibility: 'hidden', opacity: '0' }
const imageSource = loadedDeveloperDomThumbnailSource(asElement(firstImage))!
assert.equal(imageSource.width, 512)
assert.equal(imageSource.height, 256)
assert.deepEqual(firstImage.style, { visibility: 'hidden', opacity: '0' })
assert.equal(loadedDeveloperDomThumbnailSource(asElement(secondCanvas))!.width, 320)
assert.equal(loadedDeveloperDomThumbnailSource(asElement(secondCanvas))!.height, 180)

// Loading, failed, SVG-only, disconnected, and disposed nodes gracefully return
// null. An unloaded image may fall back to its own already loaded canvas.
firstImage.complete = false
assert.equal(loadedDeveloperDomThumbnailSource(asElement(firstImage)), null)
const fallback = first.append(new TestElement('CANVAS'))
assert.equal(findDeveloperDomThumbnailSource(asElement(root), candidate('ui:first'))?.source, asElement(fallback))
firstImage.complete = true; firstImage.naturalWidth = 0
assert.equal(loadedDeveloperDomThumbnailSource(asElement(firstImage)), null)
assert.equal(loadedDeveloperDomThumbnailSource(asElement(new TestElement('image'))), null)
secondCanvas.width = 0
assert.equal(findDeveloperDomThumbnailSource(asElement(root), candidate('ui:second')), null)
secondCanvas.width = Number.NaN
assert.equal(loadedDeveloperDomThumbnailSource(asElement(secondCanvas)), null)
nestedImage.isConnected = false
assert.equal(findDeveloperDomThumbnailSource(asElement(root), candidate('ui:nested')), null)
root.isConnected = false
assert.equal(findDeveloperDomThumbnailSource(asElement(root), candidate('ui:first')), null)

console.log('Developer DOM thumbnail checks passed: exact ownership, loaded resources, hidden artwork, and disposal.')
