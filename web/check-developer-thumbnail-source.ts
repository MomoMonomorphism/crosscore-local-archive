import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { BaseTexture, Rectangle, Texture } from 'pixi.js'
import { BoneData, ClippingAttachment, MeshAttachment, Physics, RegionAttachment, Skeleton, SkeletonData, Skin, SlotData } from '@esotericsoftware/spine-core'
import type { DeveloperPickCandidate, DeveloperSceneHandle, DeveloperThumbnail } from './src/developerControls.ts'

registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier)) {
    try { return nextResolve(`${specifier}.ts`, context) } catch { /* Standard resolution below. */ }
  }
  return nextResolve(specifier, context)
} })
const { createDeveloperThumbnailSource, createDeveloperImageThumbnail, developerTextureThumbnail, developerTextureThumbnailPlan,
  developerClippingThumbnail, unpremultiplyDeveloperThumbnail } = await import('./src/developerThumbnailSource.ts')
const { createDeveloperScene } = await import('./src/developerScene.ts')
const { suppressOversizedCameraMatte } = await import('./src/spineCameraMatte.ts')

type Pixel = [number, number, number, number]
type Point = { x: number; y: number }
type Matrix = { a: number; b: number; c: number; d: number; tx: number; ty: number }
type Image = { width: number; height: number; pixels: Uint8ClampedArray }
const identity = (): Matrix => ({ a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 })
const map = (point: Point, matrix: Matrix): Point => ({ x: matrix.a * point.x + matrix.c * point.y + matrix.tx,
  y: matrix.b * point.x + matrix.d * point.y + matrix.ty })
function inverse(point: Point, matrix: Matrix) {
  const determinant = matrix.a * matrix.d - matrix.b * matrix.c
  const x = point.x - matrix.tx, y = point.y - matrix.ty
  return { x: (matrix.d * x - matrix.c * y) / determinant, y: (-matrix.b * x + matrix.a * y) / determinant }
}
function image(width: number, height: number, color: Pixel = [221, 66, 199, 255]): Image {
  const pixels = new Uint8ClampedArray(width * height * 4)
  for (let index = 0; index < pixels.length; index += 4) pixels.set(color, index)
  return { width, height, pixels }
}
function setPixel(source: Image, x: number, y: number, value: Pixel) { source.pixels.set(value, (y * source.width + x) * 4) }

/** A small software Canvas2D double actually executes the crop/affine draw. It
 * samples labelled pixels rather than asserting an implementation's call list. */
