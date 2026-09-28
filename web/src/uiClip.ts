export type UiClip = { duration: number; loop: boolean; curves: Array<{ path: string; property: string; channels: number[][][] }> }
export function sampleUiChannel(keys: number[][], time: number) {
  let key = keys[0]
  if (!key) return 0
  for (const candidate of keys) { if (candidate[0] > time) break;key = candidate }
  const dt = Math.max(0, time - key[0])
  return ((key[1] * dt + key[2]) * dt + key[3]) * dt + key[4]
}
export function sampleUiCamera(clip: UiClip, elapsed: number) {
  const time = Math.min(clip.duration, elapsed)
  const result: { scale?: number; offsetX?: number; offsetY?: number } = {}
  for (const curve of clip.curves) {
    if (curve.path !== 'pos') continue
    const value = sampleUiChannel(curve.channels[0], time)
    if (curve.property === 'scale') result.scale = value
    if (curve.property === 'm_AnchoredPosition.x') result.offsetX = value
    if (curve.property === 'm_AnchoredPosition.y') result.offsetY = value
  }
  return result
}
