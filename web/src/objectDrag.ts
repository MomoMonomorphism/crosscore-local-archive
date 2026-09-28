import type { InteractionRow } from './interactionMachine'

// PC Custom/prefabs: MainCanvas 2656386949770152419, camera
// 8709985717204779959; CanvasScaler reference 1920x1080, plane=100,
// perspective vertical FOV=60. RoleSpineItem2 compares Transform.position.
export const uiWorldUnitsPerReferencePixel = 2 * 100 * Math.tan(Math.PI / 6) / 1080
export function objectWorldScale(host: { distanceScale: number }, poseScale = 1) {
  return host.distanceScale * Math.abs(poseScale) * uiWorldUnitsPerReferencePixel
}

// CardTouchItem.OnDragXY enables native movement on its second callback.
// DragCallLua reads move after invoking Lua, then sets the absolute world point.
export function advanceObjectDrag(state: { count: number; nested: boolean }) {
  state.count++
  return !state.nested || state.count >= 2
}

export function objectDropAnimation(host: NonNullable<InteractionRow['dragHost']>, x: number, y: number, poseScale = 1) {
  let animation: string | null = null
  for (const target of host.targets) {
    if (Math.hypot(x-target.x,y-target.y)*objectWorldScale(host,poseScale) < 10) animation=target.animation
  }
  return animation
}