class SoftwareContext {
  matrix = identity()
  path: Point[] = []
  clipPath: Point[] | null = null
  pixels = new Uint8ClampedArray()
  drawCount = 0
  filled = 0
  stroked = 0
  imageSmoothingEnabled = true
  fillStyle = ''
  strokeStyle = ''
  lineWidth = 1
  canvas: SoftwareCanvas
  constructor(canvas: SoftwareCanvas) { this.canvas = canvas }
  resize() { this.pixels = new Uint8ClampedArray(this.canvas.width * this.canvas.height * 4) }
  beginPath() { this.path = [] }
  moveTo(x: number, y: number) { this.path.push(map({ x, y }, this.matrix)) }
  lineTo(x: number, y: number) { this.path.push(map({ x, y }, this.matrix)) }
  closePath() {}
  clip() { this.clipPath = this.path.map(point => ({ ...point })) }
  setTransform(a: number, b: number, c: number, d: number, tx: number, ty: number) { this.matrix = { a, b, c, d, tx, ty } }
  drawImage(source: Image, sx: number, sy: number, sw: number, sh: number, dx: number, dy: number, dw: number, dh: number) {
    this.drawCount++
    assert(source.pixels, 'Only existing decoded sources may be drawn')
    const clip = this.clipPath
    const minX = clip ? Math.min(...clip.map(point => point.x)) : 0
    const maxX = clip ? Math.max(...clip.map(point => point.x)) : this.canvas.width
    const minY = clip ? Math.min(...clip.map(point => point.y)) : 0
    const maxY = clip ? Math.max(...clip.map(point => point.y)) : this.canvas.height
    for (let y = 0; y < this.canvas.height; y++) for (let x = 0; x < this.canvas.width; x++) {
      const point = { x: x + .5, y: y + .5 }
      if (point.x < minX || point.x >= maxX || point.y < minY || point.y >= maxY) continue
      const local = inverse(point, this.matrix)
      if (local.x < dx || local.x >= dx + dw || local.y < dy || local.y >= dy + dh) continue
      const sampleX = Math.floor(sx + (local.x - dx) * sw / dw), sampleY = Math.floor(sy + (local.y - dy) * sh / dh)
      if (sampleX < 0 || sampleY < 0 || sampleX >= source.width || sampleY >= source.height) continue
      this.pixels.set(source.pixels.slice((sampleY * source.width + sampleX) * 4, (sampleY * source.width + sampleX) * 4 + 4), (y * this.canvas.width + x) * 4)
    }
  }
  getImageData() { return { data: this.pixels.slice() } }
  putImageData(value: { data: Uint8ClampedArray }) { this.pixels = value.data.slice() }
  fill() { this.filled++ }
  stroke() { this.stroked++ }
}
class SoftwareCanvas {
  private widthValue = 0
  private heightValue = 0
  context = new SoftwareContext(this)
  get width() { return this.widthValue }
  set width(value: number) { this.widthValue = value; this.context.resize() }
  get height() { return this.heightValue }
  set height(value: number) { this.heightValue = value; this.context.resize() }
  getContext() { return this.context }
  // This double stores raw raster bytes in the URL; browsers provide the real PNG encoder.
  toDataURL() { return `data:image/png;base64,${Buffer.from(this.context.pixels).toString('base64')}` }
}
const canvases: SoftwareCanvas[] = []
const createCanvas = () => { const canvas = new SoftwareCanvas(); canvases.push(canvas); return canvas as unknown as HTMLCanvasElement }
function pixel(thumbnail: DeveloperThumbnail | null, x: number, y: number) {
  assert(thumbnail)
  assert.equal(thumbnail.width, 128); assert.equal(thumbnail.height, 128)
  const bytes = Buffer.from(thumbnail.url.split(',')[1], 'base64')
  return [...bytes.subarray((y * 128 + x) * 4, (y * 128 + x) * 4 + 4)]
}
function texture(source: Image, alphaMode = 1) {
  return { valid: true, destroyed: false, frame: { x: 0, y: 0, width: source.width, height: source.height },
    orig: { width: source.width, height: source.height },
    baseTexture: { valid: true, destroyed: false, width: source.width, height: source.height, alphaMode,
      resource: { source: source as unknown as CanvasImageSource, destroyed: false } } }
}
const R: Pixel = [250, 0, 0, 255], G: Pixel = [0, 250, 0, 255], B: Pixel = [0, 0, 250, 255]
const C: Pixel = [0, 250, 250, 255], M: Pixel = [250, 0, 250, 255], Y: Pixel = [250, 250, 0, 255]
const packed: Record<number, Pixel[][]> = {
  0: [[R, G, B], [C, M, Y]],
  90: [[B, Y], [G, M], [R, C]],
  180: [[Y, M, C], [B, G, R]],
  270: [[C, R], [M, G], [Y, B]],
}
function region(source: Image, degrees = 0) {
  return { u: 2 / source.width, v: 3 / source.height, u2: 5 / source.width, v2: 5 / source.height,
    x: 2, y: 3, width: 3, height: 2, originalWidth: 3, originalHeight: 2, offsetX: 0, offsetY: 0,
    degrees, page: { width: source.width, height: source.height, pma: false }, texture: { texture: texture(source) } }
}

