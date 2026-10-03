import type { DeveloperPickCandidate } from './developerControls'

export type DeveloperDomThumbnailSource = { source: HTMLImageElement | HTMLCanvasElement; width: number; height: number }
const positive = (width: number, height: number) => Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0

/** Read intrinsic dimensions even when developer overrides hide the artwork.
 * SVG <image> is not a decoded CanvasImageSource and is deliberately skipped. */
export function loadedDeveloperDomThumbnailSource(element: Element | null): DeveloperDomThumbnailSource | null {
  if (!element?.isConnected) return null
  if (element.tagName.toLowerCase() === 'img') {
    const source = element as HTMLImageElement
    return source.complete && positive(source.naturalWidth, source.naturalHeight)
      ? { source, width: source.naturalWidth, height: source.naturalHeight } : null
  }
  if (element.tagName.toLowerCase() === 'canvas') {
    const source = element as HTMLCanvasElement
    return positive(source.width, source.height) ? { source, width: source.width, height: source.height } : null
  }
  return null
}

/** Resolve only this exact pick wrapper's own artwork. Ancestor containers must
 * not borrow an image from another independently selectable descendant layer. */
export function findDeveloperDomThumbnailSource(root: HTMLElement | null,
  candidate: DeveloperPickCandidate): DeveloperDomThumbnailSource | null {
  if (!root?.isConnected || candidate.kind !== 'layer' || candidate.id !== candidate.layerId) return null
  try {
    const elements = [root, ...root.querySelectorAll<HTMLElement>('[data-developer-pick-id]')]
    const owner = elements.find(element => element.dataset.developerPickId === candidate.id)
    if (!owner?.isConnected || !root.contains(owner)) return null
    const sources = [owner, ...owner.querySelectorAll<HTMLElement>('img,canvas')]
    for (const element of sources) {
      if (element.closest('[data-developer-pick-id]') !== owner) continue
      const value = loadedDeveloperDomThumbnailSource(element)
      if (value) return value
    }
  } catch { /* A UI node can unmount while a queued thumbnail is being read. */ }
  return null
}
