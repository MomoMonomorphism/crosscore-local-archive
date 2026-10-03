import assert from 'node:assert/strict'
import { canDisableDeveloperLayerClipping, createDeveloperLayerTiles, developerTileState,
  filterDeveloperLayerTiles, isSelectedDeveloperTile } from './src/developerLayerTileModel.ts'
import type { DeveloperOverrides, DeveloperScene } from './src/developerControls.ts'

const scene: DeveloperScene = { id: 'gallery:test', label: '角色', layers: [
  { id: 'main', label: '角色主图', assetId: 'skin/test', kind: 'spine', visible: true, opacity: 1 },
  { id: 'native-hidden', label: '原始隐藏背景', assetId: 'background', kind: 'image', visible: false, opacity: 1 },
  { id: 'external', label: '互动图片', assetId: 'ui/image', kind: '互动图片 · 矩形裁切 · 材质遮罩/溶解', visible: true, opacity: 1 },
  { id: 'matte', label: '黑影遮罩', assetId: 'black-matte', kind: 'matte', visible: true, opacity: 1 },
], slots: [
  { id: 'main::eyes', layerId: 'main', name: 'Eyes', type: 'mesh', attachment: 'closed', attachments: ['open', 'closed'], alpha: 1, maskCandidate: false, order: 3 },
  { id: 'main::clip', layerId: 'main', name: 'Clipping', type: 'clipping', attachment: 'clip', attachments: ['clip'], alpha: 0, maskCandidate: false, order: 1 },
  { id: 'main::black', layerId: 'main', name: 'black-shape', type: 'region', attachment: 'black_1', attachments: ['black_1'], alpha: 1, maskCandidate: true, order: 7 },
  { id: 'main::empty', layerId: 'main', name: 'empty', type: 'empty', attachment: null, attachments: ['later'], alpha: 0, maskCandidate: false, order: 4 },
] }
const tiles = createDeveloperLayerTiles(scene)
const ids = (values: typeof tiles) => values.map(tile => tile.candidate.id)
const empty: DeveloperOverrides = { layers: {}, slots: {} }
const tile = (id: string) => tiles.find(item => item.candidate.id === id)!

// Layer browsing includes authored hidden objects and external masks without
// slots. No override/visibility flag is allowed to silently remove a tile.
assert.deepEqual(ids(filterDeveloperLayerTiles(tiles, 'layers', '', '')), ['main', 'native-hidden', 'external', 'matte'])
assert.equal(filterDeveloperLayerTiles(tiles, 'slots', '', '').length, 4)
assert.deepEqual(ids(filterDeveloperLayerTiles(tiles, 'masks', '', '')), ['external', 'matte', 'main::clip', 'main::black'])
assert.deepEqual(createDeveloperLayerTiles(null), [])
assert.deepEqual(filterDeveloperLayerTiles([], 'masks', '', ''), [])

// Scope and multiple search terms combine; search covers available attachments
// as well as the current attachment, owner material, source, and type.
assert.deepEqual(ids(filterDeveloperLayerTiles(tiles, 'slots', 'main', 'OPEN SKIN/test')), ['main::eyes'])
assert.deepEqual(ids(filterDeveloperLayerTiles(tiles, 'masks', 'main', '')), ['main::clip', 'main::black'])
assert.deepEqual(ids(filterDeveloperLayerTiles(tiles, 'layers', 'external', '材质 遮罩')), ['external'])
assert.deepEqual(filterDeveloperLayerTiles(tiles, 'slots', 'removed-layer', ''), [])
assert.deepEqual(filterDeveloperLayerTiles(tiles, 'layers', '', 'absent'), [])

// A generic black matte has a hide control, not a clipping control that its
// renderer would ignore. Explicit DOM/material and external clip kinds bypass.
assert.equal(canDisableDeveloperLayerClipping(scene.layers[2]), true)
assert.equal(canDisableDeveloperLayerClipping(scene.layers[3]), false)
assert.equal(canDisableDeveloperLayerClipping({ ...scene.layers[0], kind: 'spine · 外部裁切' }), true)

// Fresh tile candidates address the original IDs and carry current attachment
// metadata, including null. Identity must include kind as well as id.
assert.equal(tile('main::empty').candidate.attachment, null)
assert.equal(tile('main::eyes').candidate.order, 3)
assert.equal(isSelectedDeveloperTile(tile('main'), { id: 'main', kind: 'slot', layerId: 'main', label: 'same id' }), false)
assert.equal(isSelectedDeveloperTile(tile('main'), { id: 'main', kind: 'layer', layerId: 'main', label: 'new label' }), true)
assert.equal(isSelectedDeveloperTile(tile('main'), null), false)

// Native hidden layers are reported as hidden until the user explicitly forces
// visibility. Returning to an empty rule resumes the native state.
assert.equal(developerTileState(tile('native-hidden'), empty).allowed, false)
assert.equal(developerTileState(tile('native-hidden'), { layers: { 'native-hidden': { hidden: false } }, slots: {} }).status, '显示')
assert.equal(developerTileState(tile('native-hidden'), empty).status, '已隐藏')

// Slot status explains owner visibility/opacity and missing attachments. Solo
// does not claim transparent artwork has appeared, and preserves the selection.
assert.equal(developerTileState(tile('main::eyes'), { layers: { main: { hidden: true } }, slots: {} }).status, '所属层隐藏')
assert.equal(developerTileState(tile('main::eyes'), { layers: { main: { opacity: 0 } }, slots: {} }).status, '所属层透明')
const soloEmpty = developerTileState(tile('main::empty'), { ...empty, solo: { kind: 'slot', id: 'main::empty' } })
assert.equal(soloEmpty.isSolo, true)
assert.equal(soloEmpty.status, '当前无附件')
const soloTransparent = developerTileState(tile('main::eyes'), { layers: {}, slots: { 'main::eyes': { opacity: 0 } }, solo: { kind: 'slot', id: 'main::eyes' } })
assert.equal(soloTransparent.status, '当前透明')
assert.equal(soloTransparent.forcedVisible, true)
assert.equal(developerTileState(tile('main::black'), { ...empty, solo: { kind: 'slot', id: 'main::eyes' } }).status, '独显排除')

// Geometry clips remain active when isolating another slot in their own layer;
// ordinary hidden/opacity rules do not falsely report the clipping as disabled.
const clipped = developerTileState(tile('main::clip'), { layers: {}, slots: { 'main::clip': { hidden: true, opacity: 0 } }, solo: { kind: 'slot', id: 'main::eyes' } })
assert.equal(clipped.status, '裁切启用')
assert.equal(clipped.excluded, false)
assert.equal(developerTileState(tile('main::clip'), { layers: {}, slots: { 'main::clip': { disableClipping: true } } }).status, '裁切禁用')
assert.equal(developerTileState(tile('main::eyes'), empty).modified, false)
assert.equal(developerTileState(tile('main::eyes'), { layers: {}, slots: { 'main::eyes': { hidden: true } } }).modified, true)

console.log('Developer layer tiles checks passed: filters, masks, native visibility, selection, and clipping state.')
