export type PrefabSpace = {
  scale: number; offsetX: number; offsetY: number
  mainScale?: number; mainOffsetX?: number; mainOffsetY?: number
}
export type GamePosition = readonly [number, number, number]

/** Map authored UI coordinates to the chosen 1920×1080 (16:9) reference frame.
 * Keep the transform independent of skeleton bounds so offscreen scene branches
 * can enter the view later in their own animation. */
export function gameFrameTransform(
  screenWidth: number,
  screenHeight: number,
  prefab: PrefabSpace,
  l2dPos: GamePosition = [0, 0, 1],
  zoom = 1,
  pan = { x: 0, y: 0 },
  flipped = false,
) {
  const unit = Math.min(screenWidth / 1920, screenHeight / 1080)
  // Unity hierarchy: prefabObj(l2dPos) -> pos -> main -> Spine skeleton.
  // Hotspots are children of prefabObj, so apply the same nested transform
  // to the art that spine_action.py inverts for each touch rectangle.
  const mainScale = prefab.mainScale ?? 1
  const nestedX = prefab.offsetX + prefab.scale * (prefab.mainOffsetX ?? 0)
  const nestedY = prefab.offsetY + prefab.scale * (prefab.mainOffsetY ?? 0)
  const scale = unit * prefab.scale * mainScale * l2dPos[2] * zoom
  return {
    scaleX: flipped ? -scale : scale,
    scaleY: scale,
    x: screenWidth / 2 + (l2dPos[0] + l2dPos[2] * nestedX) * unit + pan.x,
    // Unity UI has Y up; spine-pixi's local and screen coordinates have Y down.
    y: screenHeight / 2 - (l2dPos[1] + l2dPos[2] * nestedY) * unit + pan.y,
  }
}
