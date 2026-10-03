import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { BoneData, ClippingAttachment, Color, MeshAttachment, Skeleton, SkeletonClipping, SkeletonData, SlotData } from '@esotericsoftware/spine-core'
import { SlotMesh } from '@esotericsoftware/spine-pixi-v7'
import type { DeveloperOverrides, DeveloperSceneHandle } from './src/developerControls.ts'

registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier)) {
    try { return nextResolve(`${specifier}.ts`, context) } catch { /* Delegate to Node. */ }
  }
  return nextResolve(specifier, context)
} })
const { developerClientPoint, developerTriangleHit, developerGeometryOutline, developerSurfaceVisible } = await import('./src/developerPicking.ts')
const { createDeveloperScene } = await import('./src/developerScene.ts')
const { emptyDeveloperOverrides, developerSlotId } = await import('./src/developerControls.ts')

const matrix = { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 }
const surface = { width: 800, height: 400, getBoundingClientRect: () => ({ left: 20, top: 30, width: 400, height: 200 }), getClientRects: () => [1] }
assert.deepEqual(developerClientPoint(surface, { width: 200, height: 100 }, 220, 130), { x: 100, y: 50 })
assert.equal(developerClientPoint(surface, { width: 200, height: 100 }, 19, 130), null)
assert.equal(developerClientPoint(surface, { width: 0, height: 100 }, 220, 130), null)
const quad = { positions: [0, 0, 10, 0, 10, 10, 0, 10], indices: [0, 1, 2, 0, 2, 3], matrix }
assert(developerTriangleHit(quad, { x: 5, y: 5 }))
assert(!developerTriangleHit(quad, { x: 15, y: 5 }))
assert.equal(developerGeometryOutline(quad).length, 4, 'No interior triangle edge in outline')
const reversed = { ...quad, matrix: { a: -2, b: .5, c: 1, d: 3, tx: 100, ty: 50 } }
assert(developerTriangleHit(reversed, { x: 98, y: 57 }))
assert(!developerTriangleHit({ ...quad, matrix: { ...matrix, a: 0 } }, { x: 0, y: 5 }))
assert(!developerTriangleHit({ ...quad, positions: [0, 0, 1, 1, 2, 2], indices: [0, 1, 2] }, { x: 1, y: 1 }))
assert(developerTriangleHit({ ...quad, indices: [0, 2, 1, 0, 3, 2] }, { x: 5, y: 5 }), 'Both triangle windings work')

