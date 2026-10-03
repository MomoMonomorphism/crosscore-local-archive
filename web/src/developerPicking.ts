import { Graphics, type Application, type DisplayObject } from 'pixi.js'
import { ClippingAttachment, MeshAttachment, type Slot } from '@esotericsoftware/spine-core'
import type { Spine } from '@esotericsoftware/spine-pixi-v7'
import { developerLayerPresentation, developerSlotId, type DeveloperOverrides, type DeveloperPickCandidate } from './developerControls'
import { suppressedCameraMatteAttachments } from './spineCameraMatte'

type Point = { x: number; y: number }
type Matrix = { a: number; b: number; c: number; d: number; tx: number; ty: number }
type PickObject = DisplayObject & {
  children?: PickObject[]; name?: string; geometry?: {
    getBuffer: (name: string) => { data: ArrayLike<number> } | undefined
    indexBuffer?: { data: ArrayLike<number> }
  }
  texture?: { orig?: { width: number; height: number }; trim?: { x: number; y: number; width: number; height: number } | null }
  anchor?: Point; vertexData?: ArrayLike<number>; size?: number; start?: number
}
export type DeveloperPickLayer = { id: string; label: string; object: DisplayObject; spine?: Spine }
type Geometry = { positions: ArrayLike<number>; indices: ArrayLike<number>; matrix: Matrix; start?: number; size?: number }
type Target = { layer: DeveloperPickLayer; object: PickObject; slot?: Slot }
const identity: Matrix = { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 }

/** A retained canvas can have layout rectangles while its preview wrapper is
 * visibility:hidden. Check the DOM only when choosing/picking a scene. */
export function developerSurfaceVisible(surface: HTMLElement | null): boolean {
  if (!surface) return false
  if (typeof surface.getClientRects === 'function' && surface.getClientRects().length === 0) return false
  if (typeof getComputedStyle !== 'function') return true
  for (let node: HTMLElement | null = surface; node; node = node.parentElement) {
    try {
      const style = getComputedStyle(node)
      const opacity = Number.parseFloat(style.opacity)
      if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse'
        || Number.isFinite(opacity) && opacity <= 1e-5) return false
    } catch { /* Structural headless canvases have no browser style context. */ }
  }
  return true
}

export function developerClientPoint(surface: { getBoundingClientRect: () => { left: number; top: number; width: number; height: number } },
  screen: { width: number; height: number; x?: number; y?: number }, clientX: number, clientY: number): Point | null {
  const rect = surface.getBoundingClientRect()
  if (![rect.width, rect.height, screen.width, screen.height, clientX, clientY].every(Number.isFinite)
    || rect.width <= 0 || rect.height <= 0 || screen.width <= 0 || screen.height <= 0
    || clientX < rect.left || clientY < rect.top || clientX > rect.left + rect.width || clientY > rect.top + rect.height) return null
  return { x: (screen.x ?? 0) + (clientX - rect.left) * screen.width / rect.width,
    y: (screen.y ?? 0) + (clientY - rect.top) * screen.height / rect.height }
}

function transform(point: Point, matrix: Matrix): Point {
  return { x: matrix.a * point.x + matrix.c * point.y + matrix.tx,
    y: matrix.b * point.x + matrix.d * point.y + matrix.ty }
}
function inverse(point: Point, matrix: Matrix): Point | null {
  const determinant = matrix.a * matrix.d - matrix.b * matrix.c
  if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-12) return null
  const x = point.x - matrix.tx, y = point.y - matrix.ty
  return { x: (matrix.d * x - matrix.c * y) / determinant, y: (-matrix.b * x + matrix.a * y) / determinant }
}

/** Hit the actual clipped triangle buffers, including negative scale and skew.
 * This is geometric picking; texture-transparent pixels can still be candidates. */