// Non-square labelled regions prove crop and orientation independently of UVs.
for (const degrees of [0, 90, 180, 270]) {
  const source = image(8, 9), rows = packed[degrees]
  for (let y = 0; y < rows.length; y++) for (let x = 0; x < rows[y].length; x++) setPixel(source, 2 + x, 3 + y, rows[y][x])
  const before = source.pixels.slice(), atlasRegion = region(source, degrees)
  const thumbnail = developerTextureThumbnail(atlasRegion.texture, atlasRegion, createCanvas)
  assert.deepEqual(pixel(thumbnail, 24, 44), R, `${degrees}° top left`)
  assert.deepEqual(pixel(thumbnail, 104, 44), B, `${degrees}° top right`)
  assert.deepEqual(pixel(thumbnail, 24, 84), C, `${degrees}° bottom left`)
  assert.deepEqual(pixel(thumbnail, 104, 84), Y, `${degrees}° bottom right`)
  assert.deepEqual(pixel(thumbnail, 1, 1), [0, 0, 0, 0], 'Atlas neighbours must not leak into transparent padding')
  assert.deepEqual(source.pixels, before)
}
const plainSource = image(8, 9)
for (let y = 0; y < 2; y++) for (let x = 0; x < 3; x++) setPixel(plainSource, x + 2, y + 3, packed[0][y][x])
const trimmedRegion = { ...region(plainSource), originalWidth: 5, originalHeight: 4, offsetX: 1, offsetY: 1 }
const trimmed = developerTextureThumbnail(trimmedRegion.texture, trimmedRegion, createCanvas)
assert.deepEqual(pixel(trimmed, 39, 51), R)
assert.deepEqual(pixel(trimmed, 87, 75), Y)
assert.deepEqual(pixel(trimmed, 15, 51), [0, 0, 0, 0], 'Restore original left trim')
assert.deepEqual(pixel(trimmed, 39, 27), [0, 0, 0, 0], 'Convert Spine bottom-origin offsetY to top-origin trim')

// Use actual installed Pixi TextureUvs, including retina frames and both
// rotation conventions. This detects assumptions about logical vs real pixels.
const pixiBase = BaseTexture.fromBuffer(new Uint8Array(8 * 8 * 4), 8, 8, { resolution: 2 })
const pixiTexture = new Texture(pixiBase, new Rectangle(1, 1, 1, 1), new Rectangle(0, 0, 2, 2), new Rectangle(.5, .5, 1, 1), 6)
const pixiPlan = developerTextureThumbnailPlan(pixiTexture, { width: 8, height: 8 })!
assert.deepEqual(pixiPlan.crop, { x: 2, y: 2, width: 2, height: 2 })
assert.deepEqual(pixiPlan.sourceCorners, [{ x: 2, y: 4 }, { x: 2, y: 2 }, { x: 4, y: 2 }, { x: 4, y: 4 }])
assert.deepEqual(map(pixiPlan.sourceCorners[0], pixiPlan.transform), { x: 34, y: 34 })
const pixiOpposite = new Texture(pixiBase, new Rectangle(1, 1, 1, 1), new Rectangle(0, 0, 1, 1), undefined, 2)
assert.deepEqual(developerTextureThumbnailPlan(pixiOpposite, { width: 8, height: 8 })!.sourceCorners,
  [{ x: 4, y: 2 }, { x: 4, y: 4 }, { x: 2, y: 4 }, { x: 2, y: 2 }])
const mirrored = { ...texture(image(2, 1)), _uvs: { x0: 1, y0: 0, x1: 0, y1: 0, x2: 0, y2: 1, x3: 1, y3: 1 } }
setPixel(mirrored.baseTexture.resource.source as unknown as Image, 0, 0, R)
setPixel(mirrored.baseTexture.resource.source as unknown as Image, 1, 0, G)
assert.deepEqual(pixel(developerTextureThumbnail(mirrored, undefined, createCanvas), 24, 64), G)
assert.deepEqual(pixel(developerTextureThumbnail(mirrored, undefined, createCanvas), 104, 64), R)
pixiTexture.destroy(false); pixiOpposite.destroy(false); pixiBase.destroy()

