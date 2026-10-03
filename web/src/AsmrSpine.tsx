import { useEffect, useRef, useState } from 'react'
import { createSceneLifetime } from './sceneLifetime'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { Application, Assets, Container, Rectangle } from 'pixi.js'
import { MeshAttachment, RegionAttachment, Spine } from '@esotericsoftware/spine-pixi-v7'
import type { ModelAsset } from './types'
import { suppressOversizedCameraMatte } from './spineCameraMatte'
import { gameFrameTransform } from './gameFrame'
import { useViewAdjustment, useViewReset, usePinchZoom } from './ImmersiveMode'
import { spineAssetPath } from './sitePaths'
import { useDeveloperMode } from './DeveloperMode'
import { createDeveloperScene } from './developerScene'

/**
 * Renders the 立绘 an ASMR album plays against.
 *
 * The models carry exactly two animations: a short `idle` loop and a `camera`
 * timeline whose length matches the album's audio (measured: 1001 1155.8 s vs
 * 1157.0 s, 1004 1710.5 vs 1708.9, the rest within 0.1 s).  So the game's
 * presentation is two tracks — the loop on track 0, the album-length 運鏡 on track 1
 * — which is what this reproduces.
 *
 * Framing is computed from the **idle pose only** and then held fixed.  The `camera`
 * animation keys scale and rotation on the container bones (`all`, `in`, `camera`),
 * so framing from any union of poses over that timeline shrinks the artwork — the
 * same defect S0.5 measured at 2.30% coverage on the gallery models.
 */

const CAMERA_TRACK = 1
const MIN_ZOOM = 0.4
const MAX_ZOOM = 4
/** Where the camera track is considered out of step with the audio clock. */
const DRIFT_TOLERANCE = 0.35

const assetUrl = spineAssetPath

function animationNames(spine: Spine) {
  return spine.skeleton.data.animations.map((item) => item.name)
}

/** `idle`, `idle1` and `Idle_Loop` all qualify. `camera` never does. */
function idleName(names: string[]) {
  return names.find((name) => /^idle(_?\d+)?$/i.test(name))
    ?? names.find((name) => /idle/i.test(name))
    ?? names.find((name) => /stand|loop/i.test(name))
    ?? names.find((name) => !/camera/i.test(name))
    ?? ''
}

function cameraName(names: string[]) {
  return names.find((name) => /camera/i.test(name)) ?? null
}

/**
 * Which bones the `camera` timeline drives.
 *
 * This matters on the disable path.  Clearing the track only stops the state from
 * *applying* the timeline — it does not undo it, so the container bones stay frozen
 * wherever the last applied frame left them and "camera off" looks identical to
 * "camera on".  Those bones have to be put back explicitly.
 */
function cameraBoneIndices(spine: Spine, animationName: string | null) {
  const animation = animationName ? spine.skeleton.data.findAnimation(animationName) : null
  if (!animation) return []
  const indices = new Set<number>()
  for (const timeline of animation.timelines) {
    const index = (timeline as unknown as { boneIndex?: number }).boneIndex
    if (typeof index === 'number') indices.add(index)
  }
  return [...indices]
}

function resetBones(spine: Spine, indices: number[]) {
  for (const index of indices) {
    const bone = spine.skeleton.bones[index]
    // `setToSetupPose` restores x/y/rotation/scale without touching the rest of the
    // skeleton, so the idle track keeps whatever it keys on the next update.
    if (bone) bone.setToSetupPose()
  }
}

/**
 * A read-only snapshot of what the figure is actually being driven to.
 *
 * Two-track sync is a claim about *time*, and pixels cannot settle it — a pair of
 * paused frames differs whether or not the camera moved, and the idle loop means
 * even a still frame is not a fixed reference.  So the runtime publishes the
 * numbers it drives, and the acceptance check asserts on those instead.
 */
export type AsmrSpineProbe = {
  idle: string | null
  idleTime: number | null
  camera: string | null
  cameraDuration: number | null
  cameraBones: string[]
  cameraTrackTime: number | null
  cameraEnabled: boolean
  timeScale: number
  bones: Record<string, number[]>
}

type ProbeHost = { __asmrSpine?: () => AsmrSpineProbe | null }

const round3 = (value: number) => Math.round(value * 1000) / 1000

