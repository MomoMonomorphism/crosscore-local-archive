import { gameFrameTransform, type PrefabSpace } from './gameFrame'

export type InterludeView = { zoom: number; pan: { x: number; y: number }; flipped: boolean }
const layouts = new Map<string, Promise<PrefabSpace>>()

/** Resolve the interlude's own prefab, never the displayed character's touch space. */
export function loadInterludeSpace(folder: string): Promise<PrefabSpace> {
  let pending = layouts.get(folder)
  if (!pending) {
    pending = fetch(`/api/spine-layout/${encodeURIComponent(folder)}`).then(async response => {
      if (!response.ok) throw new Error(`过场预制体坐标 HTTP ${response.status}: ${folder}`)
      const { space } = await response.json() as { space: PrefabSpace | null }
      if (!space || !Number.isFinite(space.scale) || space.scale <= 0
        || !Number.isFinite(space.offsetX) || !Number.isFinite(space.offsetY))
        throw new Error(`过场预制体坐标未解析: ${folder}`)
      return space
    }).catch(error => { layouts.delete(folder); throw error })
    layouts.set(folder, pending)
  }
  return pending
}

/** RoleSpineItem2.SetInterlude parents to gameObject, outside prefabObj(l2dPos).
 * The authored prefab transform still applies. Only viewer controls are shared. */
export function interludeFrame(width: number, height: number, space: PrefabSpace, view: InterludeView) {
  return gameFrameTransform(width, height, space, [0, 0, 1], view.zoom, view.pan, view.flipped)
}