const pmaSource = image(1, 1, [100, 40, 10, 128])
const pmaTexture = texture(pmaSource, 2)
const pmaBefore = pmaSource.pixels.slice()
assert.deepEqual(pixel(developerTextureThumbnail(pmaTexture, undefined, createCanvas), 64, 64), [199, 80, 20, 128])
assert.equal(canvases.at(-1)!.context.imageSmoothingEnabled, false)
assert.deepEqual(pixel(developerTextureThumbnail(texture(pmaSource, 1), undefined, createCanvas), 64, 64), [100, 40, 10, 128], 'UNPACK source is not PMA')
assert.deepEqual(pmaSource.pixels, pmaBefore)
const transparent = new Uint8ClampedArray([127, 90, 1, 0, 250, 150, 100, 255])
unpremultiplyDeveloperThumbnail(transparent)
assert.deepEqual([...transparent], [0, 0, 0, 0, 250, 150, 100, 255])
assert.deepEqual(pixel(createDeveloperImageThumbnail(pmaSource as never, 1, 1, createCanvas), 64, 64), [100, 40, 10, 128])

assert.equal(developerTextureThumbnailPlan(texture(plainSource), { width: 8, height: 9 }, { ...region(plainSource), x: -1 }), null)
assert.equal(developerTextureThumbnailPlan(texture(plainSource), { width: 8, height: 9 }, { ...region(plainSource), x: 7 }), null)
assert.equal(developerTextureThumbnailPlan(texture(plainSource), { width: 8, height: 9 }, { ...region(plainSource), degrees: 45 }), null)
assert.equal(developerTextureThumbnailPlan(texture(plainSource), { width: 8, height: 9 }, { ...region(plainSource), offsetX: 4 }), null)
const destroyed = texture(plainSource); destroyed.baseTexture.resource.destroyed = true
assert.equal(developerTextureThumbnail(destroyed, undefined, createCanvas), null)
assert.equal(developerTextureThumbnail({ ...texture(plainSource), valid: false }, undefined, createCanvas), null)
assert.equal(developerTextureThumbnail(texture(plainSource), undefined, () => { throw new Error('Canvas unavailable') }), null)
const failedCanvas = new SoftwareCanvas()
failedCanvas.context.drawImage = () => { throw new Error('Tainted/unavailable image') }
assert.equal(developerTextureThumbnail(texture(plainSource), undefined, () => failedCanvas as never), null)
assert.equal(failedCanvas.width, 0); assert.equal(failedCanvas.height, 0)
assert(canvases.every(canvas => canvas.width === 0 && canvas.height === 0), 'Temporary previews release their raster buffers')

// Real Spine instances: exact snapshot names remain usable after a timeline
// changes or clears the live attachment. Sequence/deform/playback stays intact.
const data = new SkeletonData(), boneData = new BoneData(0, 'root', null)
data.bones.push(boneData)
for (const name of ['body', 'clip', 'empty']) data.slots.push(new SlotData(data.slots.length, name, boneData))
const skin = new Skin('default'), otherSkin = new Skin('alternative')
const bodyA = new RegionAttachment('body-A'), bodyB = new MeshAttachment('body-B')
bodyA.region = region(plainSource) as never; bodyB.region = { ...region(plainSource), x: 0, y: 0, width: 1, height: 1, originalWidth: 1, originalHeight: 1 } as never
bodyA.sequence = { apply() { throw new Error('A thumbnail must not apply a sequence') } } as never
bodyA.computeWorldVertices = () => { throw new Error('A texture thumbnail must not update vertices') }
const clip = new ClippingAttachment('clip-boundary')
clip.worldVerticesLength = 8; clip.vertices = [-10, -5, 10, -5, 10, 5, -10, 5]
skin.setAttachment(0, 'body-A', bodyA); skin.setAttachment(1, 'clip-boundary', clip)
otherSkin.setAttachment(0, 'alias-for-body-B', bodyB)
data.defaultSkin = skin; data.skins.push(skin, otherSkin)
const skeleton = new Skeleton(data)
skeleton.updateWorldTransform(Physics.none)
skeleton.slots[0].attachment = bodyB; skeleton.slots[1].attachment = clip
skeleton.slots[0].deform.push(17, -29); skeleton.slots[0].sequenceIndex = 3
const spine = { skeleton, state: { tracks: [{ animation: { name: 'idle', duration: 4 }, trackTime: 2.5 }] },
  visible: true, alpha: .7, mask: null, updateTransform() { throw new Error('Do not draw the live scene') } }
