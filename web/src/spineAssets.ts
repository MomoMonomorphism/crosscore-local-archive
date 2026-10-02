import { Assets } from 'pixi.js'
import { spineAssetPath } from './sitePaths'
import type { ModelAsset } from './types'

export function spineAliases(asset: ModelAsset) {
  const key = `${asset.folder}:${asset.sourceName}:${asset.id}`
  return { skeleton: `skeleton:${key}`, atlas: `atlas:${asset.atlasPath}` }
}

/** Pixi coalesces in-flight requests and reuses decoded assets by these aliases.
 * Preloading the selected scene creates no renderer or mutable skeleton. */
export function loadSpineAssets(asset: ModelAsset) {
  const id = spineAliases(asset)
  return Assets.load([
    { alias: id.skeleton, src: spineAssetPath(asset.jsonPath) },
    { alias: id.atlas, src: spineAssetPath(asset.atlasPath) },
  ])
}