type Obj = ReturnType<typeof object>
function object(name: string) {
  return { name, visible: true, renderable: true, alpha: 1, mask: null as unknown,
    worldTransform: { ...matrix }, parent: null as Obj | null, children: [] as Obj[],
    addChild(child: Obj) { this.children.push(child); child.parent = this; return child },
  }
}
function mesh(name: string) {
  const vertices = { data: new Float32Array(), update() {} }, uvs = { data: new Float32Array(), update() {} }
  const index = { data: new Uint32Array(), update() {} }
  return { ...object(name), texture: { tag: 'fixture' }, tint: [1, 1, 1, 1], warnedTwoTint: false,
    geometry: { getBuffer(key: string) { return key === 'aVertexPosition' ? vertices : uvs }, indexBuffer: index } }
}
function spine(name: string, clipped: boolean) {
  const data = new SkeletonData(), bone = new BoneData(0, 'root', null)
  data.bones.push(bone)
  for (const slotName of ['clip', 'body']) data.slots.push(new SlotData(data.slots.length, slotName, bone))
  const skeleton = new Skeleton(data)
  skeleton.bones[0].active = true
  skeleton.bones[0].a = 1; skeleton.bones[0].b = 0; skeleton.bones[0].c = 0; skeleton.bones[0].d = 1
  const clipping = new ClippingAttachment('clip-boundary')
  clipping.worldVerticesLength = 8; clipping.vertices = [0, 0, 5, 0, 5, 5, 0, 5]; clipping.endSlot = data.slots[1]
  skeleton.slots[0].attachment = clipped ? clipping : null
  const body = new MeshAttachment('body-image')
  skeleton.slots[1].attachment = body
  skeleton.slots[1].deform.push(2, -3)
  const display = { ...object(name), skeleton, state: { tracks: [] }, meshesCache: new Map(),
    updateTransform() {
      rendered.visible = Boolean(skeleton.slots[1].attachment)
      if (!rendered.visible) return
      const color = new Color(1, 1, 1, skeleton.slots[1].color.a)
      let vertices: ArrayLike<number>, triangles: ArrayLike<number>
      if (skeleton.slots[0].attachment instanceof ClippingAttachment) {
        const clipper = new SkeletonClipping()
        clipper.clipStart(skeleton.slots[0], skeleton.slots[0].attachment)
        clipper.clipTriangles(quad.positions, quad.indices, quad.indices.length, [0, 0, 1, 0, 1, 1, 0, 1], color, new Color(0, 0, 0, 1), false)
        vertices = clipper.clippedVertices; triangles = clipper.clippedTriangles
      } else {
        vertices = quad.positions.flatMap((_, index) => index % 2 ? [] : [quad.positions[index], quad.positions[index + 1], 1, 1, 1, color.a, 0, 0])
        triangles = quad.indices
      }
      // The real renderer adapter receives native clipped interleaved vertices,
      // then writes the exact vertex/index buffers consumed by picking.
      SlotMesh.prototype.updateFromSpineData.call(rendered as never, { texture: { tag: 'fixture' } } as never,
        0, 'body', vertices, vertices.length, triangles, triangles.length, false)
    },
  }
  const rendered = mesh('body')
  display.addChild(rendered)
  display.meshesCache.set(skeleton.slots[1], rendered)
  display.updateTransform()
  return { display, rendered, clipping }
}

const clipped = spine('main', true)
const clippedGeometry = { positions: clipped.rendered.geometry.getBuffer('aVertexPosition').data,
  indices: clipped.rendered.geometry.indexBuffer.data, matrix }
assert(developerTriangleHit(clippedGeometry, { x: 2, y: 2 }), JSON.stringify({ positions: [...clippedGeometry.positions], indices: [...clippedGeometry.indices] }))
assert(!developerTriangleHit(clippedGeometry, { x: 8, y: 2 }), 'Clipped-away area cannot hit the original attachment quad')
assert(developerGeometryOutline(clippedGeometry).every(([a, b]) => Math.max(a.x, a.y, b.x, b.y) <= 5.00001))