let disposed = false
const layer = { id: 'main', object: spine, spine: spine as never }
const thumbnails = createDeveloperThumbnailSource([layer], () => disposed, createCanvas)
const slotCandidate = (attachment: string | null, name = 'body'): DeveloperPickCandidate => ({
  id: `main::${name}`, kind: 'slot', layerId: 'main', label: name, attachment,
})
const baseline = skeleton.slots.map(slot => ({ attachment: slot.attachment, alpha: slot.color.a, deform: slot.deform, values: [...slot.deform], sequenceIndex: slot.sequenceIndex }))
const boneValues = skeleton.bones.map(bone => ({ a: bone.a, b: bone.b, c: bone.c, d: bone.d, worldX: bone.worldX, worldY: bone.worldY }))
assert.deepEqual(pixel(thumbnails(slotCandidate('body-A')), 24, 44), R, 'A cached snapshot must not display current body-B')
assert(thumbnails(slotCandidate('body-B')), 'Resolve current attachment even if its skin key is different')
assert.equal(thumbnails(slotCandidate('missing')), null)
assert.equal(thumbnails(slotCandidate(null)), null, 'An empty snapshot must stay empty')
assert.equal(thumbnails(slotCandidate(null, 'empty')), null)
assert.equal(thumbnails({ ...slotCandidate('body-A'), id: 'other::body' }), null)
assert.equal(thumbnails({ ...slotCandidate('body-A'), layerId: 'missing-layer' }), null)
const clippingThumbnail = thumbnails(slotCandidate('clip-boundary', 'clip'))
assert.equal(clippingThumbnail?.kind, 'geometry')
assert.equal(canvases.at(-1)!.context.filled, 1); assert.equal(canvases.at(-1)!.context.stroked, 1)
// Spine's Pixi integration sets Bone.yDown; sample the final world orientation.
assert.deepEqual(canvases.at(-1)!.context.path, [{ x: 8, y: 92 }, { x: 120, y: 92 }, { x: 120, y: 36 }, { x: 8, y: 36 }])
assert.equal(developerClippingThumbnail(new ClippingAttachment('invalid'), skeleton.slots[1], createCanvas), null)
assert.equal(thumbnails({ id: 'main', layerId: 'main', label: 'main', kind: 'layer' })?.kind, 'texture')
for (const [index, slot] of skeleton.slots.entries()) {
  assert.equal(slot.attachment, baseline[index].attachment); assert.equal(slot.color.a, baseline[index].alpha)
  assert.equal(slot.deform, baseline[index].deform); assert.deepEqual(slot.deform, baseline[index].values)
  assert.equal(slot.sequenceIndex, baseline[index].sequenceIndex)
}
assert.deepEqual(skeleton.bones.map(bone => ({ a: bone.a, b: bone.b, c: bone.c, d: bone.d, worldX: bone.worldX, worldY: bone.worldY })), boneValues)
assert.equal(spine.state.tracks[0].trackTime, 2.5)
skeleton.slots[0].attachment = null
assert(thumbnails(slotCandidate('body-A')), 'Lookup the explicitly named previous attachment after animation clears the slot')
assert.equal(thumbnails({ ...slotCandidate(null), attachment: undefined }), null, 'Do not invent a setup attachment for an empty current slot')
disposed = true
const canvasCount = canvases.length
assert.equal(thumbnails(slotCandidate('body-A')), null)
assert.equal(canvases.length, canvasCount, 'Disposed scene must not touch decoded images')

