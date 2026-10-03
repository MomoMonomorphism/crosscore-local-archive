import { ClippingAttachment, MeshAttachment, RegionAttachment, type Attachment, type Slot, type TextureRegion } from '@esotericsoftware/spine-core'
import type { Spine } from '@esotericsoftware/spine-pixi-v7'
import { developerSlotId, type DeveloperPickCandidate, type DeveloperThumbnail } from './developerControls'
import { suppressedCameraMatteAttachments } from './spineCameraMatte'

type Point = { x: number; y: number }
type Rect = Point & { width: number; height: number }
type Uvs = { x0: number; y0: number; x1: number; y1: number; x2: number; y2: number; x3: number; y3: number }
type TextureLike = {
  destroyed?: boolean; valid?: boolean; frame?: Rect; orig?: { width: number; height: number }; trim?: Rect | null
  _uvs?: Uvs; baseTexture?: { destroyed?: boolean; valid?: boolean; alphaMode?: number; width?: number; height?: number
    resource?: { source?: CanvasImageSource; destroyed?: boolean } | null }
}
type RegionLike = Pick<TextureRegion, 'u' | 'v' | 'u2' | 'v2' | 'width' | 'height' | 'degrees' | 'offsetX' | 'offsetY' | 'originalWidth' | 'originalHeight'>
  & { x?: number; y?: number; page?: { width: number; height: number; pma?: boolean }; texture?: unknown }
type ThumbnailLayer = { id: string; object: object; spine?: Spine }
export type DeveloperThumbnailCanvasFactory = () => HTMLCanvasElement | null
export type DeveloperTextureThumbnailPlan = {
  crop: Rect; trim: Rect; original: { width: number; height: number }; sourceCorners: [Point, Point, Point, Point]
  transform: { a: number; b: number; c: number; d: number; tx: number; ty: number }; premultiplied: boolean
}

const SIZE = 128
const PADDING = 4
const finite = (...values: number[]) => values.every(Number.isFinite)
const positive = (...values: number[]) => finite(...values) && values.every(value => value > 0)
const defaultCanvas: DeveloperThumbnailCanvasFactory = () => typeof document === 'undefined' ? null : document.createElement('canvas')

/** SpineTexture holds a whole atlas Pixi Texture, not a texture for its region. */
function pixiTexture(value: unknown): TextureLike | null {
  if (!value || typeof value !== 'object') return null
  const direct = value as TextureLike & { texture?: TextureLike }
  return direct.baseTexture ? direct : direct.texture?.baseTexture ? direct.texture : null
}

/** Resource image dimensions are physical pixels, unlike Pixi's resolution-scaled frame. */
function imageSize(image: CanvasImageSource): { width: number; height: number } | null {
  const source = image as unknown as { naturalWidth?: number; naturalHeight?: number; videoWidth?: number; videoHeight?: number; width?: number; height?: number }
  const width = source.naturalWidth ?? source.videoWidth ?? source.width ?? 0
  const height = source.naturalHeight ?? source.videoHeight ?? source.height ?? 0
  return positive(width, height) ? { width, height } : null
}

/** Map the four original upright corners to atlas pixels. In particular Spine's
 * 90 degree atlas convention differs from Pixi's rotate=2 convention. */
function regionCorners(region: RegionLike, source: { width: number; height: number }): [Point, Point, Point, Point] | null {
  const page = region.page ?? source
  if (!positive(page.width, page.height, region.width, region.height) || !finite(region.degrees, region.u, region.v)) return null
  const degrees = ((region.degrees % 360) + 360) % 360
  if (![0, 90, 180, 270].includes(degrees)) return null
  const x = (region.x ?? region.u * page.width) * source.width / page.width
  const y = (region.y ?? region.v * page.height) * source.height / page.height
  const width = (degrees % 180 ? region.height : region.width) * source.width / page.width
  const height = (degrees % 180 ? region.width : region.height) * source.height / page.height
  const corners: [Point, Point, Point, Point] = [
    { x, y }, { x: x + width, y }, { x: x + width, y: y + height }, { x, y: y + height },
  ]
  const start = (4 - degrees / 90) % 4
  return [corners[start], corners[(start + 1) % 4], corners[(start + 2) % 4], corners[(start + 3) % 4]]
}

/** Pure crop/rotation plan. No GPU readback, renderer call, Texture construction,
 * attachment update, or full-size copy of the atlas is needed. */
