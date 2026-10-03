import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { BoneData, ClippingAttachment, MeshAttachment, RegionAttachment, Skeleton, SkeletonData, Skin, SlotData } from '@esotericsoftware/spine-core'
import type { DeveloperOverrides, DeveloperSceneHandle } from './src/developerControls.ts'

registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier)) {
    try { return nextResolve(`${specifier}.ts`, context) }
    catch { /* Delegate regular errors to Node. */ }
  }
  return nextResolve(specifier, context)
} })
const { createDeveloperScene } = await import('./src/developerScene.ts')
const { emptyDeveloperOverrides, developerSlotId } = await import('./src/developerControls.ts')
const { suppressOversizedCameraMatte } = await import('./src/spineCameraMatte.ts')
const { suppressedCameraMatteAttachments } = await import('./src/spineCameraMatte.ts')
const { createParticleSlotFilter } = await import('./src/spineParticleVisibility.ts')

function fakeSpine() {
  const data = new SkeletonData()
  const bone = new BoneData(0, 'root', null)
  data.bones.push(bone)
  for (const name of ['clip', 'body', 'blackShadow', 'inactive']) data.slots.push(new SlotData(data.slots.length, name, bone))
  const defaultSkin = new Skin('default')
  const variantSkin = new Skin('another-skin')
  defaultSkin.setAttachment(0, 'clip-boundary', new ClippingAttachment('clip-boundary'))
  defaultSkin.setAttachment(1, 'body-A', new MeshAttachment('body-A'))
  defaultSkin.setAttachment(2, 'shadow-A', new RegionAttachment('shadow-A'))
  variantSkin.setAttachment(1, 'body-B', new MeshAttachment('body-B'))
  variantSkin.setAttachment(2, 'shadow-A', new RegionAttachment('shadow-A'))
  variantSkin.setAttachment(3, 'black-mask-inactive', new RegionAttachment('black-mask-inactive'))
  data.defaultSkin = defaultSkin
  data.skins.push(defaultSkin, variantSkin)
  const skeleton = new Skeleton(data)
  for (let index = 0; index < skeleton.slots.length; index++) {
    skeleton.slots[index].attachment = defaultSkin.getAttachment(index, ['clip-boundary', 'body-A', 'shadow-A', 'none'][index])
    skeleton.slots[index].color.a = .9 - index * .1
    skeleton.slots[index].deform.push(.1, -3.5)
    skeleton.slots[index].sequenceIndex = 2
  }
  skeleton.drawOrder.reverse()
  let draw = () => {}
  const object = { visible: true, alpha: .8, mask: null as object | null, skeleton,
    state: { tracks: [{ animation: { name: 'idle', duration: 2 }, trackTime: .75 }, null,
      { animation: { name: 'click8', duration: 5.6 }, trackTime: 1.5 }] },
    updateTransform() { draw() }, setDraw(callback: () => void) { draw = callback },
  }
  return object
}
function savedSlots(spine: ReturnType<typeof fakeSpine>) {
  return spine.skeleton.slots.map(slot => ({ attachment: slot.attachment, alpha: slot.color.a,
    deform: slot.deform, vertices: [...slot.deform], sequence: slot.sequenceIndex }))
}
function assertSlots(spine: ReturnType<typeof fakeSpine>, expected: ReturnType<typeof savedSlots>) {
  for (const [index, slot] of spine.skeleton.slots.entries()) {
    assert.equal(slot.attachment, expected[index].attachment)
    assert.equal(slot.color.a, expected[index].alpha)
    assert.equal(slot.deform, expected[index].deform)
    assert.deepEqual(slot.deform, expected[index].vertices)
    assert.equal(slot.sequenceIndex, expected[index].sequence)
  }
}

let overrides: DeveloperOverrides | null = null
let getCalls = 0
const handles = new Map<string, DeveloperSceneHandle>()
let registrations = 0, unregistrations = 0
const api = { getOverrides(id: string) { assert.equal(id, 'scene:test'); getCalls++; return overrides },
  registerScene(handle: DeveloperSceneHandle) {
    registrations++; handles.set(handle.id, handle)
    return () => { unregistrations++; if (handles.get(handle.id) === handle) handles.delete(handle.id) }
  } }
