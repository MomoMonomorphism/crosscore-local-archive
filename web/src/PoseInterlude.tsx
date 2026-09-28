import { useEffect, useRef } from 'react'
import { createSceneLifetime } from './sceneLifetime'
import { Application, Assets, Container, Renderer, BLEND_MODES } from 'pixi.js'
import { Spine } from '@esotericsoftware/spine-pixi-v7'
import type { PrefabSpace } from './gameFrame'
import { interludeFrame, loadInterludeSpace } from './poseInterludeFrame'
import type { ModelAsset } from './types'
import { loadNativeSpineSettings, applyNativeSpineSettings } from './nativeSpineSettings'
import { traceStageFrame } from './stageFrameTrace'
import { spineAssetPath } from './sitePaths'

const assetUrl = spineAssetPath
export function poseAssetAliases(asset: ModelAsset) {
  return { skeleton: `skeleton:${asset.folder}:${asset.sourceName}:${asset.id}`, atlas: `atlas:${asset.atlasPath}` }
}
export async function preparePoseAsset(asset: ModelAsset) {
  const id = poseAssetAliases(asset)
  const [, settings] = await Promise.all([
    Assets.load([{ alias: id.skeleton, src: assetUrl(asset.jsonPath) }, { alias: id.atlas, src: assetUrl(asset.atlasPath) }]),
    loadNativeSpineSettings(asset),
  ])
  return settings
}
export type PoseInterludeCommand = {
  serial: number; asset: ModelAsset; animation: string; loop: boolean; durationMs: number
  zoom: number; pan: { x: number; y: number }; flipped: boolean
}

/** RoleSpineItem2 creates the interlude beside prefabObj. It must outlive SetImg
 * replacing the old character. Its configured lifetime starts after loading. */
export function PoseInterlude({ command, playing, speed, onDone, onError }: {
  command: PoseInterludeCommand; playing: boolean; speed: number
  onDone: (serial: number) => void; onError: (message: string) => void
}) {
  const host = useRef<HTMLDivElement>(null)
  const live = useRef({ playing, speed, onDone, onError }); live.current = { playing, speed, onDone, onError }
  useEffect(() => {
    const element = host.current
    if (!element) return
    let disposed = false, elapsed = 0, overlay: Spine | null = null
    const lifetime = createSceneLifetime()
    let space: PrefabSpace | null = null
    const app = new Application<HTMLCanvasElement>({ resizeTo: element, backgroundAlpha: 0,
      antialias: true, autoDensity: true, resolution: Math.min(devicePixelRatio || 1, 2) })
    if (app.renderer instanceof Renderer) {
      const renderer = app.renderer
      const additive = () => {
        const gl = renderer.gl
        ;(renderer.state as unknown as { blendModes: number[][] }).blendModes[BLEND_MODES.ADD] = [gl.ONE, gl.ONE, gl.ZERO, gl.ONE]
      }
      additive(); renderer.runners.contextChange.add({ contextChange: additive })
    }
    element.replaceChildren(app.view)
    const group = new Container(); app.stage.addChild(group)
    const fit = () => {
      if (!overlay || !space) return
      const frame = interludeFrame(app.screen.width, app.screen.height, space, command)
      group.scale.set(frame.scaleX, frame.scaleY); group.position.set(frame.x, frame.y)
      // Read-only DOM evidence for viewport vs authored-transform diagnosis.
      element.dataset.interludeFrame = JSON.stringify({ width: app.screen.width, height: app.screen.height, space, ...frame })
      traceStageFrame(element, `interlude:${command.serial}`, { viewport: { width: app.screen.width, height: app.screen.height },
        view: { zoom: command.zoom, pan: command.pan, flipped: command.flipped }, space, ...frame })
    }
    const observer = new ResizeObserver(() => { app.resize(); fit() }); observer.observe(element)
    void Promise.all([preparePoseAsset(command.asset), loadInterludeSpace(command.asset.folder)]).then(([settings, ownSpace]) => {
      if (disposed) return
      space = ownSpace
      overlay = lifetime.create(() => Spine.from(poseAssetAliases(command.asset))); overlay.autoUpdate = false
      applyNativeSpineSettings(overlay.state.data, settings)
      if (!overlay.skeleton.data.findAnimation(command.animation)) throw new Error(`过场缺少动画 ${command.animation}`)
      overlay.state.setAnimation(0, command.animation, command.loop); overlay.update(0)
      group.addChild(overlay); fit()
      app.ticker.add(() => {
        if (disposed || !live.current.playing || document.hidden || !overlay) return
        const ms = app.ticker.deltaMS * live.current.speed
        overlay.update(ms / 1000); elapsed += ms
        if (elapsed >= command.durationMs) { disposed = true; live.current.onDone(command.serial) }
      })
    }).catch(error => {
      if (!disposed) { live.current.onError(`姿态过场加载失败：${String(error)}`); live.current.onDone(command.serial) }
    })
    return () => { disposed = true; observer.disconnect(); app.destroy(true, { children: true, texture: false, baseTexture: false }); lifetime.dispose() }
  }, [command])
  return <div data-pose-interlude={command.serial} ref={host} style={{ position: 'absolute', inset: 0, zIndex: 9, pointerEvents: 'none' }} />
}
