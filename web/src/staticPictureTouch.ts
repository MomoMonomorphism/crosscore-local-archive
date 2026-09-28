import { hitTestConfig } from './hotspotGeometry'

export type StaticPictureTouch = {
  index: number
  areas: Array<[number, number, number, number, number]>
  audioId?: number[]
}

/** CfgMultiImageAction rectangles are local to the centered archive image. */
export function hitStaticPicture(
  image: HTMLImageElement,
  clientX: number,
  clientY: number,
  rows: StaticPictureTouch[],
): StaticPictureTouch | null {
  const width = image.naturalWidth
  const height = image.naturalHeight
  if (!width || !height) return null
  const box = image.getBoundingClientRect()
  const scale = Math.min(box.width / width, box.height / height)
  if (!Number.isFinite(scale) || scale <= 0) return null
  const left = box.left + (box.width - width * scale) / 2
  const top = box.top + (box.height - height * scale) / 2
  const imageX = (clientX - left) / scale
  const imageY = (clientY - top) / scale
  if (imageX < 0 || imageX > width || imageY < 0 || imageY > height) return null
  const point = { x: imageX - width / 2, y: height / 2 - imageY }
  const spots = rows.flatMap((row) => row.areas.map((rect) => ({ index: row.index, rect })))
  const hit = hitTestConfig(spots, point)
  return rows.find((row) => row.index === hit?.index) ?? null
}