export function developerTextureThumbnailPlan(texture: TextureLike, source: { width: number; height: number },
  region?: RegionLike): DeveloperTextureThumbnailPlan | null {
  if (texture.destroyed || texture.valid === false || texture.baseTexture?.destroyed || texture.baseTexture?.valid === false
    || texture.baseTexture?.resource?.destroyed || !positive(source.width, source.height)) return null
  let corners: [Point, Point, Point, Point] | null
  let original: { width: number; height: number }, trim: Rect
  if (region) {
    corners = regionCorners(region, source)
    original = { width: region.originalWidth || region.width, height: region.originalHeight || region.height }
    trim = { x: region.offsetX, y: original.height - region.offsetY - region.height, width: region.width, height: region.height }
  } else {
    const uvs = texture._uvs
    const frame = texture.frame
    if (uvs) corners = [
      { x: uvs.x0 * source.width, y: uvs.y0 * source.height }, { x: uvs.x1 * source.width, y: uvs.y1 * source.height },
      { x: uvs.x2 * source.width, y: uvs.y2 * source.height }, { x: uvs.x3 * source.width, y: uvs.y3 * source.height },
    ]
    else if (frame && positive(texture.baseTexture?.width ?? 0, texture.baseTexture?.height ?? 0)) {
      const sx = source.width / texture.baseTexture!.width!, sy = source.height / texture.baseTexture!.height!
      corners = [{ x: frame.x * sx, y: frame.y * sy }, { x: (frame.x + frame.width) * sx, y: frame.y * sy },
        { x: (frame.x + frame.width) * sx, y: (frame.y + frame.height) * sy }, { x: frame.x * sx, y: (frame.y + frame.height) * sy }]
    } else return null
    original = texture.orig ?? { width: frame?.width ?? 0, height: frame?.height ?? 0 }
    trim = texture.trim ?? { x: 0, y: 0, width: original.width, height: original.height }
  }
  if (!corners || !positive(original.width, original.height, trim.width, trim.height) || !finite(trim.x, trim.y)) return null
  const epsilon = 1e-4
  if (trim.x < -epsilon || trim.y < -epsilon || trim.x + trim.width > original.width + epsilon || trim.y + trim.height > original.height + epsilon) return null
  if (corners.some(point => !finite(point.x, point.y) || point.x < -epsilon || point.y < -epsilon || point.x > source.width + epsilon || point.y > source.height + epsilon)) return null
  const [topLeft, topRight, bottomRight, bottomLeft] = corners
  // This affine mapping handles quarter-turns, mirrored Pixi UVs and resolution.
  const ux = topRight.x - topLeft.x, uy = topRight.y - topLeft.y
  const vx = bottomLeft.x - topLeft.x, vy = bottomLeft.y - topLeft.y
  const determinant = ux * vy - uy * vx
  if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-8
    || Math.abs(bottomRight.x - topLeft.x - ux - vx) > epsilon || Math.abs(bottomRight.y - topLeft.y - uy - vy) > epsilon) return null
  const scale = (SIZE - PADDING * 2) / Math.max(original.width, original.height)
  const destinationX = (SIZE - original.width * scale) / 2 + trim.x * scale
  const destinationY = (SIZE - original.height * scale) / 2 + trim.y * scale
  const destinationWidth = trim.width * scale, destinationHeight = trim.height * scale
  const a = destinationWidth * vy / determinant, c = -destinationWidth * vx / determinant
  const b = -destinationHeight * uy / determinant, d = destinationHeight * ux / determinant
  const xs = corners.map(point => point.x), ys = corners.map(point => point.y)
  return { original, trim, sourceCorners: corners,
    crop: { x: Math.max(0, Math.min(...xs)), y: Math.max(0, Math.min(...ys)), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) },
    transform: { a, b, c, d, tx: destinationX - a * topLeft.x - c * topLeft.y, ty: destinationY - b * topLeft.x - d * topLeft.y },
    // UNPACK (1) means premultiply only on GPU upload; its source is still straight alpha.
    premultiplied: Boolean(region?.page?.pma || texture.baseTexture?.alphaMode === 2),
  }
}

/** A PMA PNG is interpreted as straight-alpha by Canvas2D. Undo that extra
 * premultiplication on the bounded preview, never on the shared source image. */