const stage = object('stage')
const back = spine('back', false), front = spine('front', false)
stage.addChild(back.display); stage.addChild(clipped.display); stage.addChild(front.display)
let overrides: DeveloperOverrides | null = null
let handle: DeveloperSceneHandle | null = null
let duringRender = () => {}
const renderer = { screen: { width: 200, height: 100 }, render() {
  for (const item of [back, clipped, front]) if (item.display.visible) item.display.updateTransform()
  duringRender()
} }
const originalRender = renderer.render
const app = { stage, renderer, view: surface, screen: renderer.screen }
const scene = createDeveloperScene(app as never, 'pick:test', '拾取测试', {
  getOverrides: () => overrides,
  registerScene(value) { handle = value; return () => { handle = null } },
})
// Registration order intentionally differs from actual back/main/front paint order.
const frontId = scene.addSpine(front.display as never, 'front/asset', '前景')
const mainId = scene.addSpine(clipped.display as never, 'main/asset', '主层')
const backId = scene.addSpine(back.display as never, 'back/asset', '后景')
scene.publish()
assert.equal(handle!.surface!(), surface)
const hits = (x = 2, y = 2) => handle!.pick!(20 + x * 2, 30 + y * 2)
assert.equal(handle!.active!(), true)
// Raw preview retains the gallery's canvas, so layout rectangles alone are not
// evidence that its scene is visible. No browser or extraction is needed here.
const styleHost = { parentElement: null, style: { display: 'block', visibility: 'hidden', opacity: '1' } }
const styleCanvas = surface as typeof surface & { parentElement: typeof styleHost; style: typeof styleHost.style }
styleCanvas.parentElement = styleHost
styleCanvas.style = { display: 'block', visibility: 'visible', opacity: '1' }
const previousGetComputedStyle = globalThis.getComputedStyle
globalThis.getComputedStyle = ((node: typeof styleHost) => node.style) as typeof getComputedStyle
assert.equal(handle!.active!(), false)
assert.deepEqual(hits(), [], 'A hidden gallery canvas cannot claim clicks meant for the visible raw preview')
assert.equal(developerSurfaceVisible({ ...styleCanvas, parentElement: null } as never), true, 'Visible raw preview is still active')
styleHost.style.visibility = 'visible'; styleHost.style.display = 'none'
assert.equal(handle!.active!(), false)
styleHost.style.display = 'block'; styleHost.style.opacity = '0'
assert.deepEqual(hits(), [])
styleHost.style.opacity = '1'
assert.equal(handle!.active!(), true)
if (previousGetComputedStyle) globalThis.getComputedStyle = previousGetComputedStyle
else delete (globalThis as typeof globalThis & { getComputedStyle?: typeof getComputedStyle }).getComputedStyle
assert.deepEqual(hits().map(item => item.id), [developerSlotId(frontId, 'body'), developerSlotId(mainId, 'body'), developerSlotId(backId, 'body')])
assert.deepEqual(hits(8, 2).map(item => item.id), [developerSlotId(frontId, 'body'), developerSlotId(backId, 'body')])
assert.deepEqual(hits()[1].relatedClipping, [developerSlotId(mainId, 'clip')])
assert(hits().every(item => item.type === 'mesh' && item.attachment === 'body-image'))
const originalBody = clipped.display.skeleton.slots[1].attachment
const originalDeform = clipped.display.skeleton.slots[1].deform
handle!.highlight!(hits()[1]) // Headless mode safely skips Graphics creation.
assert.equal(stage.children.length, 3, 'Headless highlight must not add fake or pickable content')
assert.equal(clipped.display.skeleton.slots[1].attachment, originalBody)
assert.equal(clipped.display.skeleton.slots[1].deform, originalDeform)

overrides = emptyDeveloperOverrides()
overrides.slots[developerSlotId(frontId, 'body')] = { hidden: true }
renderer.render()
assert.equal(front.display.skeleton.slots[1].attachment!.name, 'body-image', 'Authored attachment is restored after draw')
assert.equal(front.rendered.visible, false, 'Actual last-frame mesh remains hidden')
assert.deepEqual(hits().map(item => item.layerId), [mainId, backId])
overrides.slots = { [developerSlotId(mainId, 'body')]: { opacity: 0 } }
renderer.render()
assert.deepEqual(hits().map(item => item.layerId), [frontId, backId])
overrides.slots = { [developerSlotId(mainId, 'clip')]: { disableClipping: true } }
renderer.render()
assert(hits(8, 2).some(item => item.layerId === mainId), 'Disabled clipping exposes the native unclipped triangles')
assert.deepEqual(hits().find(item => item.layerId === mainId)!.relatedClipping, [])

overrides = { layers: {}, slots: {}, solo: { kind: 'slot', id: developerSlotId(mainId, 'body') } }
renderer.render()
assert.deepEqual(hits().map(item => item.layerId), [mainId])
overrides = emptyDeveloperOverrides()
overrides.layers[mainId] = { hidden: true }
renderer.render()
assert(!hits().some(item => item.layerId === mainId), 'Ignore stale meshes in a hidden layer')
overrides.layers = { [mainId]: { opacity: 0 } }
renderer.render()
assert(!hits().some(item => item.layerId === mainId))