export function developerTriangleHit(geometry: Geometry, worldPoint: Point): boolean {
  const point = inverse(worldPoint, geometry.matrix)
  if (!point) return false
  const { positions, indices } = geometry
  const start = geometry.start ?? 0
  const end = geometry.size ? Math.min(indices.length, start + geometry.size) : indices.length
  for (let index = start; index + 2 < end; index += 3) {
    const a = indices[index] * 2, b = indices[index + 1] * 2, c = indices[index + 2] * 2
    if (Math.max(a, b, c) + 1 >= positions.length || Math.min(a, b, c) < 0) continue
    const ax = positions[a], ay = positions[a + 1], bx = positions[b], by = positions[b + 1], cx = positions[c], cy = positions[c + 1]
    const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax)
    if (!Number.isFinite(area) || Math.abs(area) < 1e-10) continue
    const ab = (bx - ax) * (point.y - ay) - (by - ay) * (point.x - ax)
    const bc = (cx - bx) * (point.y - by) - (cy - by) * (point.x - bx)
    const ca = (ax - cx) * (point.y - cy) - (ay - cy) * (point.x - cx)
    const epsilon = Math.abs(area) * 1e-7
    if (area > 0 ? Math.min(ab, bc, ca) >= -epsilon : Math.max(ab, bc, ca) <= epsilon) return true
  }
  return false
}

/** Boundary edges only, so the selection does not cover the illustration in a
 * triangle grid. Clipped tessellation can duplicate vertices at a shared edge. */