export function unpremultiplyDeveloperThumbnail(data: Uint8ClampedArray): void {
  for (let index = 0; index + 3 < data.length; index += 4) {
    const alpha = data[index + 3]
    for (let channel = 0; channel < 3; channel++) data[index + channel] = alpha ? Math.min(255, Math.round(data[index + channel] * 255 / alpha)) : 0
  }
}

function canvasThumbnail(kind: DeveloperThumbnail['kind'], draw: (context: CanvasRenderingContext2D) => void,
  createCanvas: DeveloperThumbnailCanvasFactory): DeveloperThumbnail | null {
  let canvas: HTMLCanvasElement | null = null
  try {
    canvas = createCanvas()
    if (!canvas) return null
    canvas.width = canvas.height = SIZE
    const context = canvas.getContext('2d')
    if (!context) return null
    draw(context)
    const url = canvas.toDataURL('image/png')
    return url.startsWith('data:image/png') ? { url, width: SIZE, height: SIZE, kind } : null
  } catch { return null } // Unloaded images and tainted canvases have no preview.
  finally { if (canvas) canvas.width = canvas.height = 0 }
}

export function developerTextureThumbnail(value: unknown, region?: RegionLike,
  createCanvas: DeveloperThumbnailCanvasFactory = defaultCanvas): DeveloperThumbnail | null {
  try {
    const texture = pixiTexture(value)
    const image = texture?.baseTexture?.resource?.source
    const source = image && imageSize(image)
    const plan = texture && source && developerTextureThumbnailPlan(texture, source, region)
    if (!plan || !image) return null
    return canvasThumbnail('texture', context => {
      const { transform: matrix, crop } = plan
      const mapped = (point: Point) => ({ x: matrix.a * point.x + matrix.c * point.y + matrix.tx,
        y: matrix.b * point.x + matrix.d * point.y + matrix.ty })
      const points = plan.sourceCorners.map(mapped)
      context.beginPath(); context.moveTo(points[0].x, points[0].y)
      for (const point of points.slice(1)) context.lineTo(point.x, point.y)
      context.closePath(); context.clip()
      context.setTransform(matrix.a, matrix.b, matrix.c, matrix.d, matrix.tx, matrix.ty)
      // Nearest filtering avoids blending separately encoded PMA edge pixels
      // twice before the small preview is unpremultiplied.
      context.imageSmoothingEnabled = !plan.premultiplied
      context.drawImage(image, crop.x, crop.y, crop.width, crop.height, crop.x, crop.y, crop.width, crop.height)
      context.setTransform(1, 0, 0, 1, 0, 0)
      if (plan.premultiplied) {
        const pixels = context.getImageData(0, 0, SIZE, SIZE)
        unpremultiplyDeveloperThumbnail(pixels.data)
        context.putImageData(pixels, 0, 0)
      }
    }, createCanvas)
  } catch { return null }
}

/** Reuse an already decoded DOM image/canvas. The caller supplies its intrinsic
 * dimensions; this does not load, retain, or alter that source. */
export function createDeveloperImageThumbnail(source: CanvasImageSource, width: number, height: number,
  createCanvas: DeveloperThumbnailCanvasFactory = defaultCanvas): DeveloperThumbnail | null {
  if (!positive(width, height)) return null
  return developerTextureThumbnail({ valid: true, orig: { width, height },
    _uvs: { x0: 0, y0: 0, x1: 1, y1: 0, x2: 1, y2: 1, x3: 0, y3: 1 },
    baseTexture: { width, height, resource: { source } },
  }, undefined, createCanvas)
}

export function developerClippingThumbnail(attachment: ClippingAttachment, slot: Slot,
  createCanvas: DeveloperThumbnailCanvasFactory = defaultCanvas): DeveloperThumbnail | null {
  try {
    const length = attachment.worldVerticesLength
    if (!Number.isInteger(length) || length < 6 || length % 2 || length > 8192) return null
    const vertices = new Float32Array(length)
    // VertexAttachment's implementation only reads bones and deforms. In
    // contrast, Region/Mesh computeWorldVertices can apply and mutate sequences.
    const sampledSlot = slot.attachment === attachment ? slot : { ...slot, deform: [] }
    attachment.computeWorldVertices(sampledSlot as Slot, 0, length, vertices, 0, 2)
    const points = Array.from({ length: length / 2 }, (_, index) => ({ x: vertices[index * 2], y: vertices[index * 2 + 1] }))
    if (points.some(point => !finite(point.x, point.y))) return null
    const xs = points.map(point => point.x), ys = points.map(point => point.y)
    const minX = Math.min(...xs), minY = Math.min(...ys), width = Math.max(...xs) - minX, height = Math.max(...ys) - minY
    if (!positive(width, height)) return null
    const scale = (SIZE - 16) / Math.max(width, height)
    return canvasThumbnail('geometry', context => {
      const map = (point: Point) => ({ x: (SIZE - width * scale) / 2 + (point.x - minX) * scale,
        y: (SIZE - height * scale) / 2 + (point.y - minY) * scale })
      const polygon = points.map(map)
      context.beginPath(); context.moveTo(polygon[0].x, polygon[0].y)
      for (const point of polygon.slice(1)) context.lineTo(point.x, point.y)
      context.closePath(); context.fillStyle = '#56d8f033'; context.fill()
      context.strokeStyle = '#56d8f0'; context.lineWidth = 2; context.stroke()
    }, createCanvas)
  } catch { return null }
}

