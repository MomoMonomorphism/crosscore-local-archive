import { useEffect, useRef, useState } from 'react'
import { createSceneLifetime } from './sceneLifetime'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { Application, Assets, Container, Rectangle } from 'pixi.js'
import { MeshAttachment, RegionAttachment, Spine } from '@esotericsoftware/spine-pixi-v7'
import type { ModelAsset } from './types'
import { suppressOversizedCameraMatte } from './spineCameraMatte'
import { gameFrameTransform, type GamePosition } from './gameFrame'
import { useViewAdjustment, useViewReset, usePinchZoom } from './ImmersiveMode'
import { spineAssetPath } from './sitePaths'

/**
 * Renders an archive Spine picture with no dynamic touch configuration.
 *
 * Archive rows point at CG or HALF skeletons through `l2dName`, and those
 * skeletons differ from the ASMR 立绘 in one important way: they are not driven by
 * an album-length 運鏡 track. They carry a short set of named animations instead
 * (measured: `idle` plus 1–5 others, e.g. 4 on CG00010, 1 on CG0067), so the figure
 * is framed on the **first idle-like pose** and then plays whichever animation the
 * viewer picks, looping if it is the idle.
 *
 * Framing follows the same rule as the interaction stage: when the prefab pack
 * publishes a `pos` container via `/api/spine-layout/`, the authored 1920x1080
 * transform is used verbatim, which is what keeps the 16:9 composition intact.
 * Only when no authored space exists does it fall back to fitting the measured
 * visible bounds — and even then it fits rather than crops, because the archive
 * art and the skeletons disagree on aspect ratio (measured 2048x880 … 2048x2048
 * for the big images against a 16:9 screen), so cropping would lose picture.
 */

const MIN_ZOOM = 0.4
const MAX_ZOOM = 4

const assetUrl = spineAssetPath

function animationNames(spine: Spine) {
  return spine.skeleton.data.animations.map((item) => item.name)
}

/** `idle`, `idle1`, `Idle_Loop`, `stand`, `loop` all qualify; `camera` never does. */
export function idleAnimationName(names: string[]) {
  return names.find((name) => /^idle(_?\d+)?$/i.test(name))
    ?? names.find((name) => /idle/i.test(name))
    ?? names.find((name) => /stand|loop/i.test(name))
    ?? names.find((name) => !/camera|click|touch|tap/i.test(name))
    ?? ''
}

/**
 * Whether a named animation is worth offering as a manual trigger.
 *
 * `idle` is excluded because it is the default state, and the interaction-only
 * names (`click` / `touch` / `tap`) are excluded because the game's CG screens
 * have no confirmed hot spot wiring them up — listing them would imply a
 * behaviour that has not been shown to exist.
 */
export function selectableAnimations(names: string[]) {
  const idle = idleAnimationName(names)
  return names.filter((name) => name !== idle && !/click|touch|tap/i.test(name))
}

function visibleBounds(spine: Spine) {
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY

  for (const slot of spine.skeleton.drawOrder) {
    if (!slot.bone.active) continue
    const attachment = slot.getAttachment()
    if (!(attachment instanceof RegionAttachment) && !(attachment instanceof MeshAttachment)) continue
    if (spine.skeleton.color.a * slot.color.a * attachment.color.a <= 0.001) continue
    const vertices = attachment instanceof RegionAttachment
      ? new Float32Array(8)
      : new Float32Array(attachment.worldVerticesLength)
    if (attachment instanceof RegionAttachment) {
      attachment.computeWorldVertices(slot, vertices, 0, 2)
    } else {
      attachment.computeWorldVertices(slot, 0, attachment.worldVerticesLength, vertices, 0, 2)
    }
    for (let index = 0; index < vertices.length; index += 2) {
      const x = vertices[index]
      const y = vertices[index + 1]
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue
      minX = Math.min(minX, x)
      minY = Math.min(minY, y)
      maxX = Math.max(maxX, x)
      maxY = Math.max(maxY, y)
    }
  }

  if (!Number.isFinite(minX) || !Number.isFinite(minY)) return null
  return new Rectangle(minX, minY, maxX - minX, maxY - minY)
}

export type PictureFigureProbe = {
  assetId: string
  folder: string
  animations: string[]
  idle: string | null
  playing: string | null
  /** True when the authored 1920x1080 transform drove the framing. */
  gameFrame: boolean
  l2dPos: GamePosition
  screen: [number, number]
  /** screen[0] / screen[1]. The game frame is 16:9, so this must be ~1.7778. */
  screenAspect: number
  scale: number
  position: [number, number]
  bounds: [number, number, number, number] | null
}

type ProbeHost = { __pictureFigure?: () => PictureFigureProbe | null }

const round3 = (value: number) => Math.round(value * 1000) / 1000

type Props = {
  asset: ModelAsset
  /** CfgArchiveMultiPicture.l2dPos, also used by the interactive picture route. */
  l2dPos: GamePosition
  /** Animation to show. Null falls back to the idle pose. */
  animation: string | null
  playing: boolean
  previewResetSerial?: number
  onStatus: (status: string) => void
  onError: (message: string) => void
  /** Called once the model is up, so the caller can offer the animation list. */
  onAnimations: (animations: string[], idle: string | null) => void
}