function snapshot(spine: Spine, camera: string | null, cameraEnabled: boolean): AsmrSpineProbe {
  const animation = camera ? spine.skeleton.data.findAnimation(camera) : null
  const idleEntry = spine.state.tracks[0]
  const cameraEntry = spine.state.tracks[CAMERA_TRACK]
  const bones: Record<string, number[]> = {}
  for (const index of cameraBoneIndices(spine, camera)) {
    const bone = spine.skeleton.bones[index]
    if (!bone) continue
    bones[bone.data.name] = [
      round3(bone.x), round3(bone.y), round3(bone.rotation), round3(bone.scaleX), round3(bone.scaleY),
    ]
  }
  return {
    idle: idleEntry?.animation?.name ?? null,
    idleTime: idleEntry?.animation ? round3(idleEntry.trackTime) : null,
    camera,
    cameraDuration: animation ? round3(animation.duration) : null,
    cameraBones: Object.keys(bones),
    cameraTrackTime: cameraEntry?.animation ? round3(cameraEntry.trackTime) : null,
    cameraEnabled,
    timeScale: round3(spine.state.timeScale),
    bones,
  }
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

type Props = {
  asset: ModelAsset
  /** Run the album-length `camera` timeline on track 1, locked to the audio clock. */
  cameraEnabled: boolean
  /** The audio element's `currentTime`, in seconds. */
  currentTime: number
  playing: boolean
  playbackRate?: number
  viewCommand?: { serial: number; action: 'in' | 'out' | 'reset' }
  onStatus: (status: string) => void
  onError: (message: string) => void
}

export default function AsmrSpine({
  asset,
  cameraEnabled,
  currentTime,
  playing,
  playbackRate = 1,
  viewCommand,
  onStatus,
  onError,
}: Props) {
  const { getOverrides, registerScene } = useDeveloperMode()
  const viewControl = useViewAdjustment()
  const pinch = usePinchZoom(ratio => { viewRef.current.zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, viewRef.current.zoom * ratio)); fit() })
  useViewReset(() => { panRef.current = { x: 0, y: 0 }; viewRef.current.zoom = 1; fit() })
  const hostRef = useRef<HTMLDivElement>(null)
  const appRef = useRef<Application | null>(null)
  const groupRef = useRef<Container | null>(null)
  const spineRef = useRef<Spine | null>(null)
  const boundsRef = useRef<Rectangle | null>(null)
  const prefabSpaceRef = useRef<{ scale: number; offsetX: number; offsetY: number } | null>(null)
  const cameraRef = useRef<string | null>(null)
  const cameraOnRef = useRef(false)
  const playingRef = useRef(playing)
  const playbackRateRef = useRef(playbackRate)
  playingRef.current = playing
  playbackRateRef.current = playbackRate
  const viewRef = useRef({ zoom: 1 })
  const pointerRef = useRef({ id: -1, x: 0, y: 0, panX: 0, panY: 0, dragged: false })
  const panRef = useRef({ x: 0, y: 0 })
  /**
   * Bumped when a model finishes loading.
   *
   * The two track effects key off it because they cannot otherwise know when to
   * apply: the model arrives asynchronously, so at mount the refs are still empty
   * and the effects bail.  Without this, a freshly opened album sits on the idle
   * loop with no 運鏡 until the listener seeks or toggles something.
   */
  const [ready, setReady] = useState(0)

  const fit = () => {
    const app = appRef.current
    const group = groupRef.current
    const bounds = boundsRef.current
    if (!app || !group) return
    const prefab = prefabSpaceRef.current
    if (prefab?.scale) {
      const frame = gameFrameTransform(
        app.screen.width, app.screen.height, prefab,
        [0, 0, 1], viewRef.current.zoom, panRef.current,
      )
      group.scale.set(frame.scaleX, frame.scaleY)
      group.position.set(frame.x, frame.y)
      return
    }
    if (!bounds?.width || !bounds.height) return
    const scale = Math.min((app.screen.width * 0.9) / bounds.width, (app.screen.height * 0.94) / bounds.height)
      * viewRef.current.zoom
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
    const developerScene = createDeveloperScene(app, `asmr:${asset.id}`, `ASMR · ${asset.sourceName}`, { getOverrides, registerScene })
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
        developerScene.addSpine(spine, asset.id, asset.sourceName, 'main')
        if (!prefabSpaceRef.current) {
          spine.update(0)
          suppressOversizedCameraMatte(spine)
        }
        const names = animationNames(spine)
        const idle = idleName(names)
        if (!idle) {
          spine.destroy({ children: true, texture: false, baseTexture: false })
          onError('该立绘没有可循环的 idle 动作')
          return
        }
        // Frame on the idle pose before the camera track exists, so the measured
        // bounds cannot include the 運鏡's scale keys.
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
        cameraRef.current = cameraName(names)
        panRef.current = { x: 0, y: 0 }
        viewRef.current = { zoom: 1 }
        // The ticker drives both tracks from here on, so the clock has to agree with
        // the transport before the first frame is drawn — mounting mid-playback is a
        // real path (the listener can re-show the figure while the album runs).
        spine.state.timeScale = playingRef.current ? playbackRateRef.current : 0
        fit()
        onStatus(`${asset.spineVersion} · idle=${idle} · camera=${cameraRef.current ?? '无'}`)
        ;(window as unknown as ProbeHost).__asmrSpine = () =>
          spineRef.current ? snapshot(spineRef.current, cameraRef.current, cameraOnRef.current) : null
        setReady((count) => count + 1)
        developerScene.publish()
      } catch (error) {
        if (!disposed) onError(error instanceof Error ? error.message : String(error))
      }
    }

    const resizeObserver = new ResizeObserver(() => { app.resize(); fit() })
    resizeObserver.observe(host)
    void load()
    return () => {
      disposed = true
      developerScene.dispose()
      resizeObserver.disconnect()
      delete (window as unknown as ProbeHost).__asmrSpine
      spineRef.current = null
      groupRef.current = null
      boundsRef.current = null
      prefabSpaceRef.current = null
      cameraRef.current = null
      appRef.current = null
      app.destroy(true, { children: true, texture: false, baseTexture: false })
      lifetime.dispose()
    }
  }, [asset, onError, onStatus])

  useEffect(() => {
    const spine = spineRef.current
    if (!spine) return
    const camera = cameraRef.current
    cameraOnRef.current = Boolean(cameraEnabled && camera)
    if (!cameraEnabled || !camera) {
      if (spine.state.tracks[CAMERA_TRACK]) spine.state.clearTrack(CAMERA_TRACK)
      resetBones(spine, cameraBoneIndices(spine, camera))
      spine.update(0)
      return
    }
    const current = spine.state.tracks[CAMERA_TRACK]
    if (current?.animation?.name === camera) return
    const entry = spine.state.setAnimation(CAMERA_TRACK, camera, false)
    entry.trackTime = Math.max(0, currentTime)
    spine.update(0)
  }, [cameraEnabled, currentTime, ready])

  useEffect(() => {
    const spine = spineRef.current
    if (!spine) return
    playingRef.current = playing
    spine.state.timeScale = playing ? playbackRate : 0
  }, [playing, playbackRate, ready])

  useEffect(() => {
    if (!viewCommand) return
    if (viewCommand.action === 'reset') {
      viewRef.current.zoom = 1
      panRef.current = { x: 0, y: 0 }
    } else {
      viewRef.current.zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM,
        viewRef.current.zoom * (viewCommand.action === 'in' ? 1.1 : 1 / 1.1)))
    }
    fit()
  }, [viewCommand])

  useEffect(() => {
    const spine = spineRef.current
    if (!spine) return
    const entry = spine.state.tracks[CAMERA_TRACK]
    if (!entry?.animation) return
    // Playback advances the track on Pixi's ticker, not the audio clock, so correct
    // the drift rather than fighting it every frame.  A seek shows up as a large gap.
    if (Math.abs(entry.trackTime - currentTime) <= DRIFT_TOLERANCE) return
    entry.trackTime = Math.max(0, currentTime)
    spine.update(0)
  }, [currentTime, ready])

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (pinch.down(event)) return
    if (event.button !== 0 || pointerRef.current.id >= 0) return
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
      className={`asmr-spine ${viewControl.allowed ? '' : 'viewport-locked'}`}
      ref={hostRef}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={finishPointer}
      onPointerCancel={finishPointer}
      onLostPointerCapture={finishPointer}
      title={viewControl.allowed ? '拖拽移动 · 滚轮缩放' : '画面已锁定'}
    />
  )
}