function namedAttachment(spine: Spine, slot: Slot, index: number, requested: string | null | undefined): Attachment | null {
  if (requested === null) return null
  const current = slot.attachment ?? suppressedCameraMatteAttachments(spine)?.get(slot.data.name) ?? null
  if (requested === undefined || current?.name === requested) return current
  const suppressed = suppressedCameraMatteAttachments(spine)?.get(slot.data.name)
  if (suppressed?.name === requested) return suppressed
  const skins = new Set([spine.skeleton.skin, spine.skeleton.data.defaultSkin, ...spine.skeleton.data.skins])
  for (const skin of skins) {
    if (!skin) continue
    const direct = skin.getAttachment(index, requested)
    if (direct?.name === requested) return direct
    const entries: Array<{ attachment: Attachment }> = []
    skin.getAttachmentsForSlot(index, entries as Parameters<typeof skin.getAttachmentsForSlot>[1])
    const found = entries.find(entry => entry.attachment.name === requested)
    if (found) return found.attachment
  }
  return null
}

function attachmentThumbnail(attachment: Attachment | null, slot: Slot, createCanvas: DeveloperThumbnailCanvasFactory) {
  return attachment instanceof ClippingAttachment ? developerClippingThumbnail(attachment, slot, createCanvas)
    : attachment instanceof RegionAttachment || attachment instanceof MeshAttachment
      ? attachment.region && developerTextureThumbnail(attachment.region.texture, attachment.region, createCanvas) : null
}

/** Requests describe a snapshot attachment. When an animation changes it before
 * the queued request runs, look up that exact name without changing the slot. */
export function createDeveloperThumbnailSource(layers: readonly ThumbnailLayer[], isDisposed: () => boolean,
  createCanvas: DeveloperThumbnailCanvasFactory = defaultCanvas) {
  return (candidate: DeveloperPickCandidate): DeveloperThumbnail | null => {
    if (isDisposed()) return null
    try {
      const layer = layers.find(item => item.id === candidate.layerId)
      if (!layer) return null
      if (candidate.kind === 'slot') {
        if (!layer.spine) return null
        const index = layer.spine.skeleton.slots.findIndex(slot => developerSlotId(layer.id, slot.data.name) === candidate.id)
        if (index < 0) return null
        const slot = layer.spine.skeleton.slots[index]
        return attachmentThumbnail(namedAttachment(layer.spine, slot, index, candidate.attachment), slot, createCanvas)
      }
      if (candidate.id !== layer.id) return null
      if (!layer.spine) return developerTextureThumbnail((layer.object as { texture?: unknown }).texture, undefined, createCanvas)
      // A layer card explicitly shows a representative texture, not a rendered
      // pose. Never render/extract the live scene or update its skeleton here.
      const items = layer.spine.skeleton.drawOrder.flatMap(slot => {
        const attachment = slot.attachment
        if (!(attachment instanceof RegionAttachment || attachment instanceof MeshAttachment) || !attachment.region) return []
        const region = attachment.region
        return [{ slot, attachment, mask: /mask|matte|black|shadow|hei(?:ying|dian|ping)/i.test(slot.data.name + ' ' + attachment.name),
          area: region.width * region.height }]
      }).sort((a, b) => Number(a.mask) - Number(b.mask) || b.area - a.area)
      for (const item of items) {
        const result = attachmentThumbnail(item.attachment, item.slot, createCanvas)
        if (result) return result
      }
      return null
    } catch { return null }
  }
}