let renderCheck: (...args: unknown[]) => void = () => {}
let renderCalls = 0
const renderer = { render(...args: unknown[]) { assert.equal(this, renderer); renderCalls++; renderCheck(...args) } }
const app = { renderer }
const priorRender = renderer.render
const main = fakeSpine()
const other = fakeSpine()
const priorMainTransform = main.updateTransform
const priorOtherTransform = other.updateTransform
const mask = { name: 'external-mask' }
const background = { visible: false, alpha: .25, mask: mask as object | null }
const scene = createDeveloperScene(app as never, 'scene:test', '测试画面', api)
const backgroundId = scene.addLayer(background as never, 'background', '背景', 'image', 'background/asset')
const mainId = scene.addSpine(main as never, 'character/asset', '主立绘', 'main')
const otherId = scene.addSpine(other as never, 'character/asset', '另一立绘', 'auxiliary')
assert.notEqual(mainId, otherId)
assert.equal(scene.addLayer(background as never, 'unused-key', '重复背景'), backgroundId)
scene.publish()
assert.equal(registrations, 1)
assert.equal(handles.size, 1)
const snapshot = handles.get('scene:test')!.snapshot()
assert.equal(snapshot.layers.length, 3)
assert.equal(snapshot.slots.length, 8)
assert(snapshot.layers.find(layer => layer.id === backgroundId)!.kind.includes('外部裁切'))
const body = snapshot.slots.find(slot => slot.id === developerSlotId(mainId, 'body'))!
assert.equal(body.type, 'mesh')
assert.equal(body.attachment, 'body-A')
assert.deepEqual(body.attachments, ['body-A', 'body-B'], 'Enumerate attachment alternatives from every skin')
assert.equal(body.order, 2, 'Snapshot reflects live draw order')
const inactive = snapshot.slots.find(slot => slot.id === developerSlotId(mainId, 'inactive'))!
assert.equal(inactive.attachment, null)
assert.deepEqual(inactive.attachments, ['black-mask-inactive'])
assert.equal(inactive.maskCandidate, true)
assert.equal(snapshot.slots.find(slot => slot.id === developerSlotId(mainId, 'clip'))!.type, 'clipping')
assert.equal(snapshot.tracks!.length, 4)
assert.deepEqual(snapshot.tracks![1], { layerId: mainId, track: 2, animation: 'click8', time: 1.5, duration: 5.6 })

const baselineMain = savedSlots(main)
const baselineOther = savedSlots(other)
const assertNormal = () => {
  assert.deepEqual([background.visible, background.alpha, background.mask], [false, .25, mask])
  assert.deepEqual([main.visible, main.alpha, main.mask], [true, .8, null])
  assert.deepEqual([other.visible, other.alpha], [true, .8])
  assertSlots(main, baselineMain); assertSlots(other, baselineOther)
}
const stage = { name: 'stage' }, options = { clear: false }
renderCheck = (...args) => { assert.deepEqual(args, [stage, options]); assertNormal(); main.updateTransform(); other.updateTransform() }
renderer.render(stage, options)
assertNormal()

overrides = emptyDeveloperOverrides()
overrides.layers[backgroundId] = { hidden: false, opacity: .4, disableClipping: true }
overrides.layers[mainId] = { opacity: .5 }
overrides.layers[otherId] = { hidden: true }
overrides.slots[developerSlotId(mainId, 'body')] = { opacity: .3 }
overrides.slots[developerSlotId(mainId, 'blackShadow')] = { hidden: true }
let transformed = 0
main.setDraw(() => {
  transformed++
  assert.equal(main.skeleton.slots[1].color.a, baselineMain[1].alpha * .3)
  assert.equal(main.skeleton.slots[2].attachment, null)
  assert.equal(main.skeleton.slots[0].attachment, baselineMain[0].attachment)
})
renderCheck = () => {
  assert.deepEqual([background.visible, background.alpha, background.mask], [true, .1, null])
  assert.deepEqual([main.visible, main.alpha], [true, .4])
  assert.equal(other.visible, false)
  main.updateTransform()
}
for (let repeat = 0; repeat < 3; repeat++) { renderer.render(stage, options); assertNormal() }
assert.equal(transformed, 3)
assert.equal(main.state.tracks[2]!.trackTime, 1.5, 'Paused draw must not advance track time')
main.setDraw(() => { throw new Error('transform failure') })
assert.throws(() => renderer.render(stage, options), /transform failure/)
assertNormal()
renderCheck = () => { assert.equal(background.mask, null); throw new Error('renderer failure') }
assert.throws(() => renderer.render(stage, options), /renderer failure/)
assertNormal()

