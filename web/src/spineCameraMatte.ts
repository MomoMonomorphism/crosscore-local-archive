import { MeshAttachment, Spine } from '@esotericsoftware/spine-pixi-v7'

const hiddenSlots = new WeakMap<object, string[]>()
const scannedSkeletons = new WeakSet<object>()
const suppressedByInstance = new WeakMap<Spine, Map<string, NonNullable<ReturnType<Spine['skeleton']['slots'][number]['getAttachment']>>>>()

/** Retain the instance attachment for explicit developer inspection only. */
export const suppressedCameraMatteAttachments = (spine: Spine) => suppressedByInstance.get(spine)
function suppressSlot(spine: Spine, name: string) {
  const slot = spine.skeleton.findSlot(name)
  if (!slot?.attachment) return
  const suppressed = suppressedByInstance.get(spine) ?? new Map()
  suppressed.set(name, slot.attachment)
  suppressedByInstance.set(spine, suppressed)
  // Keep animated deforms: a developer may reveal this attachment while paused.
  slot.attachment = null
}

/**
 * The archive's free-framing views have no authored UI viewport. A quartet of
 * huge black framing meshes would dominate their bounds, even though it is not
 * part of the illustration. Suppress only that geometry signature; game-framed
 * interactive figures keep the original meshes and their animation timelines.
 */
export function suppressOversizedCameraMatte(spine: Spine): void {
  if (scannedSkeletons.has(spine.skeleton.data)) {
    for (const name of hiddenSlots.get(spine.skeleton.data) ?? []) {
      suppressSlot(spine, name)
    }
    return
  }

  const groups = new Map<string, Array<{ name: string; axis: 'x' | 'y'; edge: [number, number, number, number] }>>()
  for (const slot of spine.skeleton.slots) {
    const attachment = slot.getAttachment()
    if (!(attachment instanceof MeshAttachment) || attachment.worldVerticesLength !== 12) continue
    if (!/black|matte|mask/i.test(slot.data.name)) continue
    const vertices = new Float32Array(12)
    attachment.computeWorldVertices(slot, 0, 12, vertices, 0, 2)
    const [x0, y0, x1, y1] = [vertices[8], vertices[9], vertices[10], vertices[11]]
    const dx = Math.abs(x1 - x0)
    const dy = Math.abs(y1 - y0)
    const axis = dx > dy * 10 ? 'y' : dy > dx * 10 ? 'x' : null
    if (!axis || Math.max(dx, dy) < 100) continue
    const outerSpan = axis === 'x'
      ? Math.max(vertices[1], vertices[3], vertices[5], vertices[7], vertices[9], vertices[11])
        - Math.min(vertices[1], vertices[3], vertices[5], vertices[7], vertices[9], vertices[11])
      : Math.max(vertices[0], vertices[2], vertices[4], vertices[6], vertices[8], vertices[10])
        - Math.min(vertices[0], vertices[2], vertices[4], vertices[6], vertices[8], vertices[10])
    if (outerSpan < Math.max(dx, dy) * 2) continue
    const group = groups.get(attachment.name) ?? []
    group.push({ name: slot.data.name, axis, edge: [x0, y0, x1, y1] })
    groups.set(attachment.name, group)
  }

  for (const group of groups.values()) {
    const horizontal = group.filter((item) => item.axis === 'y')
    const vertical = group.filter((item) => item.axis === 'x')
    if (group.length !== 4 || horizontal.length !== 2 || vertical.length !== 2) continue
    const ys = horizontal.map(({ edge }) => (edge[1] + edge[3]) / 2).sort((a, b) => a - b)
    const xs = vertical.map(({ edge }) => (edge[0] + edge[2]) / 2).sort((a, b) => a - b)
    if (xs[1] - xs[0] <= 100 || ys[1] - ys[0] <= 100) continue
    if (horizontal.some(({ edge }) => Math.min(edge[0], edge[2]) > xs[0] || Math.max(edge[0], edge[2]) < xs[1])
      || vertical.some(({ edge }) => Math.min(edge[1], edge[3]) > ys[0] || Math.max(edge[1], edge[3]) < ys[1])) continue
    const names = group.map(({ name }) => name)
    hiddenSlots.set(spine.skeleton.data, names)
    scannedSkeletons.add(spine.skeleton.data)
    for (const name of names) {
      suppressSlot(spine, name)
    }
    return
  }
  scannedSkeletons.add(spine.skeleton.data)
}