export default function PictureFigure({
  asset,
  l2dPos,
  animation,
  playing,
  previewResetSerial = 0,
  onStatus,
  onError,
  onAnimations,
}: Props) {
  const viewControl = useViewAdjustment()
  const pinch = usePinchZoom(ratio => { viewRef.current.zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, viewRef.current.zoom * ratio)); fit() })
  useViewReset(() => { panRef.current = { x: 0, y: 0 }; viewRef.current.zoom = 1; fit() })
  const hostRef = useRef<HTMLDivElement>(null)
  const appRef = useRef<Application | null>(null)
  const groupRef = useRef<Container | null>(null)
  const spineRef = useRef<Spine | null>(null)
  const boundsRef = useRef<Rectangle | null>(null)
  const prefabSpaceRef = useRef<{ scale: number; offsetX: number; offsetY: number } | null>(null)
  const idleRef = useRef<string | null>(null)
  const activeRef = useRef<string | null>(null)
  const playingRef = useRef(playing)
  const viewRef = useRef({ zoom: 1 })
  const panRef = useRef({ x: 0, y: 0 })
  const pointerRef = useRef({ id: -1, x: 0, y: 0, panX: 0, panY: 0, dragged: false })
  /** Bumped when a model finishes loading, so the later effects know the refs exist. */
  const [ready, setReady] = useState(0)

  const fit = () => {
    const app = appRef.current
    const group = groupRef.current
    const bounds = boundsRef.current
    if (!app || !group) return
    // A host that has not been laid out yet reports a zero-height screen. Scaling
    // to it would divide by zero and park the figure off-frame, so wait for the
    // next resize callback instead of fitting against a degenerate box.
    if (!app.screen.width || !app.screen.height) return
    const prefab = prefabSpaceRef.current
    if (prefab?.scale) {
      const frame = gameFrameTransform(
        app.screen.width, app.screen.height, prefab,
        l2dPos, viewRef.current.zoom, panRef.current,
      )
      group.scale.set(frame.scaleX, frame.scaleY)
      group.position.set(frame.x, frame.y)
      return
    }
    if (!bounds?.width || !bounds.height) return
    // Fit rather than crop: the CG skeletons and the archive art do not share an
    // aspect ratio, so filling the frame would cut the picture.
    const scale = Math.min(
      (app.screen.width * 0.9) / bounds.width,
      (app.screen.height * 0.94) / bounds.height,
    ) * viewRef.current.zoom
    group.scale.set(scale)
    group.position.set(
      app.screen.width / 2 - (bounds.x + bounds.width / 2) * scale + panRef.current.x,
      app.screen.height / 2 - (bounds.y + bounds.height / 2) * scale + panRef.current.y,
    )
  }

  useEffect(() => {
    let disposed = false
    const lifetime = createSceneLifetime()
    const host = hostRef.current
    if (!host) return
    const app = new Application<HTMLCanvasElement>({
      resizeTo: host,
      antialias: true,
      autoDensity: true,
      backgroundAlpha: 0,
      resolution: Math.min(window.devicePixelRatio || 1, 2),
      powerPreference: 'high-performance',
    })
    appRef.current = app
    host.replaceChildren(app.view)

    const load = async () => {
      onStatus('正在从本地端提取立绘…')
      try {
        const key = `${asset.folder}:${asset.sourceName}:${asset.id}`
        const [, layoutResponse] = await Promise.all([
          Assets.load([
            { alias: `skeleton:${key}`, src: assetUrl(asset.jsonPath) },
            { alias: `atlas:${key}`, src: assetUrl(asset.atlasPath) },
          ]),
          fetch(`/api/spine-layout/${encodeURIComponent(asset.folder)}`).catch(() => null),
        ])
        if (disposed) return
        const layout = layoutResponse?.ok && layoutResponse.headers.get('content-type')?.includes('application/json')
          ? await layoutResponse.json() as { space?: { scale: number; offsetX: number; offsetY: number } | null }
          : null
        if (disposed) return
        prefabSpaceRef.current = layout?.space ?? null

        const spine = lifetime.create(() => Spine.from({ skeleton: `skeleton:${key}`, atlas: `atlas:${key}` }))
        const names = animationNames(spine)
        const idle = idleAnimationName(names)
        if (!idle) {
          spine.destroy({ children: true, texture: false, baseTexture: false })
          onError('该立绘没有可循环的 idle 动作')
          return
        }
        // Frame on the idle pose, before any other track exists, so the measured
        // bounds cannot include another animation's transform keys.
        spine.state.clearTracks()
        spine.skeleton.setToSetupPose()
        spine.state.setAnimation(0, idle, true)
        spine.update(0)
        if (!prefabSpaceRef.current) suppressOversizedCameraMatte(spine)
        const bounds = visibleBounds(spine)
        if (!bounds) {
          spine.destroy({ children: true, texture: false, baseTexture: false })
          onError('该立绘没有可见附件')
          return
        }

        const group = lifetime.create(() => new Container())
        group.addChild(spine)
        app.stage.addChild(group)
        groupRef.current = group
        spineRef.current = spine
        boundsRef.current = bounds
        idleRef.current = idle
        activeRef.current = idle
        panRef.current = { x: 0, y: 0 }
        viewRef.current = { zoom: 1 }
        spine.state.timeScale = playingRef.current ? 1 : 0
        fit()
        onStatus(`${asset.spineVersion} · idle=${idle} · 共 ${names.length} 个动作`)
        onAnimations(names, idle)
        ;(window as unknown as ProbeHost).__pictureFigure = () => {
          const live = spineRef.current
          if (!live) return null
          const box = boundsRef.current
          return {
            assetId: asset.id,
            folder: asset.folder,
            animations: names,
            idle: idleRef.current,
            playing: activeRef.current,
            gameFrame: Boolean(prefabSpaceRef.current?.scale),
            l2dPos,
            screen: [app.screen.width, app.screen.height],
            screenAspect: round3(app.screen.width / Math.max(app.screen.height, 1)),
            scale: round3(group.scale.x),
            position: [round3(group.position.x), round3(group.position.y)],
            bounds: box ? [round3(box.x), round3(box.y), round3(box.width), round3(box.height)] : null,
          }
        }
        setReady((count) => count + 1)
      } catch (error) {
        if (!disposed) onError(error instanceof Error ? error.message : String(error))
      }
    }

    const resizeObserver = new ResizeObserver(() => { app.resize(); fit() })
    resizeObserver.observe(host)
    void load()
    return () => {
      disposed = true
      resizeObserver.disconnect()
      delete (window as unknown as ProbeHost).__pictureFigure
      spineRef.current = null
      groupRef.current = null
      boundsRef.current = null
      prefabSpaceRef.current = null
      idleRef.current = null
      activeRef.current = null
      appRef.current = null
      app.destroy(true, { children: true, texture: false, baseTexture: false })
      lifetime.dispose()
    }
  }, [asset, l2dPos, onError, onStatus, onAnimations])

  useEffect(() => {
    const spine = spineRef.current
    if (!spine) return
    const idle = idleRef.current
    const names = animationNames(spine)
    const next = animation && names.includes(animation) ? animation : idle
    if (!next) return
    // Switching animation is a deliberate state change, so reset to the setup pose
    // first: without it, bones the previous animation keyed would stay wherever it
    // left them and the two screens would bleed into each other.
    spine.state.clearTracks()
    spine.skeleton.setToSetupPose()
    activeRef.current = next
    spine.state.setAnimation(0, next, next === idle)
    spine.update(0)
  }, [animation, ready, previewResetSerial])

  // The host's final size is not known when the model first loads — the toolbar
  // below the canvas wraps, and the 16:9 slot only settles once the flex row has
  // been measured. Re-fit after that layout pass so the reported screen matches
  // the real canvas instead of the pre-layout box.
  useEffect(() => {
    if (!ready) return
    const frame = requestAnimationFrame(fit)
    return () => cancelAnimationFrame(frame)
  }, [ready])

  useEffect(() => {
    const spine = spineRef.current
    if (!spine) return
    playingRef.current = playing
    spine.state.timeScale = playing ? 1 : 0
  }, [playing, ready])

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (pinch.down(event)) return
    if (event.button !== 0) return
    event.preventDefault()
    pointerRef.current = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      panX: panRef.current.x,
      panY: panRef.current.y,
      dragged: false,
    }
    event.currentTarget.setPointerCapture(event.pointerId)
    event.currentTarget.classList.add('dragging')
  }

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (pinch.move(event)) return
    const pointer = pointerRef.current
    if (pointer.id !== event.pointerId) return
    const dx = event.clientX - pointer.x
    const dy = event.clientY - pointer.y
    if (Math.hypot(dx, dy) >= 3) pointer.dragged = true
    if (!pointer.dragged || !viewControl.allowedRef.current) return
    panRef.current = { x: pointer.panX + dx, y: pointer.panY + dy }
    fit()
  }

  const finishPointer = (event: ReactPointerEvent<HTMLDivElement>) => {
    pinch.up(event)
    const pointer = pointerRef.current
    if (pointer.id !== event.pointerId) return
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    event.currentTarget.classList.remove('dragging')
    pointerRef.current.id = -1
  }

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const handleWheel = (event: WheelEvent) => {
      event.preventDefault()
      if (!viewControl.allowedRef.current) return
      const next = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, viewRef.current.zoom * Math.exp(-event.deltaY * 0.0015)))
      if (next === viewRef.current.zoom) return
      viewRef.current.zoom = next
      fit()
    }
    host.addEventListener('wheel', handleWheel, { passive: false })
    return () => host.removeEventListener('wheel', handleWheel)
  }, [])

  return (
    <div
      className={`picture-figure ${viewControl.allowed ? '' : 'viewport-locked'}`}
      ref={hostRef}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={finishPointer}
      onPointerCancel={finishPointer}
      title={viewControl.allowed ? '拖拽移动 · 滚轮缩放' : '画面已锁定'}
    />
  )
}
