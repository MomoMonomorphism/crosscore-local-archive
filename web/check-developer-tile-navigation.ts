import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import type { DeveloperScene } from './src/developerControls.ts'
import type { DeveloperTileFilters, DeveloperTileLocateRequest } from './src/developerTileNavigation.ts'

registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier)) {
    try { return nextResolve(`${specifier}.ts`, context) } catch { /* Use regular resolution for other files. */ }
  }
  return nextResolve(specifier, context)
} })
const { createDeveloperLayerTiles } = await import('./src/developerLayerTileModel.ts')
const { centeredDeveloperTileScroll, developerTileIdentity, eligibleDeveloperTileLocate, repairDeveloperTileFilters } = await import('./src/developerTileNavigation.ts')

const specialId = 'main::eye"[x]\\ /中文'
const scene: DeveloperScene = { id: 'gallery:test', label: '角色', layers: [
  { id: 'main', label: '角色主图', assetId: 'skin/main', kind: 'spine', visible: true, opacity: 1 },
  { id: 'back', label: '背景', assetId: 'background', kind: 'image', visible: true, opacity: 1 },
  { id: 'mask', label: '材质遮罩', assetId: 'mask', kind: '材质遮罩', visible: false, opacity: 1 },
], slots: [
  { id: specialId, layerId: 'main', name: 'Eye', type: 'region', attachment: 'eye-open', attachments: ['eye-open'], alpha: 1, maskCandidate: false, order: 2 },
  { id: 'main::black', layerId: 'main', name: 'black-shadow', type: 'mesh', attachment: 'black', attachments: ['black'], alpha: 1, maskCandidate: true, order: 3 },
  { id: 'main', layerId: 'main', name: 'same-id-slot', type: 'region', attachment: 'part', attachments: ['part'], alpha: 1, maskCandidate: false, order: 1 },
] }
const tiles = createDeveloperLayerTiles(scene)
const eye = tiles.find(tile => tile.candidate.id === specialId)!.candidate
const black = tiles.find(tile => tile.candidate.id === 'main::black')!.candidate
const mainLayer = tiles.find(tile => tile.kind === 'layer' && tile.candidate.id === 'main')!.candidate
const sameIdSlot = tiles.find(tile => tile.kind === 'slot' && tile.candidate.id === 'main')!.candidate

// Compatible classification, owner scope and search are kept exactly. Mask
// classification is useful for masks and must not be replaced with all slots.
const compatible: DeveloperTileFilters = { tab: 'slots', layerId: 'main', search: ' EYE  skin/main ' }
assert.equal(repairDeveloperTileFilters(tiles, eye, compatible)!.filters, compatible)
const maskFilters: DeveloperTileFilters = { tab: 'masks', layerId: 'main', search: 'black' }
assert.equal(repairDeveloperTileFilters(tiles, black, maskFilters)!.filters, maskFilters)
const layerFilters: DeveloperTileFilters = { tab: 'layers', layerId: '', search: '主图' }
assert.equal(repairDeveloperTileFilters(tiles, mainLayer, layerFilters)!.filters, layerFilters)

// Fix only each blocking condition. A wrong scope targets the owning layer;
// searches that still match survive even when the classification changes.
assert.deepEqual(repairDeveloperTileFilters(tiles, eye, { ...compatible, tab: 'layers' })!.filters,
  { ...compatible, tab: 'slots' })
assert.deepEqual(repairDeveloperTileFilters(tiles, eye, { ...compatible, tab: 'masks' })!.filters,
  { ...compatible, tab: 'slots' })
assert.deepEqual(repairDeveloperTileFilters(tiles, eye, { ...compatible, layerId: 'back' })!.filters, compatible)
assert.deepEqual(repairDeveloperTileFilters(tiles, eye, { ...compatible, search: 'unrelated' })!.filters,
  { ...compatible, search: '' })
