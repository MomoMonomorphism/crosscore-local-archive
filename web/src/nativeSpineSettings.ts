import type { AnimationStateData } from '@esotericsoftware/spine-core'
import type { ModelAsset } from './types'

export type NativeSpineSettings = {
  defaultMix: number
  mixes: Array<{ from: string; to: string; duration: number }>
  startingAnimation: string
  startingLoop: boolean
}
type PackageSettings = { models: Record<string, NativeSpineSettings>; warnings: string[] }
const packages = new Map<string, Promise<PackageSettings>>()

export async function loadNativeSpineSettings(asset: Pick<ModelAsset, 'folder' | 'sourceName'>) {
  let pending = packages.get(asset.folder)
  if (!pending) {
    pending = fetch(`/api/spine-runtime/${encodeURIComponent(asset.folder)}`).then(async response => {
      if (!response.ok) throw new Error(`原生骨骼参数 HTTP ${response.status}: ${asset.folder}`)
      const value = await response.json() as PackageSettings
      if (!value.models) throw new Error(`原生骨骼参数格式错误: ${asset.folder}`)
      for (const message of value.warnings ?? []) console.warn(`[Spine settings] ${asset.folder}: ${message}`)
      return value
    }).catch(error => { packages.delete(asset.folder); throw error })
    packages.set(asset.folder, pending)
  }
  const settings = (await pending).models[asset.sourceName]
  if (!settings) console.warn(`[Spine settings] No unambiguous prefab profile: ${asset.folder}/${asset.sourceName}`)
  return settings ?? null
}

/** Apply to this instance only, before SetAnimation. Lua entry overrides still win. */
export function applyNativeSpineSettings(data: AnimationStateData, settings: NativeSpineSettings | null) {
  if (!settings) return
  data.defaultMix = settings.defaultMix
  for (const mix of settings.mixes) {
    if (data.skeletonData.findAnimation(mix.from) && data.skeletonData.findAnimation(mix.to))
      data.setMix(mix.from, mix.to, mix.duration)
    else console.warn(`[Spine settings] Missing mix animation: ${mix.from} -> ${mix.to}`)
  }
}