overrides = null
main.setDraw(() => assertSlots(main, baselineMain))
renderCheck = () => { assertNormal(); main.updateTransform() }
renderer.render(stage, options)
assertNormal()
scene.publish()
assert.equal(registrations, 2)
assert.equal(unregistrations, 1)
assert.equal(handles.size, 1)
scene.dispose()
assert.equal(handles.size, 0)
assert.equal(unregistrations, 2)
assert.equal(renderer.render, priorRender)
assert.equal(main.updateTransform, priorMainTransform)
assert.equal(other.updateTransform, priorOtherTransform)
scene.dispose(); scene.publish()
assert.equal(unregistrations, 2, 'Cleanup is idempotent')
assert.equal(registrations, 2, 'A disposed scene cannot publish again')
const getsAfterDispose = getCalls
renderer.render(stage, options)
main.updateTransform()
assert.equal(getCalls, getsAfterDispose, 'Disposed hooks do not ask for developer controls')

// Four oversized camera mattes are suppressed by the ordinary free-framing
// renderer. Explicit developer hidden:false can reveal them temporarily.
const matteSpine = fakeSpine()
const matteData = new SkeletonData()
const matteBone = new BoneData(0, 'root', null)
matteData.bones.push(matteBone)
const edges = [[0, 0, 200, 0], [0, 200, 200, 200], [0, 0, 0, 200], [200, 0, 200, 200]]
for (let index = 0; index < edges.length; index++) matteData.slots.push(new SlotData(index, `black-matte-${index}`, matteBone))
matteSpine.skeleton = new Skeleton(matteData)
for (const [index, slot] of matteSpine.skeleton.slots.entries()) {
  const attachment = new MeshAttachment('camera-matte')
  attachment.worldVerticesLength = 12
  attachment.computeWorldVertices = (_slot, _start, _count, output, offset, stride) => {
    const vertices = [-1000, -1000, 1000, -1000, -1000, 1000, 1000, 1000, ...edges[index]]
    for (let point = 0; point < 6; point++) { output[offset + point * stride] = vertices[point * 2]; output[offset + point * stride + 1] = vertices[point * 2 + 1] }
  }
  slot.attachment = attachment
  slot.deform.push(11, 22)
}
suppressOversizedCameraMatte(matteSpine as never)
assert(matteSpine.skeleton.slots.every(slot => slot.attachment === null))
const matteBaseline = savedSlots(matteSpine)
let matteOverrides: DeveloperOverrides | null = emptyDeveloperOverrides()
const matteApi = { getOverrides: () => matteOverrides, registerScene: (handle: DeveloperSceneHandle) => {
  handles.set(handle.id, handle); return () => { handles.delete(handle.id) }
} }
const matteScene = createDeveloperScene(app as never, 'scene:matte', '画框', matteApi)
const matteId = matteScene.addSpine(matteSpine as never, 'matte/asset', '画框')
matteScene.publish()
assert.equal(handles.get('scene:matte')!.snapshot().slots[0].attachment, 'camera-matte')
matteOverrides.slots[developerSlotId(matteId, 'black-matte-0')] = { hidden: false, opacity: .5 }
matteSpine.setDraw(() => {
  assert.equal(matteSpine.skeleton.slots[0].attachment!.name, 'camera-matte')
  assert.equal(matteSpine.skeleton.slots[0].color.a, .5)
  assert(matteSpine.skeleton.slots.slice(1).every(slot => slot.attachment === null))
})
matteSpine.updateTransform()
assertSlots(matteSpine, matteBaseline)
matteSpine.setDraw(() => { throw new Error('matte draw failure') })
assert.throws(() => matteSpine.updateTransform(), /matte draw failure/)
assertSlots(matteSpine, matteBaseline)
matteOverrides = null
matteSpine.setDraw(() => assertSlots(matteSpine, matteBaseline))
matteSpine.updateTransform()
matteScene.dispose()
assert.equal(renderer.render, priorRender)
assert.equal(handles.size, 0)