assert.deepEqual(repairDeveloperTileFilters(tiles, mainLayer, { tab: 'slots', layerId: 'back', search: 'missing' })!.filters,
  { tab: 'layers', layerId: 'main', search: '' })
const orphan = { ...tiles.find(tile => tile.kind === 'slot')!, kind: 'slot' as const, layer: undefined,
  candidate: { ...eye, id: 'orphan', layerId: 'missing-layer' } }
assert.equal(repairDeveloperTileFilters([orphan], orphan.candidate, { tab: 'slots', layerId: 'back', search: '' })!.filters.layerId, '')

// Identity uses kind + stable ID + owning layer. Display labels and attachment
// filenames never substitute for a missing object, including selector syntax.
assert.equal(repairDeveloperTileFilters(tiles, { ...eye, label: 'renamed', attachment: 'other' }, compatible)!.tile.candidate.id, specialId)
assert.equal(repairDeveloperTileFilters(tiles, { ...eye, layerId: 'back' }, compatible), null)
assert.equal(repairDeveloperTileFilters(tiles, { ...eye, id: 'not-found' }, compatible), null)
assert.equal(repairDeveloperTileFilters([], eye, compatible), null)
assert.notEqual(developerTileIdentity(mainLayer), developerTileIdentity(sameIdSlot))
assert.notEqual(developerTileIdentity(eye), developerTileIdentity({ ...eye, layerId: 'other' }))
assert.deepEqual(JSON.parse(developerTileIdentity(eye)), ['slot', specialId, 'main'])

// Old/null/mismatched-scene requests do not run or consume a new scene request.
// Collapsed requests wait; a completed request does not re-scroll on reopening,
// refresh or override updates. A new token re-locates even the same object.
const request: DeveloperTileLocateRequest = { sceneId: scene.id, candidate: eye, token: 12 }
assert.equal(eligibleDeveloperTileLocate(null, scene.id, true, -1), false)
assert.equal(eligibleDeveloperTileLocate(request, '', true, -1), false)
assert.equal(eligibleDeveloperTileLocate(request, 'gallery:new', true, -1), false)
assert.equal(eligibleDeveloperTileLocate(request, scene.id, false, -1), false)
assert.equal(eligibleDeveloperTileLocate(request, scene.id, true, -1), true)
assert.equal(eligibleDeveloperTileLocate(request, scene.id, true, 12), false)
assert.equal(eligibleDeveloperTileLocate({ ...request, token: 11 }, scene.id, true, 10, 12), false)
assert.equal(eligibleDeveloperTileLocate({ ...request, token: 13 }, scene.id, true, 12), true)
assert.equal(eligibleDeveloperTileLocate({ ...request, token: Number.NaN }, scene.id, true, -1), false)

// Centering is in the grid's scroll coordinates and clamps top/bottom, including
// borders and short lists. Hidden/invalid geometry waits rather than scrolling.
const metrics = { scrollTop: 300, scrollHeight: 2000, clientHeight: 400, gridTop: 100, clientTop: 2, tileTop: 350, tileHeight: 200 }
assert.equal(centeredDeveloperTileScroll(metrics), 448)
assert.equal(centeredDeveloperTileScroll({ ...metrics, scrollTop: 0, tileTop: 105 }), 0)
assert.equal(centeredDeveloperTileScroll({ ...metrics, tileTop: 5000 }), 1600)
assert.equal(centeredDeveloperTileScroll({ ...metrics, scrollHeight: 250 }), 0)
assert.equal(centeredDeveloperTileScroll({ ...metrics, clientHeight: 0 }), null)
assert.equal(centeredDeveloperTileScroll({ ...metrics, tileHeight: 0 }), null)
assert.equal(centeredDeveloperTileScroll({ ...metrics, tileTop: Number.NaN }), null)

console.log('Developer tile navigation checks passed: minimal filters, exact identity, request lifecycle, and centered grid scroll.')
