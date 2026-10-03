import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { BoneData, ClippingAttachment, MeshAttachment, RegionAttachment, Skeleton, SkeletonData, SlotData } from '@esotericsoftware/spine-core'
import type { DeveloperOverrides, DeveloperScene } from './src/developerControls.ts'

// The app uses extensionless Bundler imports. Resolve those same source modules
// under Node's type stripping without copying or rewriting the implementation.
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier)) {
    try { return nextResolve(`${specifier}.ts`, context) }
    catch { /* Let Node report its regular error for other imports. */ }
  }
  return nextResolve(specifier, context)
} })

const { createDeveloperSlotFilter, developerLayerPresentation, developerSlotId,
  emptyDeveloperOverrides, capriccioMaskOverrides } = await import('./src/developerControls.ts')
const { createDeveloperPreset, presetsForScene, applyDeveloperPreset, exportDeveloperPresets,
  importDeveloperPresets, mergeDeveloperPresets, loadDeveloperPresets, persistDeveloperPresets,
  validateDeveloperOverrides, DEVELOPER_PRESET_STORAGE_KEY, MAX_DEVELOPER_PRESETS } = await import('./src/developerPresets.ts')
const { CAPRICCIO_MASK_ASSET } = await import('./src/developerMask.ts')

const data = new SkeletonData()
const bone = new BoneData(0, 'root', null)
data.bones.push(bone)
for (const name of ['clip', 'character', 'shadow', 'matte']) data.slots.push(new SlotData(data.slots.length, name, bone))
const skeleton = new Skeleton(data)
const attachments = [new ClippingAttachment('clip'), new MeshAttachment('body'), new RegionAttachment('black'), new RegionAttachment('frame')]
for (const [index, slot] of skeleton.slots.entries()) {
  slot.attachment = attachments[index]
  slot.color.a = .8 - index * .1
  slot.deform.push(.25, 2, -4)
  slot.sequenceIndex = 3
}
const filter = createDeveloperSlotFilter(skeleton.slots, 'main')
const baseline = () => skeleton.slots.map(slot => ({ attachment: slot.attachment, alpha: slot.color.a,
  deform: slot.deform, vertices: [...slot.deform], sequence: slot.sequenceIndex }))
const saved = baseline()
const restored = () => skeleton.slots.forEach((slot, i) => {
  assert.equal(slot.attachment, saved[i].attachment)
  assert.equal(slot.color.a, saved[i].alpha)
  assert.equal(slot.deform, saved[i].deform)
  assert.deepEqual(slot.deform, saved[i].vertices)
  assert.equal(slot.sequenceIndex, saved[i].sequence)
})
let draws = 0
filter(null, () => { draws++; restored() })
filter(emptyDeveloperOverrides(), () => { draws++; restored() })
assert.equal(draws, 2)

const overrides = emptyDeveloperOverrides()
overrides.slots[developerSlotId('main', 'shadow')] = { hidden: true }
overrides.slots[developerSlotId('main', 'character')] = { opacity: .5 }
overrides.slots[developerSlotId('main', 'clip')] = { hidden: true, opacity: 0 }
filter(overrides, () => {
  assert.equal(skeleton.slots[2].attachment, null)
  assert.equal(skeleton.slots[1].color.a, saved[1].alpha * .5)
  assert.equal(skeleton.slots[0].attachment, attachments[0], 'Ordinary eye toggle must preserve clipping')
  assert.equal(skeleton.slots[0].color.a, saved[0].alpha)
  assert.equal(skeleton.slots[3].attachment, attachments[3], 'Frame matte must be unchanged')
})
restored()
for (let repeat = 0; repeat < 3; repeat++) {
  filter(overrides, () => assert.equal(skeleton.slots[1].color.a, saved[1].alpha * .5))
  restored()
}
assert.throws(() => filter(overrides, () => { throw new Error('draw failed') }), /draw failed/)
restored()

overrides.slots[developerSlotId('main', 'clip')] = { disableClipping: true }
filter(overrides, () => assert.equal(skeleton.slots[0].attachment, null))
restored()
overrides.slots[developerSlotId('main', 'clip')] = {}
overrides.solo = { kind: 'slot', id: developerSlotId('main', 'shadow') }
filter(overrides, () => {
  assert.equal(skeleton.slots[0].attachment, attachments[0], 'Solo retains original clipping boundaries')
  assert.equal(skeleton.slots[1].attachment, null)
  assert.equal(skeleton.slots[2].attachment, attachments[2], 'Solo inspects its target even if hidden flag was set')
  assert.equal(skeleton.slots[3].attachment, null)
})
restored()
const other = createDeveloperSlotFilter(skeleton.slots, 'other')
other({ layers: {}, slots: overrides.slots }, restored)
other(overrides, () => assert(skeleton.slots.slice(1).every(slot => slot.attachment === null)))
restored()

