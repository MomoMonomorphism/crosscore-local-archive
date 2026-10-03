export type MotionTabVariant = 'navigation' | 'tabs' | 'chips'
export type MotionTabMetrics = {
  left: number
  top: number
  width: number
  height: number
  paddingLeft?: number
  paddingRight?: number
}
export type MotionTabBox = { x: number; y: number; width: number; height: number }

/** Use layout offsets so a pressed button's visual translation does not move its underline. */
export function motionTabBox(metrics: MotionTabMetrics, variant: MotionTabVariant): MotionTabBox | null {
  const { left, top, width, height } = metrics
  if (![left, top, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return null
  const maximumInset = Math.max(0, (width - 2) / 2)
  const inset = (value: number | undefined) => Math.min(maximumInset, Math.max(0, Number.isFinite(value) ? value! : 0))
  const start = variant === 'tabs' ? width / 4 : variant === 'navigation' ? inset(metrics.paddingLeft) : 0
  const end = variant === 'tabs' ? width / 4 : variant === 'navigation' ? inset(metrics.paddingRight) : 0
  const lineHeight = Math.min(2, height)
  return { x: left + start, y: top + height - lineHeight, width: width - start - end, height: lineHeight }
}
