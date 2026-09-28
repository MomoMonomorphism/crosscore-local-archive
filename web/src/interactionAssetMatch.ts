import type { ModelAsset, Variant } from './types'

export const figureKey = (value: string | null | undefined) =>
  (value ?? '').toLocaleLowerCase().replace(/[^a-z0-9]/g, '').replace(/spine$/, '')

/**
 * The gallery can contain several skeletons from one prefab pack. Prefer a
 * skeleton whose source name AND pack identify the configured pose, then a
 * pack match (for shipped filename typos), then a source-name fallback.
 */
export function poseMatchScore(asset: ModelAsset, l2dName: string): number {
  const wanted = figureKey(l2dName)
  const folder = figureKey(asset.folder) === wanted
  const source = figureKey(asset.sourceName) === wanted
  return folder && source ? 3 : folder ? 2 : source ? 1 : 0
}

export function findPoseVariantIndex(variants: Variant[], l2dName: string): number {
  let bestIndex = -1
  let bestScore = 0
  for (let index = 0; index < variants.length; index += 1) {
    const score = poseMatchScore(variants[index].main, l2dName)
    if (score > bestScore) {
      bestIndex = index
      bestScore = score
    }
  }
  return bestIndex
}