// The integrated renderer keeps the local particle wrapper inside the
// developer wrapper. Exiting developer mode must retain that original wrapper.
const particleSpine = fakeSpine()
particleSpine.skeleton.slots[1].data.name = 'fx_1'
const filterParticles = createParticleSlotFilter(particleSpine.skeleton.slots)
const nativeTransform = particleSpine.updateTransform.bind(particleSpine)
let particlesVisible = false
const particleTransform = () => filterParticles(particlesVisible, nativeTransform)
particleSpine.updateTransform = particleTransform
const particleBaseline = savedSlots(particleSpine)
let particleOverrides: DeveloperOverrides | null = emptyDeveloperOverrides()
const particleScene = createDeveloperScene(app as never, 'scene:particles', '粒子组合', {
  getOverrides: () => particleOverrides, registerScene: () => () => {},
})
const particleId = particleScene.addSpine(particleSpine as never, 'particle/asset', '粒子立绘', 'main')
particleOverrides.slots[developerSlotId(particleId, 'fx_1')] = { opacity: .5 }
particleOverrides.slots[developerSlotId(particleId, 'blackShadow')] = { hidden: true }
particleSpine.setDraw(() => {
  assert.equal(particleSpine.skeleton.slots[1].attachment, null, 'Local particle setting still controls draw')
  assert.equal(particleSpine.skeleton.slots[1].color.a, particleBaseline[1].alpha * .5)
  assert.equal(particleSpine.skeleton.slots[2].attachment, null)
})
particleSpine.updateTransform(); assertSlots(particleSpine, particleBaseline)
particlesVisible = true
particleSpine.setDraw(() => {
  assert.equal(particleSpine.skeleton.slots[1].attachment, particleBaseline[1].attachment)
  assert.equal(particleSpine.skeleton.slots[1].color.a, particleBaseline[1].alpha * .5)
  assert.equal(particleSpine.skeleton.slots[2].attachment, null)
})
particleSpine.updateTransform(); assertSlots(particleSpine, particleBaseline)
particlesVisible = false
particleSpine.setDraw(() => { throw new Error('combined draw failure') })
assert.throws(() => particleSpine.updateTransform(), /combined draw failure/)
assertSlots(particleSpine, particleBaseline)
particleOverrides = null
particleSpine.setDraw(() => {
  assert.equal(particleSpine.skeleton.slots[1].attachment, null)
  assert.equal(particleSpine.skeleton.slots[1].color.a, particleBaseline[1].alpha)
  assert.equal(particleSpine.skeleton.slots[2].attachment, particleBaseline[2].attachment)
})
particleSpine.updateTransform(); assertSlots(particleSpine, particleBaseline)
particleScene.dispose()
assert.equal(particleSpine.updateTransform, particleTransform, 'Dispose restores the local particle draw hook, not an unfiltered hook')
particleSpine.updateTransform(); assertSlots(particleSpine, particleBaseline)
assert.equal(renderer.render, priorRender)

// Shared SkeletonData caches only the signature/slot names. Suppressed
// attachments and paused deforms remain owned by their individual skeletons.
const firstMatte = suppressedCameraMatteAttachments(matteSpine as never)!.get('black-matte-0')!
const secondMatteSpine = fakeSpine()
secondMatteSpine.skeleton = new Skeleton(matteData)
const secondMatte = new MeshAttachment('camera-matte')
secondMatteSpine.skeleton.slots[0].attachment = secondMatte
secondMatteSpine.skeleton.slots[0].deform.push(31, -8)
suppressOversizedCameraMatte(secondMatteSpine as never)
assert.equal(secondMatteSpine.skeleton.slots[0].attachment, null)
assert.deepEqual(secondMatteSpine.skeleton.slots[0].deform, [31, -8])
assert.equal(suppressedCameraMatteAttachments(secondMatteSpine as never)!.get('black-matte-0'), secondMatte)
assert.equal(suppressedCameraMatteAttachments(matteSpine as never)!.get('black-matte-0'), firstMatte)
assert.notEqual(firstMatte, secondMatte)

console.log(JSON.stringify({ developerScene: 'passed', renderCalls,
  verified: 'all-skin enumeration, layer/slot draw isolation, paused state, throw restoration, disabled mode, suppression reveal, local particle hook composition, instance matte isolation and cleanup' }))