// Highlighting runs inside renderer.render's temporary overrides. The same
// presentation path is exercised by picking during that draw: apply .01 layer
// opacity once, even though the local layer alpha is already .01 at this point.
overrides = { layers: { [mainId]: { opacity: .01 } }, slots: {
  [developerSlotId(mainId, 'body')]: { opacity: .05 },
} }
const assertLowAlpha = () => {
  const selected = hits().find(item => item.layerId === mainId)
  assert(selected, 'Visible low-alpha mesh must remain eligible for highlighting during draw')
  assert(Math.abs(selected.opacity! - .0005) < 1e-9, 'Layer opacity must be applied once, inside and outside renderer.render')
}
duringRender = assertLowAlpha
renderer.render()
assertLowAlpha()
duringRender = () => { assertLowAlpha(); throw new Error('low-alpha renderer failure') }
assert.throws(() => renderer.render(), /low-alpha renderer failure/)
assertLowAlpha()
duringRender = () => {}

// Manual visibility and solo temporarily expose inactive ancestors; restored
// object.worldVisible would be false and must not control picking.
const inactiveParent = object('inactive-parent')
inactiveParent.visible = false
stage.children.splice(stage.children.indexOf(clipped.display), 1)
stage.addChild(inactiveParent); inactiveParent.addChild(clipped.display)
clipped.display.visible = false
overrides = emptyDeveloperOverrides()
overrides.layers[mainId] = { hidden: false }
renderer.render()
assert.equal(inactiveParent.visible, false)
assert.equal(clipped.display.visible, false)
assert(hits().some(item => item.layerId === mainId), 'Explicitly shown inactive child is picked despite restored parent flags')
overrides = { layers: {}, slots: {}, solo: { kind: 'slot', id: developerSlotId(mainId, 'body') } }
renderer.render()
assert.deepEqual(hits().map(item => item.layerId), [mainId])

clipped.display.mask = { containsPoint(point: { x: number; y: number }) { return point.x >= 3 } }
assert.equal(hits(2, 2).length, 0, 'External Graphics/Sprite-compatible mask excludes outside points')
assert.equal(hits(4, 2).length, 1)
overrides.layers[mainId] = { disableClipping: true }
assert.equal(hits(2, 2).length, 1, 'Disabled external mask is ignored after its authored reference was restored')

// Ordinary registered sprites use anchor/trim geometry and tree paint order.
const sprite = { ...object('drag-image'), texture: { orig: { width: 10, height: 10 }, trim: { x: 2, y: 2, width: 4, height: 4 } }, anchor: { x: .5, y: .5 } }
sprite.worldTransform.tx = 20; sprite.worldTransform.ty = 20
stage.addChild(sprite)
const spriteId = scene.addLayer(sprite as never, 'drag', '拖动物件')
overrides = null
assert.equal(hits(18, 18)[0].id, spriteId)
assert.equal(hits(16, 16).length, 0, 'Trimmed-away Sprite region is not a candidate')
sprite.visible = false
overrides = { layers: { [spriteId]: { hidden: false } }, slots: {} }
assert.equal(hits(18, 18)[0].id, spriteId, 'Explicit sprite visibility is honored')
sprite.worldTransform = { a: -2, b: 0, c: 0, d: 2, tx: 20, ty: 20 }
assert.equal(hits(24, 16)[0].id, spriteId)

handle!.highlight!(null)
const oldHandle = handle!
scene.dispose()
assert.equal(handle, null)
assert.equal(renderer.render, originalRender)
assert.deepEqual(oldHandle.pick!(24, 34), [])
oldHandle.highlight!(null)
const noSurface = createDeveloperScene({ renderer, stage } as never, 'headless', '无画布', {
  getOverrides: () => null, registerScene(value) { handle = value; return () => { handle = null } },
})
noSurface.publish()
assert.equal(handle!.surface!(), null)
assert.deepEqual(handle!.pick!(0, 0), [])
noSurface.dispose()
console.log(JSON.stringify({ developerPicking: 'passed', geometry: 'native clipped SlotMesh buffers, transforms, CSS/DPR mapping, outlines',
  state: 'actual paint order, hidden/opacity/solo, inactive ancestors, external masks, Sprite trim and lifecycle' }))
