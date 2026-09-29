import assert from 'node:assert/strict'
import { GALLERY_LAYOUT_KEY, readGalleryPanelPreferences, writeGalleryPanelPreferences } from './src/galleryPanelPreferences.ts'

let raw: string | null = null
const storage = {
  getItem(key: string) { assert.equal(key, GALLERY_LAYOUT_KEY); return raw },
  setItem(key: string, value: string) { assert.equal(key, GALLERY_LAYOUT_KEY); raw = value },
}
const defaults = { libraryOpen: true, toolsOpen: true }
assert.deepEqual(readGalleryPanelPreferences(storage), defaults)
writeGalleryPanelPreferences({ libraryOpen: true, toolsOpen: false }, storage)
assert.deepEqual(readGalleryPanelPreferences(storage), { libraryOpen: true, toolsOpen: false })
writeGalleryPanelPreferences(defaults, storage)
assert.deepEqual(readGalleryPanelPreferences(storage), defaults)
for (const invalid of ['{', 'null', '[]', 'false', '"string"', '{"version":2,"toolsOpen":false}']) {
  raw = invalid
  assert.deepEqual(readGalleryPanelPreferences(storage), defaults)
}
raw = '{"version":1,"libraryOpen":"false","toolsOpen":false}'
assert.deepEqual(readGalleryPanelPreferences(storage), { libraryOpen: true, toolsOpen: false })
raw = '{"version":1,"libraryOpen":false}'
assert.deepEqual(readGalleryPanelPreferences(storage), { libraryOpen: false, toolsOpen: true })
assert.deepEqual(readGalleryPanelPreferences({ getItem() { throw new Error('blocked') } }), defaults)
assert.doesNotThrow(() => writeGalleryPanelPreferences(defaults, { setItem() { throw new Error('quota') } }))
assert.deepEqual(readGalleryPanelPreferences(), defaults) // Node/SSR has no window.
console.log('Gallery panel preferences: passed (defaults, round-trip, reset, validation, blocked storage, SSR).')
