/** Geometry contract for CfgSpineAction touch rectangles.
 *
 * In the client, CardTouchItem and the Spine object share the `prefabObj`
 * space, but the hotspots are authored in the spine prefab's `pos` container
 * space (per-pack scale + offset, serialized in the bundle).  spine_action.py
 * remaps every rect into raw skeleton units before the manifest ships, so the
 * runtime deals with a single space: skeleton units, y-down (spine-pixi
 * yDown), identical to the pixi container's local axes.  No flip, no scale.
 */

export type Point = { x: number; y: number }
export type HotspotRectTuple = [number, number, number, number, number]
export type Hotspot = { index: number; rect: HotspotRectTuple; active?: boolean }

export function rectContains(rect: HotspotRectTuple, point: Point): boolean {
  const [centerX, centerY, width, height, degrees] = rect
  if (width <= 0 || height <= 0) return false
  const dx = point.x - centerX
  const dy = point.y - centerY
  const radians = degrees * Math.PI / 180
  const cos = Math.cos(radians)
  const sin = Math.sin(radians)
  const x = dx * cos + dy * sin
  const y = -dx * sin + dy * cos
  return Math.abs(x) <= width / 2 && Math.abs(y) <= height / 2
}

/**
 * Resolve a point using the client's sibling draw/raycast order. Touch items
 * are created in config order, hence the last active item wins an overlap.
 */
export function hitTestConfig(spots: Hotspot[], point: Point): Hotspot | null {
  for (let cursor = spots.length - 1; cursor >= 0; cursor -= 1) {
    const spot = spots[cursor]
    if (spot.active !== false && rectContains(spot.rect, point)) return spot
  }
  return null
}

/** Corners in skeleton/pixi space. The stored rects are already in skeleton
 * units (remapped from `pos` space by spine_action.py), and the pixi stage
 * uses the same axes (spine-pixi yDown), so corners apply the rotation
 * directly with no axis flip. */
export function rectCornersPixi(rect: HotspotRectTuple): Point[] {
  const [centerX, centerY, width, height, degrees] = rect
  const radians = degrees * Math.PI / 180
  const cos = Math.cos(radians)
  const sin = Math.sin(radians)
  return [
    [-width / 2, -height / 2],
    [width / 2, -height / 2],
    [width / 2, height / 2],
    [-width / 2, height / 2],
  ].map(([x, y]) => ({
    x: centerX + x * cos - y * sin,
    y: centerY + x * sin + y * cos,
  }))
}