assert.deepEqual(developerLayerPresentation('main', false, .6, null), { visible: false, opacity: .6 })
assert.deepEqual(developerLayerPresentation('main', false, .6, { layers: { main: { hidden: false, opacity: .5 } }, slots: {} }), { visible: true, opacity: .3 })
assert.equal(developerLayerPresentation('main', false, 1, overrides).visible, true)
assert.equal(developerLayerPresentation('other', true, 1, overrides).visible, false)
assert.equal(developerLayerPresentation('main', true, 1, { layers: {}, slots: {}, solo: { kind: 'layer', id: 'other' } }).visible, false)
assert.equal(developerLayerPresentation('main', true, 1, { layers: { main: { hidden: true } }, slots: {} }).visible, false)

const scene: DeveloperScene = { id: 'capriccio:04b', label: '随想曲04B', layers: [
  { id: 'main', label: '主立绘', assetId: CAPRICCIO_MASK_ASSET, kind: 'main', visible: true, opacity: 1 },
  { id: 'other', label: '另一层', assetId: 'another/asset', kind: 'background', visible: false, opacity: 1 },
], slots: ['heidian', 'heiying1', 'tx_heiping4'].flatMap((name, order) => ['main', 'other'].map(layerId => ({
  id: developerSlotId(layerId, name), layerId, name, order, type: 'region', attachment: name,
  attachments: [name], alpha: 1, maskCandidate: true,
}))) }
const builtIn = capriccioMaskOverrides(scene)!
assert.deepEqual(Object.keys(builtIn.slots), ['main::heidian', 'main::heiying1'])
assert.equal(capriccioMaskOverrides({ ...scene, layers: scene.layers.slice(1) }), null)

const preset = createDeveloperPreset(scene.id, '去黑影', { ...builtIn, solo: { kind: 'slot', id: 'main::heidian' } }, 1000)
const serialized = exportDeveloperPresets([preset])
const imported = importDeveloperPresets(serialized)
assert.deepEqual(imported, [preset])
assert.notEqual(imported[0].overrides.slots, preset.overrides.slots)
assert.deepEqual(applyDeveloperPreset(imported[0], scene), preset.overrides)
assert.equal(applyDeveloperPreset(imported[0], { ...scene, id: 'different:skin' }), null)
assert.deepEqual(presetsForScene(imported, 'different:skin'), [])
const missing = createDeveloperPreset(scene.id, '过期槽位', { layers: { gone: { hidden: true } }, slots: { 'gone::slot': { opacity: .2 } }, solo: { kind: 'slot', id: 'gone::slot' } }, 1000)
assert.deepEqual(applyDeveloperPreset(missing, scene), emptyDeveloperOverrides())
assert.equal(mergeDeveloperPresets([preset], [{ ...preset, name: '新版', updatedAt: 1001 }])[0].name, '新版')

const store = new Map<string, string>()
const storage = { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => { store.set(key, value) } }
assert.equal(persistDeveloperPresets(imported, storage), true)
assert.deepEqual(loadDeveloperPresets(storage), imported)
const blocked = { getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('quota') } }
assert.deepEqual(loadDeveloperPresets(blocked), [])
assert.equal(persistDeveloperPresets(imported, blocked), false)
store.set(DEVELOPER_PRESET_STORAGE_KEY, '{broken')
assert.deepEqual(loadDeveloperPresets(storage), [])

for (const bad of [
  '{broken', '{"version":2,"presets":[]}', '{"version":1,"presets":[],"surprise":true}',
  JSON.stringify({ version: 1, presets: [preset, preset] }),
  JSON.stringify({ version: 1, presets: [{ ...preset, overrides: { layers: {}, slots: { mask: { opacity: 1.1 } } } }] }),
  JSON.stringify({ version: 1, presets: [{ ...preset, overrides: { layers: {}, slots: { mask: { hidden: 'yes' } } } }] }),
  JSON.stringify({ version: 1, presets: [{ ...preset, overrides: { layers: {}, slots: { mask: { attachment: 'evil' } } } }] }),
  JSON.stringify({ version: 1, presets: [{ ...preset, overrides: { layers: {}, slots: {}, solo: { kind: 'unknown', id: 'main' } } }] }),
  JSON.stringify({ version: 1, presets: [{ ...preset, createdAt: 2000 }] }),
  JSON.stringify({ version: 1, presets: Array.from({ length: MAX_DEVELOPER_PRESETS + 1 }, (_, i) => ({ ...preset, id: `${i}` })) }),
]) assert.throws(() => importDeveloperPresets(bad), /开发者预设无效/)
assert.throws(() => validateDeveloperOverrides({ layers: {}, slots: { mask: { opacity: Number.NaN } } }), /透明度/)
assert.throws(() => validateDeveloperOverrides(JSON.parse('{"layers":{},"slots":{"__proto__":{"hidden":true}}}')), /保留/)
assert.throws(() => importDeveloperPresets(' '.repeat(4 * 1024 * 1024 + 1)), /过大/)

console.log(JSON.stringify({ developerControls: 'passed', renderIsolation: 'attachment/alpha/deform/clip/solo/finally',
  presets: 'scene scope, explicit application, round trip, validation and storage failure passed' }))