// Suppressed camera matte uses precisely the same attachment as scene snapshot.
const matteData = new SkeletonData(), matteBone = new BoneData(0, 'root', null)
matteData.bones.push(matteBone)
const edges = [[0, 0, 200, 0], [0, 200, 200, 200], [0, 0, 0, 200], [200, 0, 200, 200]]
for (let index = 0; index < 4; index++) matteData.slots.push(new SlotData(index, `black-matte-${index}`, matteBone))
const matteSkeleton = new Skeleton(matteData)
for (const [index, slot] of matteSkeleton.slots.entries()) {
  const attachment = new MeshAttachment('camera-matte')
  attachment.region = region(plainSource) as never; attachment.worldVerticesLength = 12
  attachment.computeWorldVertices = (_slot, _start, _count, output, offset, stride) => {
    const vertices = [-1000, -1000, 1000, -1000, -1000, 1000, 1000, 1000, ...edges[index]]
    for (let point = 0; point < 6; point++) { output[offset + point * stride] = vertices[point * 2]; output[offset + point * stride + 1] = vertices[point * 2 + 1] }
  }
  slot.attachment = attachment; slot.deform.push(11, 22)
}
const matte = { skeleton: matteSkeleton } as never
suppressOversizedCameraMatte(matte)
const matteSource = createDeveloperThumbnailSource([{ id: 'matte', object: matte, spine: matte }], () => false, createCanvas)
assert(matteSkeleton.slots.every(slot => slot.attachment === null))
assert(matteSource({ id: 'matte::black-matte-0', kind: 'slot', layerId: 'matte', label: 'matte', attachment: 'camera-matte' }))
assert(matteSkeleton.slots.every(slot => slot.attachment === null && slot.deform.join(',') === '11,22'))

// Scene wiring returns the sync helper, never the wrapped renderer. Node has no
// real DOM; install only a temporary canvas factory while invoking the handle.
let handle: DeveloperSceneHandle | null = null
let renders = 0
const renderer = { render() { renders++; throw new Error('Thumbnail cannot call scene renderer') } }
const originalRender = renderer.render
const scene = createDeveloperScene({ renderer } as never, 'test:thumbnail', 'Thumbnail test', {
  getOverrides: () => null, registerScene(value) { handle = value; return () => { handle = null } },
})
scene.addSpine(spine as never, 'main', 'Main')
scene.addLayer({ texture: texture(plainSource), visible: true, alpha: .3, mask: null } as never, 'sprite', 'Sprite')
scene.publish()
assert(handle?.thumbnail)
const liveHandle = handle!
const oldDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
try {
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: createCanvas } })
  assert(liveHandle.thumbnail!(slotCandidate('body-A')))
  assert(liveHandle.thumbnail!({ id: 'sprite', layerId: 'sprite', kind: 'layer', label: 'Sprite' }))
} finally {
  if (oldDocument) Object.defineProperty(globalThis, 'document', oldDocument)
  else delete (globalThis as { document?: unknown }).document
}
assert.equal(renders, 0)
scene.dispose()
assert.equal(renderer.render, originalRender)
assert.equal(liveHandle.thumbnail!(slotCandidate('body-A')), null)

console.log(JSON.stringify({ developerThumbnailSource: 'passed', previews: canvases.length,
  verified: 'labelled rotation/crop raster, transparent trim, real Pixi UV/retina/mirror, PMA vs UNPACK, exact snapshot attachment, clipping/suppressed matte, read-only state, scene wiring and disposal' }))