export function developerGeometryOutline(geometry: Geometry): Array<[Point, Point]> {
  const edges = new Map<string, { count: number; a: Point; b: Point }>()
  const { positions, indices } = geometry
  const key = (point: Point) => `${Math.round(point.x * 10000)},${Math.round(point.y * 10000)}`
  const start = geometry.start ?? 0
  const end = geometry.size ? Math.min(indices.length, start + geometry.size) : indices.length
  for (let index = start; index + 2 < end; index += 3) {
    const vertices = [indices[index], indices[index + 1], indices[index + 2]].map(vertex =>
      transform({ x: positions[vertex * 2], y: positions[vertex * 2 + 1] }, geometry.matrix))
    if (vertices.some(point => !Number.isFinite(point.x) || !Number.isFinite(point.y))) continue
    for (let edge = 0; edge < 3; edge++) {
      const a = vertices[edge], b = vertices[(edge + 1) % 3], ka = key(a), kb = key(b)
      if (ka === kb) continue
      const id = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`
      const prior = edges.get(id)
      if (prior) prior.count++
      else edges.set(id, { count: 1, a, b })
    }
  }
  return [...edges.values()].filter(edge => edge.count === 1).map(edge => [edge.a, edge.b])
}

function geometryOf(object: PickObject): Geometry | null {
  try {
    const positions = object.geometry?.getBuffer('aVertexPosition')?.data
    const indices = object.geometry?.indexBuffer?.data
    if (positions?.length && indices?.length) return { positions, indices,
      matrix: object.worldTransform ?? identity, start: object.start, size: object.size }
    const texture = object.texture
    if (!texture) return null
    // Sprite's trimmed local quad matches calculateVertices without updating or
    // touching its texture. It also follows moving sprites during highlighting.
    if (texture.orig && object.anchor) {
      const orig = texture.orig, trim = texture.trim, anchor = object.anchor
      const x = (trim?.x ?? 0) - anchor.x * orig.width, y = (trim?.y ?? 0) - anchor.y * orig.height
      const width = trim?.width ?? orig.width, height = trim?.height ?? orig.height
      return { positions: [x, y, x + width, y, x + width, y + height, x, y + height],
        indices: [0, 1, 2, 0, 2, 3], matrix: object.worldTransform ?? identity }
    }
    if (object.vertexData && object.vertexData.length >= 8) return { positions: object.vertexData,
      indices: [0, 1, 2, 0, 2, 3], matrix: identity }
  } catch { /* Non-mesh display objects need no picking geometry. */ }
  return null
}

export function createDeveloperPicking(app: Application, layers: readonly DeveloperPickLayer[],
  getOverrides: () => DeveloperOverrides | null, isDisposed: () => boolean,
  areLayerOverridesApplied: () => boolean = () => false) {
  let selected: Target | null = null
  let overlay: Graphics | null = null
  const latestTargets = new Map<string, Target>()
  const surface = (): HTMLElement | null => {
    if (isDisposed()) return null
    try {
      const view = app.view as unknown as HTMLElement | undefined
      return view && typeof view.getBoundingClientRect === 'function' ? view : null
    } catch { return null }
  }
  const environment = () => {
    const overrides = getOverrides()
    // Graphics.updateTransform runs inside renderer.render, after the scene has
    // applied temporary layer alpha/visibility. Outside a draw the original
    // values have been restored, so only that path computes the override again.
    const applied = areLayerOverridesApplied()
    const byObject = new Map(layers.map(layer => [layer.object, layer]))
    const forced = new Set<DisplayObject>()
    const solo = overrides?.solo
    for (const layer of layers) {
      const show = solo ? solo.kind === 'layer' ? solo.id === layer.id : solo.id.startsWith(`${layer.id}::`)
        : overrides?.layers[layer.id]?.hidden === false
      if (show) for (let parent = layer.object.parent; parent && parent !== app.stage?.parent; parent = parent.parent) forced.add(parent)
    }
    const presentation = (object: DisplayObject) => {
      let opacity = 1
      for (let node: DisplayObject | null = object; node; node = node.parent) {
        if (node.renderable === false && node !== app.stage) return { visible: false, opacity: 0 }
        const layer = byObject.get(node)
        const state = layer && !applied ? developerLayerPresentation(layer.id, node.visible, node.alpha, overrides)
          : { visible: node.visible, opacity: node.alpha }
        if (!state.visible && !forced.has(node)) return { visible: false, opacity: 0 }
        opacity *= state.opacity
      }
      return { visible: opacity > 1e-5, opacity }
    }
    const maskContains = (object: DisplayObject, point: Point) => {
      for (let node: DisplayObject | null = object; node; node = node.parent) {
        const layer = byObject.get(node)
        if (layer && overrides?.layers[layer.id]?.disableClipping) continue
        const raw = node.mask as unknown as { maskObject?: unknown; containsPoint?: (point: Point) => boolean } | null
        const mask = (raw?.maskObject ?? raw) as { containsPoint?: (point: Point) => boolean } | null
        if (typeof mask?.containsPoint === 'function') {
          try { if (!mask.containsPoint(point)) return false } catch { /* Unknown mask implementations use geometry-only fallback. */ }
        }
      }
      return true
    }
    return { overrides, byObject, presentation, maskContains }
  }
  const meshSlots = (layer: DeveloperPickLayer) => {
    // Never call getMeshForSlot: the runtime getter turns a hidden mesh visible.
    const spine = layer.spine as unknown as { meshesCache?: Map<Slot, PickObject> } | undefined
    return spine?.meshesCache instanceof Map ? spine.meshesCache : new Map<Slot, PickObject>()
  }
  const clippingFor = (layer: DeveloperPickLayer, overrides: DeveloperOverrides | null) => {
    const result = new Map<Slot, string[]>()
    let clip: { slot: Slot; attachment: ClippingAttachment } | null = null
    for (const slot of layer.spine?.skeleton.drawOrder ?? []) {
      const attachment = slot.attachment
      if (attachment instanceof ClippingAttachment && slot.bone.active
        && !overrides?.slots[developerSlotId(layer.id, slot.data.name)]?.disableClipping) {
        clip ??= { slot, attachment }
      } else if (clip) result.set(slot, [developerSlotId(layer.id, clip.slot.data.name)])
      if (clip?.attachment.endSlot === slot.data) clip = null
    }
    return result
  }
  const targetVisible = (target: Target, env: ReturnType<typeof environment>) => {
    const state = env.presentation(target.object)
    if (!state.visible || target.slot && target.object.visible === false) return false
    if (target.slot) {
      const slotId = developerSlotId(target.layer.id, target.slot.data.name)
      const rule = env.overrides?.slots[slotId], solo = env.overrides?.solo
      if (solo?.kind === 'slot' ? solo.id !== slotId : rule?.hidden) return false
      const attachment = target.slot.attachment ?? suppressedCameraMatteAttachments(target.layer.spine!)?.get(target.slot.data.name)
      if (!attachment || attachment instanceof ClippingAttachment || !target.slot.bone.active) return false
      const tint = attachment as unknown as { color?: { a: number } }
      if (target.slot.color.a * (tint.color?.a ?? 1) * (rule?.opacity ?? 1) <= 1e-5) return false
    }
    return true
  }
  const pick = (clientX: number, clientY: number): DeveloperPickCandidate[] => {
    latestTargets.clear()
    if (isDisposed()) return []
    const view = surface()
    const screen = app.screen ?? app.renderer?.screen
    if (isDisposed() || !view || !screen || !developerSurfaceVisible(view)) return []
    const point = developerClientPoint(view, screen, clientX, clientY)
    if (!point) return []
    const env = environment()
    const slots = new Map<PickObject, { layer: DeveloperPickLayer; slot: Slot }>()
    const clips = new Map<DeveloperPickLayer, Map<Slot, string[]>>()
    for (const layer of layers) {
      for (const [slot, mesh] of meshSlots(layer)) slots.set(mesh, { layer, slot })
      if (layer.spine) clips.set(layer, clippingFor(layer, env.overrides))
    }
    const hits: DeveloperPickCandidate[] = []
    const seen = new Set<string>()
    const visit = (object: PickObject, inherited: DeveloperPickLayer | undefined) => {
      if (object === (overlay as DisplayObject | null)) return
      const layer = env.byObject.get(object) ?? inherited
      // Pixi paints an object's own content, then children in their actual sorted
      // order. Walking children backwards first returns foreground candidates.
      for (const child of [...(object.children ?? [])].reverse()) visit(child, layer)
      const slot = slots.get(object)
      const geometry = geometryOf(object)
      if (!layer || !geometry) return
      const target: Target = { object, layer: slot?.layer ?? layer, slot: slot?.slot }
      if (!targetVisible(target, env) || !env.maskContains(object, point)) return
      if (!developerTriangleHit(geometry, point)) return
      const id = target.slot ? developerSlotId(target.layer.id, target.slot.data.name) : target.layer.id
      if (seen.has(id)) return
      seen.add(id); latestTargets.set(id, target)
      const attachment = target.slot?.attachment ?? (target.slot ? suppressedCameraMatteAttachments(target.layer.spine!)?.get(target.slot.data.name) : null)
      hits.push({ id, kind: target.slot ? 'slot' : 'layer', layerId: target.layer.id,
        label: target.slot?.data.name ?? target.layer.label, attachment: attachment?.name ?? null,
        type: target.slot ? attachment instanceof MeshAttachment ? 'mesh' : 'region' : 'layer',
        order: hits.length, opacity: env.presentation(object).opacity,
        relatedClipping: target.slot ? clips.get(target.layer)?.get(target.slot) ?? [] : [] })
    }
    if (app.stage) visit(app.stage as PickObject, undefined)
    return hits
  }
  const drawHighlight = () => {
    if (!overlay) return
    overlay.clear()
    if (!selected || isDisposed()) return
    const env = environment()
    if (!targetVisible(selected, env)) return
    const geometry = geometryOf(selected.object)
    if (!geometry) return
    const stageMatrix = app.stage.worldTransform ?? identity
    const scale = Math.max(Math.hypot(stageMatrix.a, stageMatrix.b), Math.hypot(stageMatrix.c, stageMatrix.d), 1e-6)
    overlay.lineStyle(2 / scale, 0x56d8f0, 1)
    for (const [a, b] of developerGeometryOutline(geometry)) {
      const localA = inverse(a, stageMatrix), localB = inverse(b, stageMatrix)
      if (localA && localB) overlay.moveTo(localA.x, localA.y).lineTo(localB.x, localB.y)
    }
  }
  const highlight = (candidate: DeveloperPickCandidate | null) => {
    selected = candidate ? latestTargets.get(candidate.id) ?? null : null
    if (!selected || isDisposed()) { overlay?.clear(); return }
    if (!overlay && typeof document !== 'undefined' && app.stage?.addChild) {
      overlay = new Graphics()
      overlay.name = '__developer-selection-outline'
      overlay.eventMode = 'none'
      overlay.interactiveChildren = false
      overlay.zIndex = Number.MAX_SAFE_INTEGER
      const update = overlay.updateTransform.bind(overlay)
      overlay.updateTransform = () => { drawHighlight(); update() }
      app.stage.addChild(overlay)
    }
    drawHighlight()
  }
  return { surface, pick, highlight, dispose() {
    selected = null; latestTargets.clear()
    if (overlay) { overlay.removeFromParent(); overlay.destroy(); overlay = null }
  } }
}
