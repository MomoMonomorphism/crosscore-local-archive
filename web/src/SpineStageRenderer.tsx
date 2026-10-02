import { useEffect, useRef } from 'react'
import { createSceneLifetime } from './sceneLifetime'
import { hallTransitionFrame, hallTransitionVisual } from './hallEntrance'
import { applyStagePlayback } from './stagePlayback'
import { createParticleSlotFilter } from './spineParticleVisibility'
import { preserveCollapsedBoneTransforms } from './spineCollapsedBones'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { Application, Assets, Container, Graphics, Point, Rectangle, Text, Sprite, Matrix, Renderer, BLEND_MODES } from 'pixi.js'
import { MeshAttachment, RegionAttachment, Spine } from '@esotericsoftware/spine-pixi-v7'
import type { ModelAsset, Variant } from './types'
import { hitTestConfig, rectCornersPixi, rectContains } from './hotspotGeometry'
import { suppressOversizedCameraMatte } from './spineCameraMatte'
import { gameFrameTransform, type PrefabSpace } from './gameFrame'
import type { InteractionEffect, InteractionEvent, InteractionRow, InteractionState } from './interactionMachine'
import { interactionGuides } from './interactionGuidance'
import { isCurrentHotspot } from './interactionDiagnostics'
import { createActionStop, resetActionStop, updateActionStop, type ActionStop } from './actionStops'
import { gestureProgress, gestureRecovery, updateGestureRecovery } from './gestureMotion'
import { objectDropAnimation, advanceObjectDrag, objectWorldScale } from './objectDrag'
import { advanceEntryFade } from './entryFade'
import { sampleUiCamera, type UiClip } from './uiClip'
import { selectAnimation } from './previewLayers'
import { loadNativeSpineSettings, applyNativeSpineSettings, type NativeSpineSettings } from './nativeSpineSettings'
import { useViewAdjustment, useViewReset, usePinchZoom } from './ImmersiveMode'
import { traceStageFrame } from './stageFrameTrace'
import { spineAssetPath } from './sitePaths'
import { loadSpineAssets, spineAliases } from './spineAssets'

export type SpineMetadata = {
  spineVersion: string
  animations: string[]
  overlayAnimations: string[]
  stateAnimations: string[]
  layers: Array<{ id: string; kind: 'back' | 'main' | 'front'; label: string }>
  loadedEffects: number
  totalEffects: number
}

export type SpineAuditMeasurement = {
  visibleBounds: { x: number; y: number; width: number; height: number } | null
  mainVisibleBounds: { x: number; y: number; width: number; height: number } | null
  declaredBounds: { x: number; y: number; width: number; height: number }
  localBounds: { x: number; y: number; width: number; height: number }
  screenAlphaBounds: { x: number; y: number; width: number; height: number } | null
  alphaPixelRatio: number
  alphaBoundsRatio: number
  /** Null means the setup frame was measurable; otherwise the audit sampled this
   * fraction of the default animation to handle intentionally transparent helpers. */
  sampledAnimationTime: number | null
  sampledAnimationName: string | null
  animationCount: number
  loadedEffects: number
  totalEffects: number
  failedEffects: string[]
}

type Props = {
  asset: ModelAsset
  effects: Variant['effects']
  animation: string | null
  playing: boolean
  speed: number
  effectsVisible: boolean
  flipped: boolean
  zoom: number
  pan: { x: number; y: number }
  persistentStates: string[]
  hiddenLayerIds: string[]
  previewHiddenSlots?: readonly string[]
  onZoomChange: (zoom: number) => void
  onPanChange: (pan: { x: number; y: number }) => void
  onMetadata: (metadata: SpineMetadata) => void
  onRuntimeReady?: (assetId: string, idle: string | null, animations: string[]) => Array<{ serial: number; effect: InteractionEffect }>
  onStatus: (status: string) => void
  onError: (message: string) => void
  onActivate?: () => void
  interaction?: { rows: InteractionRow[]; state: InteractionState; debug: boolean; showAll?: boolean; focusIndex?: number | null; space?: PrefabSpace | null; l2dPos?: [number, number, number] | null } | null
  interactionCommands?: Array<{ serial: number; effect: InteractionEffect }>
  previewResetSerial?: number
  loopAnimation?: boolean
  probeKey?: '__interactionStage' | '__rawPreviewStage' | '__auxiliaryPreviewStage'
  onInteractionEvent?: (event: InteractionEvent) => void
  onAudit?: (measurement: SpineAuditMeasurement) => void
  showGuides?: boolean
}

type Layer = {
  kind: 'back' | 'main' | 'front'
  asset: ModelAsset
  spine: Spine
}

type SpineTrackEntry = NonNullable<ReturnType<Spine['state']['getCurrent']>>

const OVERLAY_TRACK = 1
const OVERLAY_BONE_COVERAGE = 0.35
const MIN_ZOOM = 0.25
const MAX_ZOOM = 4

const assetUrl = spineAssetPath

function animationNames(spine: Spine) {
  return spine.skeleton.data.animations.map((item) => item.name)
}

function idleName(spine: Spine) {
  return selectAnimation(animationNames(spine), null, true).animation
}

function boneCoverage(spine: Spine, name: string) {
  const animation = spine.skeleton.data.findAnimation(name)
  if (!animation) return 1
  const indexes = new Set<number>()
  for (const timeline of animation.timelines) {
    if ('boneIndex' in timeline && typeof timeline.boneIndex === 'number') indexes.add(timeline.boneIndex)
  }
  return indexes.size
}

function isOverlay(spine: Spine, name: string) {
  const idle = idleName(spine)
  if (!idle || name === idle) return false
  const idleBones = boneCoverage(spine, idle)
  if (idleBones < 10) return false
  return boneCoverage(spine, name) / idleBones < OVERLAY_BONE_COVERAGE
}

function isStateAnimation(spine: Spine, name: string) {
  const animation = spine.skeleton.data.findAnimation(name)
  if (!animation || animation.duration <= 0) return false
  let changesVisualState = false
  for (const timeline of animation.timelines) {
    if ('boneIndex' in timeline
      || 'ikConstraintIndex' in timeline
      || 'transformConstraintIndex' in timeline
      || 'pathConstraintIndex' in timeline
      || 'physicsConstraintIndex' in timeline) return false
    if ('slotIndex' in timeline || /Attachment|DrawOrder|RGBA|RGB|Alpha|Sequence|Deform/.test(timeline.constructor.name)) {
      changesVisualState = true
    }
  }
  return changesVisualState
}

function applyPersistentStates(spine: Spine, states: string[]) {
  let track = 2
  for (const name of states) {
    const animation = spine.skeleton.data.findAnimation(name)
    if (!animation) continue
    const entry = spine.state.setAnimation(track, name, false)
    entry.trackTime = animation.duration
    entry.trackEnd = Number.MAX_VALUE
    track += 1
  }
  spine.update(0)
}

function applyAnimation(spine: Spine, requested: string | null, loopAnimation = true) {
  const { animation: next, loop } = selectAnimation(animationNames(spine), requested, loopAnimation)
  spine.state.clearTracks()
  spine.skeleton.setToSetupPose()
  if (!next) return
  if (isOverlay(spine, next)) {
    const idle = idleName(spine)
    if (idle) spine.state.setAnimation(0, idle, true)
    spine.state.setAnimation(OVERLAY_TRACK, next, loop)
  } else {
    spine.state.setAnimation(0, next, loop)
  }
  spine.update(0)
}

function visibleSpineBounds(spine: Spine) {
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY

  for (const slot of spine.skeleton.drawOrder) {
    if (!slot.bone.active) continue
    const attachment = slot.getAttachment()
    if (!(attachment instanceof RegionAttachment) && !(attachment instanceof MeshAttachment)) continue
    const alpha = spine.skeleton.color.a * slot.color.a * attachment.color.a
    if (alpha <= 0.001) continue

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

function visibleLayerBounds(layers: Layer[], fallback: Container) {
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  for (const layer of layers) {
    if (!layer.spine.visible) continue
    const bounds = visibleSpineBounds(layer.spine)
    if (!bounds) continue
    minX = Math.min(minX, bounds.x)
    minY = Math.min(minY, bounds.y)
    maxX = Math.max(maxX, bounds.x + bounds.width)
    maxY = Math.max(maxY, bounds.y + bounds.height)
  }
  return Number.isFinite(minX)
    ? new Rectangle(minX, minY, maxX - minX, maxY - minY)
    : fallback.getLocalBounds()
}

export default function SpineStage({
  asset,
  effects,
  animation,
  playing,
  speed,
  effectsVisible,
  flipped,
  zoom,
  pan,
  persistentStates,
  hiddenLayerIds,
  previewHiddenSlots,
  onZoomChange,
  onPanChange,
  onMetadata,
  onRuntimeReady,
  onStatus,
  onError,
  onActivate,
  interaction,
  interactionCommands = [],
  previewResetSerial = 0,
  loopAnimation = true,
  probeKey = '__interactionStage',
  showGuides = true,
  onInteractionEvent,
  onAudit,
}: Props) {
  const viewControl = useViewAdjustment()
  const hostRef = useRef<HTMLDivElement>(null)
  const appRef = useRef<Application | null>(null)
  const groupRef = useRef<Container | null>(null)
  const layersRef = useRef<Layer[]>([])
  const boundsRef = useRef<Rectangle | null>(null)
  const debugRef = useRef<Graphics | null>(null)
  const interactionRef = useRef(interaction)
  const interactionTracksRef = useRef(new Set<number>())
  const trackSerialsRef = useRef(new Map<number, number>())
  const entrySerialsRef = useRef(new WeakMap<SpineTrackEntry, number>())
  const missingTrackFramesRef = useRef(new Map<number, number>())
  const lastPreviewResetSerialRef = useRef(previewResetSerial)
  const fadeInEntriesRef = useRef(new Map<number, SpineTrackEntry>())
  const actionStopsRef = useRef(new Map<number, { entry: SpineTrackEntry; stop: ActionStop }>())
  const gesturePointsRef = useRef(new Map<number, { x: number; y: number }>())
  const dragObjectsRef = useRef(new Map<string, Container>())
  const dragNestedRef = useRef(new Map<string, Spine>())
  const poseDirtyRef = useRef(false)
  const playbackRef = useRef(playing)
  playbackRef.current = playing
  const loadedControlsRef = useRef({ playing, speed, effectsVisible, hiddenLayerIds })
  loadedControlsRef.current = { playing, speed, effectsVisible, hiddenLayerIds }
  const previewSelectionRef = useRef({ animation, loopAnimation, persistentStates })
  previewSelectionRef.current = { animation, loopAnimation, persistentStates }
  const uiCameraRef = useRef<{ clip: UiClip; elapsed: number } | null>(null)
  const dragOverlayRef = useRef<Array<{ object: Container; sprite: Sprite; elapsed: number; wasVisible: boolean;
    fade?: { delay: number; duration: number; from: number; to: number } | null }>>([])
  const objectPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const objectMovesRef = useRef(new Map<number, { count: number; nested: boolean }>())
  const gestureRecoveriesRef = useRef(new Map<number, { entry: SpineTrackEntry; remaining: number; forward: boolean }>())
  const mainCompletionRef = useRef<{ remainingMs: number; playSerial: number } | null>(null)
  const multiStopsRef = useRef(new Map<number, { target: number; direction: number; complete?: boolean; clickTime?: number; rowIndex?: number; timeoutReset?: boolean }>())
  const multiTimeoutsRef = useRef(new Map<number, { entry: SpineTrackEntry; remaining: number; rowIndex: number }>())
  const commandSerialRef = useRef(0)
  const applyCommandsRef = useRef<(commands: Array<{ serial: number; effect: InteractionEffect }>) => void>(() => undefined)
  const runtimeReadyRef = useRef(onRuntimeReady)
  runtimeReadyRef.current = onRuntimeReady
  const diagnosticRef = useRef('')
  const viewRef = useRef({ zoom, flipped, pan })
  const callbacksRef = useRef({ onActivate, onZoomChange, onPanChange, onInteractionEvent, onStatus })
  const pointerRef = useRef({
    id: -1, x: 0, y: 0, panX: 0, panY: 0, dragged: false, nativeDragging: false,
    hotspot: null as InteractionRow | null,
    configX: 0,
    configY: 0,
  })
  const pinch = usePinchZoom(ratio => {
    const next = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, viewRef.current.zoom * ratio))
    viewRef.current.zoom = next
    callbacksRef.current.onZoomChange(next)
    fit()
  }, () => !pointerRef.current.hotspot?.gesture && !interactionRef.current?.state.hallEntry)

  const eventConfigPoint = (clientX: number, clientY: number) => {
    const app = appRef.current
    const group = groupRef.current
    if (!app || !group) return null
    const rect = (app.view as HTMLCanvasElement).getBoundingClientRect()
    if (!rect.width || !rect.height) return null
    const global = new Point(
      (clientX - rect.left) * app.screen.width / rect.width,
      (clientY - rect.top) * app.screen.height / rect.height,
    )
    // Touch rects live in skeleton units and the pixi container uses the same
    // axes (spine-pixi yDown), so the group-local point IS the config point.
    const local = group.toLocal(global)
    return { x: local.x, y: local.y }
  }

  const hitInteraction = (clientX: number, clientY: number) => {
    const current = interactionRef.current
    const point = eventConfigPoint(clientX, clientY)
    if (!current || !point) return null
    const hit = hitTestConfig(current.rows.map((row) => ({
      index: row.index,
      rect: row.rects[0],
      active: current.state.active[String(row.index)],
    })), point)
    const winner = hit ? current.rows.find((row) => row.index === hit.index) ?? null : null
    // Decision trace (C8): explain the resolution for the status line so a
    // human click always has a machine-checked explanation.
    const containing = current.rows.filter((row) => row.rects[0]
      && rectContains(row.rects[0], point)
      && row.pose === current.state.role)
    const parts: string[] = []
    if (winner) {
      parts.push(winner.content.asmr
        ? `命中 #${winner.index} → ASMR 专辑 ${winner.content.asmr.id}`
        : `命中 #${winner.index}${winner.anim ? ` → ${winner.anim}` : '（无动画）'}（轨道 ${winner.track}）`)
    } else {
      parts.push('未命中活动触点')
    }
    const shadowed = containing
      .filter((row) => !winner || row.index !== winner.index)
      .map((row) => `#${row.index}${current.state.active[String(row.index)] ? '' : '(隐藏)'}`)
    if (shadowed.length) parts.push(`同点包含 ${shadowed.join('、')}${winner ? '，按后加入优先被覆盖' : ''}`)
    const guide = winner && interactionGuides(current.rows, current.state, performance.now())
      .find((chain) => chain.path?.some((row) => row.index === winner.index))
    if (guide?.path) parts.push(
      `通往 ${guide.target.anim || `#${guide.target.index}`}：${guide.path.map((row) => `#${row.index}`).join(' → ')} → 自动 #${guide.target.index}`,
    )
    callbacksRef.current.onStatus?.(`交互判定：${parts.join('；')}`)
    return winner && current.state.restoreObjects[String(winner.index)] ? { ...winner, gesture: 0 } : winner
  }

  // Labels use CSS-pixel font sizes. Keep their positions in skeleton space,
  // but cancel the view scale (including its flip) on the text itself.
  const fitDebugLabels = () => {
    const graphics = debugRef.current
    const group = groupRef.current
    if (!graphics || !group || Math.abs(group.scale.x) < 1e-8 || Math.abs(group.scale.y) < 1e-8) return
    for (const child of graphics.children) {
      if (child instanceof Text) child.scale.set(1 / group.scale.x, 1 / group.scale.y)
    }
  }

  const redrawDebug = () => {
    const graphics = debugRef.current
    const current = interactionRef.current
    if (!graphics) return
    graphics.clear()
    for (const child of graphics.removeChildren()) child.destroy()
    if (!current || (!current.debug && current.focusIndex == null)) return
    for (const row of current.rows) {
      if (!isCurrentHotspot(row, current.state.role)) continue
      const active = current.state.active[String(row.index)]
      const focused = active && current.focusIndex === row.index
      if (!focused && (!current.debug || (!current.showAll && !active))) continue
      const corners = rectCornersPixi(row.rects[0])
      // ASMR hotspots navigate rather than play an animation. Mark them
      // separately so a jump is not mistaken for a missing click action.
      const color = focused ? 0xffad32 : active ? row.content.asmr ? 0xc793ff : 0x55e6ff : 0xff6b81
      graphics.lineStyle(focused ? 4 : 2.5, color, active ? 0.95 : 0.16)
      graphics.beginFill(color, focused ? 0.28 : active ? 0.12 : 0)
      graphics.drawPolygon(corners.flatMap((point) => [point.x, point.y]))
      graphics.endFill()
      const [centerX, centerY] = row.rects[0]
      const label = new Text(`#${row.index}${row.content.asmr ? ' ASMR' : ''}`, {
        fontFamily: 'monospace', fontSize: 16, fill: active ? color : 0xff9ba6,
      })
      label.resolution = appRef.current?.renderer.resolution ?? 1
      label.anchor.set(0.5)
      label.position.set(centerX, centerY)
      graphics.addChild(label)
      if (current.state.dragging === row.index && row.dragHost) {
        for (const target of row.dragHost.targets) {
          const release = target
          graphics.lineStyle(3,0xffcc66,1)
          const radius = 10/objectWorldScale(row.dragHost,current.l2dPos?.[2] ?? 1)
          graphics.drawCircle(release.x,release.y,radius)
          const hint = new Text(`鼠标松手 → ${target.animation}`, { fontFamily:'monospace',fontSize:14,fill:0xffcc66 })
          hint.resolution = appRef.current?.renderer.resolution ?? 1
          hint.anchor.set(0.5,1)
          hint.position.set(release.x,release.y-radius)
          graphics.addChild(hint)
        }
      }
    }
    fitDebugLabels()
  }

  const fit = () => {
    const app = appRef.current
    const group = groupRef.current
    const bounds = boundsRef.current
    if (!app || !group) return
    const gameSpace = interactionRef.current?.space
    const entranceScale = hallTransitionVisual(interactionRef.current?.state.hallEntry).scale
    if (gameSpace?.scale) {
      const frame = gameFrameTransform(
        app.screen.width, app.screen.height, { ...gameSpace,
          ...(uiCameraRef.current ? sampleUiCamera(uiCameraRef.current.clip, uiCameraRef.current.elapsed) : {}) },
        interactionRef.current?.l2dPos ?? [0, 0, 1],
        interactionRef.current?.state.spineUi.open ? 1 : viewRef.current.zoom,
        interactionRef.current?.state.spineUi.open ? { x: 0, y: 0 } : viewRef.current.pan, viewRef.current.flipped,
      )
      group.scale.set(frame.scaleX * entranceScale, frame.scaleY * entranceScale)
      group.position.set(app.screen.width / 2 + (frame.x - app.screen.width / 2) * entranceScale,
        app.screen.height / 2 + (frame.y - app.screen.height / 2) * entranceScale)
      traceStageFrame(hostRef.current, asset.id, { mode: 'game', viewport: { width: app.screen.width, height: app.screen.height },
        view: viewRef.current, space: gameSpace, l2dPos: interactionRef.current?.l2dPos, ...frame })
      fitDebugLabels()
      return
    }
    if (!bounds?.width || !bounds.height) return
    const scale = Math.min((app.screen.width * 0.82) / bounds.width, (app.screen.height * 0.84) / bounds.height)
      * viewRef.current.zoom * entranceScale
    const scaleX = viewRef.current.flipped ? -scale : scale
    group.scale.set(scaleX, scale)
    group.position.set(
      app.screen.width / 2 - (bounds.x + bounds.width / 2) * scaleX + viewRef.current.pan.x,
      app.screen.height / 2 - (bounds.y + bounds.height / 2) * scale + viewRef.current.pan.y,
    )
    traceStageFrame(hostRef.current, asset.id, { mode: 'bounds', viewport: { width: app.screen.width, height: app.screen.height },
      view: viewRef.current, scaleX, scaleY: scale, x: group.x, y: group.y })
    fitDebugLabels()
  }

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (pinch.down(event)) { pointerRef.current.dragged = true; return }
    if (event.button !== 0 || pointerRef.current.id >= 0) return
    if (interactionRef.current?.state.hallEntry) {
      callbacksRef.current.onInteractionEvent?.({ type: 'hall-exit' })
      return
    }
    event.preventDefault()
    const configPoint = eventConfigPoint(event.clientX, event.clientY)
    if (interactionRef.current?.debug) {
      // DOM-readable evidence for pointer / screenshot coordinate diagnostics.
      event.currentTarget.dataset.lastInteractionPointer = JSON.stringify({
        client: [event.clientX, event.clientY], config: configPoint,
        canvas: (appRef.current?.view as HTMLCanvasElement | undefined)?.getBoundingClientRect().toJSON(),
      })
    }
    pointerRef.current = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      panX: viewRef.current.pan.x,
      panY: viewRef.current.pan.y,
      dragged: false,
      nativeDragging: false,
      hotspot: hitInteraction(event.clientX, event.clientY),
      configX: configPoint?.x ?? 0,
      configY: configPoint?.y ?? 0,
    }
    const hotspot = pointerRef.current.hotspot
    if (objectPressTimerRef.current) clearTimeout(objectPressTimerRef.current)
    // CardTouchItem.OnPressDown checks IsIdle before arming the timer.
    // Otherwise a press made while busy can fire later when the track ends.
    if (hotspot?.gesture === 6 && hotspot.content.drag && !interactionRef.current?.state.tracks['1']) {
      objectPressTimerRef.current = setTimeout(() => {
        if (pointerRef.current.id !== event.pointerId || pointerRef.current.dragged) return
        pointerRef.current.dragged = true
        callbacksRef.current.onInteractionEvent?.({ type: 'drag-begin', random: Math.random(), index: hotspot.index,
          nowMs: performance.now(), longPress: true, x: configPoint?.x, y: configPoint?.y })
      }, 300)
    }
    if (hotspot?.gesture && !hotspot.content.drag) callbacksRef.current.onInteractionEvent?.({
      type: 'drag-begin', random: Math.random(), index: hotspot.index, nowMs: performance.now(),
      x: configPoint?.x, y: configPoint?.y,
    })
    event.currentTarget.setPointerCapture(event.pointerId)
    event.currentTarget.classList.add('dragging')
  }

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (pinch.move(event)) return
    const pointer = pointerRef.current
    if (pointer.id !== event.pointerId) return
    const dx = event.clientX - pointer.x
    const dy = event.clientY - pointer.y
    if (!pointer.nativeDragging && Math.hypot(dx, dy) >= 3) {
      if (objectPressTimerRef.current) clearTimeout(objectPressTimerRef.current)
      const alreadyBegun = pointer.dragged
      pointer.nativeDragging = true
      pointer.dragged = true
      if (!alreadyBegun && pointer.hotspot?.gesture && pointer.hotspot.content.drag) callbacksRef.current.onInteractionEvent?.({
        type: 'drag-begin', random: Math.random(), index: pointer.hotspot.index, nowMs: performance.now(),
        x: pointer.configX, y: pointer.configY,
      })
    }
    if (!pointer.nativeDragging) return
    if (pointer.hotspot?.gesture) {
      const point = eventConfigPoint(event.clientX, event.clientY)
      if (point) callbacksRef.current.onInteractionEvent?.({ type: 'drag-move', ...point })
    } else if (viewControl.allowedRef.current) {
      callbacksRef.current.onPanChange({ x: pointer.panX + dx, y: pointer.panY + dy })
    }
  }

  const finishPointer = (event: ReactPointerEvent<HTMLDivElement>, activate: boolean) => {
    if (pinch.up(event)) activate = false
    if (objectPressTimerRef.current) clearTimeout(objectPressTimerRef.current)
    const pointer = pointerRef.current
    if (pointer.id !== event.pointerId) return
    pointerRef.current.id = -1
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    event.currentTarget.classList.remove('dragging')
    if (pointer.hotspot?.gesture && (!pointer.hotspot.content.drag || pointer.dragged)) {
      const point = eventConfigPoint(event.clientX, event.clientY) ?? { x: pointer.configX, y: pointer.configY }
      callbacksRef.current.onInteractionEvent?.({ type: 'drag-end', ...point, cancelled: !activate })
    } else if (activate && !pointer.dragged && pointer.hotspot) {
      callbacksRef.current.onInteractionEvent?.({
        type: 'press', index: pointer.hotspot.index, nowMs: performance.now(), random: Math.random(),
      })
    } else if (activate && !pointer.dragged && !interactionRef.current) {
      callbacksRef.current.onActivate?.()
    }
  }

  useEffect(() => {
    const cancel = () => {
      if (objectPressTimerRef.current) clearTimeout(objectPressTimerRef.current)
      const pointer = pointerRef.current
      if (pointer.id < 0) return
      pointer.id = -1
      callbacksRef.current.onInteractionEvent?.({ type: 'drag-end', x: 0, y: 0, cancelled: true })
    }
    const visibility = () => { if (document.hidden) cancel() }
    window.addEventListener('blur', cancel)
    document.addEventListener('visibilitychange', visibility)
    return () => {
      window.removeEventListener('blur', cancel)
      document.removeEventListener('visibilitychange', visibility)
    }
  }, [])

  useEffect(() => {
    let disposed = false
    const loadStarted = performance.now()
    const loadTiming: { readyMs?: number; firstRenderMs?: number; layers?: Array<{ id: string; kind: string }>; models: Array<{ id: string; resourcesMs: number; createMs: number }> } = { models: [] }
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
    // Additive slots brighten the scene without making a transparent canvas opaque.
    // Pixi's default ADD accumulates alpha as well, exposing black texture quads
    // when the native UI background is rendered beneath this canvas in the DOM.
    if (app.renderer instanceof Renderer) {
      const renderer = app.renderer
      const configureAdditive = () => {
        const gl = renderer.gl
        const modes = (renderer.state as unknown as { blendModes: number[][] }).blendModes
        modes[BLEND_MODES.ADD] = [gl.ONE, gl.ONE, gl.ZERO, gl.ONE]
        modes[BLEND_MODES.ADD_NPM] = [gl.SRC_ALPHA, gl.ONE, gl.ZERO, gl.ONE]
      }
      configureAdditive()
      renderer.runners.contextChange.add({ contextChange: configureAdditive })
    }
    appRef.current = app
    host.dataset.entranceHistory = 'loading'
    host.dataset.assetId = asset.id
    host.replaceChildren(app.view)

    const nativeProfiles = new WeakMap<Spine, NativeSpineSettings>()
    const loadOne = async (model: ModelAsset) => {
      const started = performance.now()
      const id = spineAliases(model)
      const useNative = Boolean(interactionRef.current) && probeKey !== '__rawPreviewStage'
      const [, profile] = await Promise.all([loadSpineAssets(model),
        useNative ? loadNativeSpineSettings(model) : Promise.resolve(null)])
      const resourcesReady = performance.now()
      const spine = lifetime.create(() => Spine.from({ skeleton: id.skeleton, atlas: id.atlas }))
      preserveCollapsedBoneTransforms(spine.skeleton)
      const filterParticles = createParticleSlotFilter(spine.skeleton.slots)
      const updateTransform = spine.updateTransform.bind(spine)
      spine.updateTransform = () => filterParticles(loadedControlsRef.current.effectsVisible, updateTransform)
      applyNativeSpineSettings(spine.state.data, profile)
      if (profile) nativeProfiles.set(spine, profile)
      if (!interactionRef.current?.space && probeKey !== '__auxiliaryPreviewStage') {
        spine.update(0)
        suppressOversizedCameraMatte(spine)
      }
      loadTiming.models.push({ id: model.id, resourcesMs: resourcesReady - started, createMs: performance.now() - resourcesReady })
      return spine
    }

    const load = async () => {
      onStatus(effects.length ? `正在组合主体与 ${effects.length} 个特效层…` : '正在从本地端提取并加载…')
      try {
        // Start independent layers and hidden interaction resources together.
        // Assemble only after they settle, preserving authored z-order and the
        // ready callback's guarantee that every interaction object exists.
        const dragHosts = new Map<string, NonNullable<InteractionRow['dragHost']>>()
        for (const row of interactionRef.current?.rows ?? []) {
          const host = row.dragHost
          if (host?.image && !host.unsupported && !dragHosts.has(host.object)) dragHosts.set(host.object, host)
        }
        const [modelResults, dragResults] = await Promise.all([
          Promise.allSettled([loadOne(asset), ...effects.map(effect => loadOne(effect.asset))]),
          Promise.allSettled([...dragHosts.values()].map(async host => {
            const [texture, nested, overlays] = await Promise.all([
              Assets.load(assetUrl(host.image!)),
              host.nested ? loadOne(host.nested.asset) : Promise.resolve(null),
              Promise.all((host.overlays ?? []).map(overlay => Assets.load(assetUrl(overlay.image)))),
            ])
            return { host, texture, nested, overlays }
          })),
        ])
        if (disposed) return
        const mainResult = modelResults[0]
        if (mainResult.status === 'rejected') throw mainResult.reason
        const main = mainResult.value
        // Explicit diagnostic preview only. Mutate this skeleton instance, never
        // shared SkeletonData or the preserved interaction renderer. Restoring
        // the preview remounts it to recover original attachments.
        if (probeKey === '__rawPreviewStage' && previewHiddenSlots?.length) {
          const slots = previewHiddenSlots.flatMap(name => {
            const slot = main.skeleton.findSlot(name)
            return slot ? [slot] : []
          })
          main.afterUpdateWorldTransforms = () => {
            for (const slot of slots) slot.setAttachment(null)
          }
          host.dataset.previewHiddenSlots = JSON.stringify(slots.map(slot => slot.data.name))
        }
        const initialFrames: object[] = []
        const captureInitialFrame = (phase: string) => {
          const entry = main.state.getCurrent(1)
          const slotIndexes = new Set<number>()
          for (const timeline of entry?.animation?.timelines ?? [])
            if ('slotIndex' in timeline && typeof timeline.slotIndex === 'number') slotIndexes.add(timeline.slotIndex)
          initialFrames.push({ phase, atMs: performance.now(), defaultMix: main.state.data.defaultMix,
            viewport: { width: app.screen.width, height: app.screen.height },
            frame: groupRef.current ? { x: groupRef.current.x, y: groupRef.current.y,
              scaleX: groupRef.current.scale.x, scaleY: groupRef.current.scale.y } : null,
            tracks: main.state.tracks.filter((track): track is NonNullable<typeof track> => track != null).map(track => ({ track: track.trackIndex,
              animation: track.animation?.name, time: track.trackTime, alpha: track.alpha,
              mixDuration: track.mixDuration, mixTime: track.mixTime,
              mixingFrom: track.mixingFrom?.animation?.name ?? null })),
            slots: [...slotIndexes].slice(0, 16).map(index => ({ name: main.skeleton.slots[index].data.name,
              alpha: main.skeleton.slots[index].color.a,
              attachment: main.skeleton.slots[index].getAttachment()?.name ?? null })),
          })
        }

        const loadedEffects: Layer[] = []
        const failedEffects: string[] = []
        for (const [index, effect] of effects.entries()) {
          const result = modelResults[index + 1]
          if (result.status === 'fulfilled') {
            loadedEffects.push({ kind: effect.layer, asset: effect.asset, spine: result.value })
          } else {
            console.warn(`[SpineStage] skipped effect ${effect.asset.id}`, result.reason)
            failedEffects.push(effect.asset.id)
          }
        }

        const layers: Layer[] = [
          ...loadedEffects.filter((item) => item.kind === 'back'),
          { kind: 'main', asset, spine: main },
          ...loadedEffects.filter((item) => item.kind === 'front'),
        ]
        loadTiming.layers = layers.map(layer => ({ id: layer.asset.id, kind: layer.kind }))
        const group = lifetime.create(() => new Container())
        group.alpha = 0
        for (const layer of layers) {
          const profile = nativeProfiles.get(layer.spine)
          if (profile && layer.spine.skeleton.data.findAnimation(profile.startingAnimation)) {
            layer.spine.state.setAnimation(0, profile.startingAnimation, profile.startingLoop)
            layer.spine.update(0)
          } else applyAnimation(layer.spine, animation, layer.kind === 'main' ? loopAnimation : true)
          applyPersistentStates(layer.spine, persistentStates)
          if (!interactionRef.current?.space && probeKey !== '__auxiliaryPreviewStage') suppressOversizedCameraMatte(layer.spine)
          layer.spine.state.timeScale = playing ? speed : 0
          layer.spine.visible = !hiddenLayerIds.includes(layer.asset.id) && (layer.kind === 'main' || effectsVisible)
          group.addChild(layer.spine)
        }
        for (const result of dragResults) {
          if (result.status === 'rejected') throw result.reason
          const { host, texture, nested, overlays } = result.value
          const sprite = lifetime.create(() => new Sprite(texture))
          sprite.width = host.width; sprite.height = host.height
          sprite.anchor.set(host.pivotX, host.pivotY)
          const object = lifetime.create(() => new Container())
          object.addChild(sprite)
          object.transform.setFromMatrix(new Matrix(host.a, host.b, host.c, host.d, host.x, host.y))
          object.visible = false
          group.addChild(object)
          dragObjectsRef.current.set(host.object, object)
          if (host.nested && nested) {
            const m = host.nested.matrix
            nested.transform.setFromMatrix(new Matrix(m[0],m[1],m[2],m[3],m[4],m[5]))
            nested.state.setAnimation(0,host.nested.idle,true)
            nested.mask = sprite
            nested.visible = false
            group.addChild(nested)
            dragNestedRef.current.set(host.object,nested)
          }
          for (const [index, overlay] of (host.overlays ?? []).entries()) {
            const overlayTexture = overlays[index]
            const frame = lifetime.create(() => new Sprite(overlayTexture))
            if (disposed) { frame.destroy();return }
            frame.width = overlay.width * overlay.scaleX;frame.height = overlay.height * overlay.scaleY
            frame.anchor.set(overlay.pivotX, overlay.pivotY);frame.position.set(overlay.x, overlay.y)
            object.addChild(frame)
            dragOverlayRef.current.push({ object, sprite: frame, elapsed: 0, wasVisible: false, fade: overlay.fade })
          }
          if (host.overlays?.length) group.setChildIndex(object, group.children.length - 1)
        }
        let sampledAnimationTime: number | null = null
        let sampledAnimationName: string | null = null
        if (onAudit && !visibleSpineBounds(main)) {
          sample: for (const candidate of main.skeleton.data.animations) {
            if (!candidate.duration) continue
            main.state.clearTracks()
            main.skeleton.setToSetupPose()
            const track = main.state.setAnimation(0, candidate.name, false)
            for (let step = 1; step < 20; step += 1) {
              const fraction = step / 20
              track.trackTime = candidate.duration * fraction
              main.update(0)
              if (visibleSpineBounds(main)) {
                sampledAnimationName = candidate.name
                sampledAnimationTime = fraction
                break sample
              }
            }
          }
        }
        layersRef.current = layers
        groupRef.current = group
        app.stage.addChild(group)
        // Keep authored entrance attachments, deforms and alpha unchanged.
        // Alps 03 fades sucai_bg over 1.4–1.7667 s to reveal the figure;
        // viewport-sized mesh replacement is not part of the original game.
        const entranceFlash = lifetime.create(() => new Graphics())
        entranceFlash.eventMode = 'none'
        app.stage.addChild(entranceFlash)
        let revealMs = runtimeReadyRef.current ? 0 : 180
        let wasTransitioning = false
        boundsRef.current = visibleLayerBounds(layers, group)
        const debug = new Graphics()
        debug.eventMode = 'none'
        group.addChild(debug)
        debugRef.current = debug
        redrawDebug()
        main.state.addListener({
          event: (entry, spineEvent) => {
            // Track 0 can play a manually selected preview animation in this
            // viewer. Only game interaction commands should drive RoleSpineItem2
            // events; a previewed guochang must not close its Spine UI.
            const playSerial = entrySerialsRef.current.get(entry)
            if (!interactionRef.current || playSerial == null
              || trackSerialsRef.current.get(entry.trackIndex) !== playSerial) return
            const name = spineEvent.data.name
            if (/^TriggerIndex_\d+$/.test(name)) {
              callbacksRef.current.onInteractionEvent?.({
                type: 'spine-event', name, animation: entry.animation?.name,
                nowMs: performance.now(), random: Math.random(),
              })
            } else if (name === 'SpineUI') {
              callbacksRef.current.onInteractionEvent?.({
                type: 'spine-event', name, animation: entry.animation?.name,
                nowMs: performance.now(),
              })
            }
          },
          complete: (entry) => {
            const playSerial = entrySerialsRef.current.get(entry)
            if (!entry.animation || playSerial == null
              || trackSerialsRef.current.get(entry.trackIndex) !== playSerial
              || !interactionTracksRef.current.has(entry.trackIndex)) return
            const multiStop = multiStopsRef.current.get(entry.trackIndex)
            interactionTracksRef.current.delete(entry.trackIndex)
            if (fadeInEntriesRef.current.get(entry.trackIndex) === entry)
              fadeInEntriesRef.current.delete(entry.trackIndex)
            multiStopsRef.current.delete(entry.trackIndex)
            multiTimeoutsRef.current.delete(entry.trackIndex)
            if (entry.trackIndex === 1) {
              callbacksRef.current.onInteractionEvent?.({ type: 'track-callback', track: 1,
                nowMs: performance.now(), playSerial })
              if (interactionRef.current?.state.hallEntry?.phase === 'in' && entry.animation.name === 'in') {
                callbacksRef.current.onInteractionEvent?.({ type: 'track-complete', track: 1,
                  nowMs: performance.now(), playSerial })
                return
              }
              // SpineTools queues AddEmptyAnimation when the click starts.
              // RoleSpineItem2.GetClickCB checks IsIdle here. The queued
              // empty entry keeps it false, so nextClick waits 501 ms before
              // TouchItemClickCB. Keep the reducer's track occupied until
              // that callback window rather than advancing the chain now.
              mainCompletionRef.current = { remainingMs: 501, playSerial }
            } else if (multiStop?.complete) {
              // SpineTools.Update clears a multi-click track at its last
              // configured stop and invokes clickTimeCB to reset its record.
              main.state.clearTrack(entry.trackIndex)
              trackSerialsRef.current.delete(entry.trackIndex)
              main.skeleton.setToSetupPose()
              poseDirtyRef.current = true
              callbacksRef.current.onInteractionEvent?.({
                type: 'track-complete', track: entry.trackIndex,
                nowMs: performance.now(), random: Math.random(), playSerial,
              })
            } else {
              // Object tracks retain their finished entry and last frame; Lua
              // conditions and multi-click progress can still inspect them.
              entry.timeScale = 0
              callbacksRef.current.onInteractionEvent?.({
                type: 'track-progress', track: entry.trackIndex,
                animation: entry.animation.name, progress: 1, playing: false, playSerial,
              })
            }
          },
        })
        app.ticker.add(() => {
          revealMs = Math.min(180, revealMs + app.ticker.deltaMS)
          group.alpha = revealMs / 180
          const hall = interactionRef.current?.state.hallEntry
          const phase = hall?.phase ?? (main.state.getCurrent(1)?.animation?.name === 'in' ? 'in' : 'idle')
          if (host.dataset.entrancePhase !== phase) {
            host.dataset.entrancePhase = phase
            host.dataset.entranceHistory = `${host.dataset.entranceHistory},${phase}`.split(',').slice(-12).join(',')
          }
          host.dataset.mainAnimation = main.state.getCurrent(0)?.animation?.name ?? ''
          host.dataset.overlayAnimation = main.state.getCurrent(1)?.animation?.name ?? ''
          const transitionFrame = hallTransitionFrame(hall, app.ticker.deltaMS,
            playbackRef.current, main.state.timeScale)
          const white = transitionFrame.white
          entranceFlash.clear()
          if (white > 0) entranceFlash.beginFill(0xffffff, white).drawRect(0, 0, app.screen.width, app.screen.height).endFill()
          // Framing is stable throughout in; only the masked idle reveal scales.
          const transitioning = hall?.phase === 'out'
          if (transitioning || wasTransitioning) fit()
          wasTransitioning = transitioning
          // Pause the host timers as well as Spine's AnimationState.
          if (!playbackRef.current) return
          if (interactionRef.current?.state.hallEntry?.phase === 'out') {
            callbacksRef.current.onInteractionEvent?.({ type: 'hall-frame',
              deltaMs: transitionFrame.deltaMs })
          }
          if (uiCameraRef.current) {
            uiCameraRef.current.elapsed += app.ticker.deltaMS / 1000
            fit()
          }
          if (mainCompletionRef.current) {
            mainCompletionRef.current.remainingMs -= app.ticker.deltaMS
            if (mainCompletionRef.current.remainingMs <= 0) {
              const { playSerial } = mainCompletionRef.current
              mainCompletionRef.current = null
              if (trackSerialsRef.current.get(1) === playSerial) {
                trackSerialsRef.current.delete(1)
                callbacksRef.current.onInteractionEvent?.({
                  type: 'track-complete', track: 1,
                  nowMs: performance.now(), random: Math.random(), playSerial,
                })
              }
            }
          }
          // Reconcile renderer state with the reducer after a few rendered
          // frames. This catches any future track-clear path that was not
          // initiated by the interaction machine, without racing a queued
          // play command in the same React update.
          const declaredTracks = interactionRef.current?.state.tracks ?? {}
          for (const [key, declared] of Object.entries(declaredTracks)) {
            const track = Number(key)
            const entry = main.state.getCurrent(track)
            const serial = trackSerialsRef.current.get(track)
            const present = entry?.animation?.name === declared.animation
              && serial != null && entrySerialsRef.current.get(entry) === serial
            if (present || (track === 1 && mainCompletionRef.current)) {
              missingTrackFramesRef.current.delete(track)
              continue
            }
            const missed = (missingTrackFramesRef.current.get(track) ?? 0) + 1
            if (missed < 3) {
              missingTrackFramesRef.current.set(track, missed)
              continue
            }
            missingTrackFramesRef.current.delete(track)
            interactionTracksRef.current.delete(track)
            trackSerialsRef.current.delete(track)
            callbacksRef.current.onInteractionEvent?.({
              type: 'track-abandoned', track, nowMs: performance.now(), playSerial: serial,
            })
          }
          for (const track of missingTrackFramesRef.current.keys()) {
            if (!(String(track) in declaredTracks)) missingTrackFramesRef.current.delete(track)
          }
          // SpineTools.Update raises a main-track entry's Alpha over 0.2 s.
          // The game does this separately from Spine's MixDuration.
          for (const [track, entry] of fadeInEntriesRef.current) {
            if (advanceEntryFade(main.state.getCurrent(track), entry, app.ticker.deltaMS / 1000))
              fadeInEntriesRef.current.delete(track)
          }
          for (const [track, recovery] of gestureRecoveriesRef.current) {
            const entry = recovery.entry
            let live = main.state.getCurrent(track)
            while (live && live !== entry) live = live.mixingFrom
            if (!live || !entry.animation) {
              gestureRecoveriesRef.current.delete(track)
              continue
            }
            if (updateGestureRecovery(entry, recovery, entry.animation.duration, app.ticker.deltaMS / 1000, track === 1)) {
              gestureRecoveriesRef.current.delete(track)
              const serial = trackSerialsRef.current.get(track)
              if (track === 1) {
                main.state.clearTrack(track)
                main.skeleton.setToSetupPose()
                poseDirtyRef.current = true
                mainCompletionRef.current = null
                interactionTracksRef.current.delete(track)
                trackSerialsRef.current.delete(track)
                callbacksRef.current.onInteractionEvent?.({ type: 'track-complete', track, nowMs: performance.now(), playSerial: serial })
              } else {
                // Original Recover retains object tracks, paused at zero.
                callbacksRef.current.onInteractionEvent?.({ type: 'track-progress', track,
                  animation: entry.animation.name, progress: 0, playing: false, playSerial: serial })
              }
            }
          }
          for (const [track, data] of actionStopsRef.current) {
            if (main.state.getCurrent(track) !== data.entry) {
              actionStopsRef.current.delete(track)
              continue
            }
            updateActionStop(data.entry, data.stop, app.ticker.deltaMS / 1000)
          }
          // SpineTools.Update counts clickTime only while a multi-click entry
          // is paused away from zero, then plays it backward to zero.
          for (const [track, timeout] of multiTimeoutsRef.current) {
            if (main.state.getCurrent(track) !== timeout.entry || timeout.entry.timeScale !== 0) {
              multiTimeoutsRef.current.delete(track)
              continue
            }
            timeout.remaining -= app.ticker.deltaMS / 1000
            if (timeout.remaining > 0) continue
            multiTimeoutsRef.current.delete(track)
            timeout.entry.timeScale = -1
            multiStopsRef.current.set(track, {
              target: 0, direction: -1, complete: true,
              rowIndex: timeout.rowIndex, timeoutReset: true,
            })
          }
          for (const [track, stop] of multiStopsRef.current) {
            const entry = main.state.getCurrent(track)
            const trackAnimation = entry?.animation
            if (!entry || !trackAnimation?.duration) continue
            const progress = entry.trackTime / trackAnimation.duration
            if ((stop.direction >= 0 && progress < stop.target)
              || (stop.direction < 0 && progress > stop.target)) continue
            entry.timeScale = 0
            multiStopsRef.current.delete(track)
            if (stop.complete) {
              const playSerial = trackSerialsRef.current.get(track)
              interactionTracksRef.current.delete(track)
              trackSerialsRef.current.delete(track)
              main.state.clearTrack(track)
              main.skeleton.setToSetupPose()
              poseDirtyRef.current = true
              callbacksRef.current.onInteractionEvent?.(stop.timeoutReset && stop.rowIndex != null
                ? { type: 'multi-reset', index: stop.rowIndex, nowMs: performance.now(), playSerial }
                : { type: 'track-complete', track, nowMs: performance.now(), random: Math.random(), playSerial })
            } else {
              if (stop.clickTime != null && Number.isFinite(stop.clickTime)
                && stop.clickTime > 0 && stop.rowIndex != null && entry.trackTime !== 0) {
                multiTimeoutsRef.current.set(track, {
                  entry, remaining: stop.clickTime, rowIndex: stop.rowIndex,
                })
              }
              callbacksRef.current.onInteractionEvent?.({
                type: 'track-progress', track, animation: trackAnimation.name,
                progress: stop.target, playing: false, playSerial: trackSerialsRef.current.get(track),
              })
            }
          }
          for (const overlay of dragOverlayRef.current) {
            if (overlay.object.visible && !overlay.wasVisible) overlay.elapsed = 0
            if (overlay.object.visible) overlay.elapsed += app.ticker.deltaMS / 1000
            overlay.wasVisible = overlay.object.visible
            if (overlay.fade) {
              const f = overlay.fade
              const t = Math.max(0, Math.min(1, (overlay.elapsed - f.delay) / Math.max(.001, f.duration)))
              overlay.sprite.alpha = f.from + (f.to - f.from) * t
            }
          }
          // Unity reapplies surviving tracks before rendering after ClearTrack
          // resets setup pose. Pixi may already have applied this frame's pose.
          if (poseDirtyRef.current) { poseDirtyRef.current = false;main.update(0) }
        })
        fit()

        const stageWindow = window as typeof window & { __interactionStage?: unknown; __rawPreviewStage?: unknown; __auxiliaryPreviewStage?: unknown }
        stageWindow[probeKey] = {
          initialization: () => ({ profile: nativeProfiles.get(main) ?? null, frames: initialFrames }),
          rows: () => (interactionRef.current?.rows ?? []).map((row) => ({
            index: row.index, realIndex: row.realIndex, pose: row.pose, gesture: row.gesture,
            kind: row.kind, track: row.track, anim: row.anim ?? null, hittable: row.hittable,
          })),
          rowClientCenter: (index: number) => {
            const current = interactionRef.current
            const row = current?.rows.find((candidate) => candidate.index === index)
            const group = groupRef.current
            const app = appRef.current
            const canvas = app?.view as HTMLCanvasElement | undefined
            if (!row?.rects[0] || !group || !app || !canvas) return null
            const [configX, configY] = row.rects[0]
            const global = group.toGlobal(new Point(configX, configY))
            const rect = canvas.getBoundingClientRect()
            return {
              x: rect.left + global.x * rect.width / app.screen.width,
              y: rect.top + global.y * rect.height / app.screen.height,
              config: { x: configX, y: configY },
            }
          },
          tracks: () => {
            const spine = layersRef.current.find((layer) => layer.kind === 'main')?.spine
            if (!spine) return []
            const result: Array<{ track: number; animation: string | null; timeScale: number; trackTime: number; duration: number | null }> = []
            for (const entry of spine.state.tracks) {
              if (!entry) continue
              result.push({
                track: entry.trackIndex,
                animation: entry.animation?.name ?? null,
                timeScale: entry.timeScale,
                trackTime: entry.trackTime,
                duration: entry.animation?.duration ?? null,
              })
            }
            return result
          },
          mainBounds: () => {
            const spine = layersRef.current.find((layer) => layer.kind === 'main')?.spine
            const bounds = spine ? visibleSpineBounds(spine) : null
            return bounds ? { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height } : null
          },
          slotPos: (name: string) => {
            const spine = layersRef.current.find((layer) => layer.kind === 'main')?.spine
            if (!spine) return null
            const slot = spine.skeleton.findSlot(name)
            if (!slot) return null
            return { x: slot.bone.worldX, y: slot.bone.worldY }
          },
          // Read-only diagnostic probe: attachment name + slot color for named
          // slots. Exists to answer "why did a skeleton graphic disappear"
          // numerically instead of by eyeballing renders.
          slotState: (names: string[]) => {
            const spine = layersRef.current.find((layer) => layer.kind === 'main')?.spine
            if (!spine) return []
            return names.map((name) => {
              const slot = spine.skeleton.findSlot(name)
              if (!slot) return { name, found: false }
              const attachment = slot.getAttachment()
              return {
                name, found: true,
                attachment: attachment ? attachment.name : null,
                color: [slot.color.r, slot.color.g, slot.color.b, slot.color.a] as [number, number, number, number],
              }
            })
          },
          allSlots: () => {
            const spine = layersRef.current.find((layer) => layer.kind === 'main')?.spine
            if (!spine) return []
            return spine.skeleton.slots.map((slot) => ({
              name: slot.data.name,
              x: slot.bone.worldX,
              y: slot.bone.worldY,
            }))
          },
          allBones: () => {
            const spine = layersRef.current.find((layer) => layer.kind === 'main')?.spine
            if (!spine) return []
            return spine.skeleton.bones.map((bone) => ({
              name: bone.data.name,
              x: bone.worldX,
              y: bone.worldY,
            }))
          },
        }

        const animations = animationNames(main)
        const overlayAnimations = animations.filter((name) => isOverlay(main, name))
        const stateAnimations = animations.filter((name) => isStateAnimation(main, name))
        onMetadata({
          spineVersion: main.skeleton.data.version || asset.spineVersion,
          animations,
          overlayAnimations,
          stateAnimations,
          layers: layers.map((layer) => ({ id: layer.asset.id, kind: layer.kind, label: layer.asset.title })),
          loadedEffects: loadedEffects.length,
          totalEffects: effects.length,
        })
        // A newly mounted material preview must honour the selected animation
        // after framing on the prefab idle. Its React animation effect can run
        // before async loading completes, so that effect alone is insufficient.
        if (probeKey === '__rawPreviewStage') {
          const latest = previewSelectionRef.current
          for (const layer of layers) {
            applyAnimation(layer.spine, latest.animation, layer.kind === 'main' ? latest.loopAnimation : true)
            applyPersistentStates(layer.spine, latest.persistentStates)
          }
        }
        // The original SetImg creation callback configures the new skeleton in
        // this same turn. Metadata/React updates must not expose a default-idle
        // frame or consume restoration commands while the skeleton is loading.
        // Controls may have changed while images, native settings or objects
        // were loading. Their effects had no layers to update at that time.
        const latestControls = loadedControlsRef.current
        applyStagePlayback(layers.map(layer => layer.spine), latestControls.playing, latestControls.speed)
        for (const layer of layers) layer.spine.visible = !latestControls.hiddenLayerIds.includes(layer.asset.id)
          && (layer.kind === 'main' || latestControls.effectsVisible)
        captureInitialFrame('before-ready-callback')
        const initialCommands = runtimeReadyRef.current?.(asset.id, main.state.getCurrent(0)?.animation?.name ?? idleName(main), animations) ?? []
        if (initialCommands.some(command => command.effect.type === 'play' && command.effect.animation === 'in')) revealMs = 180
        group.alpha = revealMs / 180
        applyCommandsRef.current(initialCommands)
        main.update(0)
        captureInitialFrame('after-ready-commands')
        loadTiming.readyMs = performance.now() - loadStarted
        host.dataset.loadTiming = JSON.stringify(loadTiming)
        // Observe actual render boundaries, without changing update or fade order.
        const recordRender = () => {
          captureInitialFrame('pre-render')
          if (initialFrames.length >= 22) app.renderer.off('prerender', recordRender)
        }
        app.renderer.on('prerender', recordRender)
        app.renderer.once('postrender', () => {
          if (disposed) return
          loadTiming.firstRenderMs = performance.now() - loadStarted
          host.dataset.loadTiming = JSON.stringify(loadTiming)
        })
        if (onAudit) {
          requestAnimationFrame(() => requestAnimationFrame(() => {
            if (disposed) return
            app.renderer.render(app.stage)
            const pixels = app.renderer.extract.pixels()
            const pixelWidth = app.renderer.width
            const pixelHeight = app.renderer.height
            let minPixelX = pixelWidth
            let minPixelY = pixelHeight
            let maxPixelX = -1
            let maxPixelY = -1
            let alphaPixels = 0
            for (let index = 3, pixel = 0; index < pixels.length; index += 4, pixel += 1) {
              if (pixels[index] <= 4) continue
              alphaPixels += 1
              const x = pixel % pixelWidth
              const y = Math.floor(pixel / pixelWidth)
              minPixelX = Math.min(minPixelX, x)
              minPixelY = Math.min(minPixelY, y)
              maxPixelX = Math.max(maxPixelX, x)
              maxPixelY = Math.max(maxPixelY, y)
            }
            const screenAlphaBounds = maxPixelX >= 0
              ? { x: minPixelX, y: minPixelY, width: maxPixelX - minPixelX + 1, height: maxPixelY - minPixelY + 1 }
              : null
            const visible = boundsRef.current
            const mainVisible = visibleSpineBounds(main)
            const local = group.getLocalBounds()
            onAudit({
              visibleBounds: visible ? { x: visible.x, y: visible.y, width: visible.width, height: visible.height } : null,
              mainVisibleBounds: mainVisible
                ? { x: mainVisible.x, y: mainVisible.y, width: mainVisible.width, height: mainVisible.height }
                : null,
              declaredBounds: {
                x: main.skeleton.data.x,
                y: main.skeleton.data.y,
                width: main.skeleton.data.width,
                height: main.skeleton.data.height,
              },
              localBounds: { x: local.x, y: local.y, width: local.width, height: local.height },
              screenAlphaBounds,
              alphaPixelRatio: alphaPixels / Math.max(1, pixelWidth * pixelHeight),
              alphaBoundsRatio: screenAlphaBounds
                ? (screenAlphaBounds.width * screenAlphaBounds.height) / Math.max(1, pixelWidth * pixelHeight)
                : 0,
              sampledAnimationTime,
              sampledAnimationName,
              animationCount: animations.length,
              loadedEffects: loadedEffects.length,
              totalEffects: effects.length,
              failedEffects,
            })
          }))
        }
        const effectStatus = effects.length ? ` · ${loadedEffects.length}/${effects.length} 特效层` : ''
        onStatus(`Spine ${main.skeleton.data.version || asset.spineVersion} · ${animations.length} 个动作${effectStatus}`)
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
      layersRef.current = []
      boundsRef.current = null
      groupRef.current = null
      debugRef.current = null
      interactionTracksRef.current.clear()
      trackSerialsRef.current.clear()
      missingTrackFramesRef.current.clear()
      entrySerialsRef.current = new WeakMap()
      fadeInEntriesRef.current.clear()
      mainCompletionRef.current = null
      multiStopsRef.current.clear()
      actionStopsRef.current.clear()
      gesturePointsRef.current.clear()
      dragObjectsRef.current.clear()
      dragNestedRef.current.clear()
      dragOverlayRef.current = []
      if (objectPressTimerRef.current) clearTimeout(objectPressTimerRef.current)
      pointerRef.current.id = -1
      objectMovesRef.current.clear()
      gestureRecoveriesRef.current.clear()
      multiTimeoutsRef.current.clear()
      appRef.current = null
      delete (window as typeof window & { __interactionStage?: unknown; __rawPreviewStage?: unknown; __auxiliaryPreviewStage?: unknown })[probeKey]
      app.destroy(true, { children: true, texture: false, baseTexture: false })
      lifetime.dispose()
    }
  }, [asset, effects, onAudit, onError, onMetadata, onStatus, interaction?.space?.scale, loopAnimation, probeKey])

  useEffect(() => {
    // RoleSpineItem2 / SpineTools.ChangeIdle owns track 0 for game sessions.
    // React renders (progress, voice status, debug visibility) must not restore
    // the skeleton's first idle over a configured idle2/idle4/idle5. The separate
    // raw-preview stage still owns all of its own tracks and reset commands.
    if (interaction && probeKey !== '__rawPreviewStage') return
    const manualReset = lastPreviewResetSerialRef.current !== previewResetSerial
    lastPreviewResetSerialRef.current = previewResetSerial
    if (manualReset) {
      // The viewer's action selector intentionally starts a fresh session.
      interactionTracksRef.current.clear()
      trackSerialsRef.current.clear()
      missingTrackFramesRef.current.clear()
      entrySerialsRef.current = new WeakMap()
      fadeInEntriesRef.current.clear()
      mainCompletionRef.current = null
      multiStopsRef.current.clear()
      actionStopsRef.current.clear()
      gesturePointsRef.current.clear()
      for (const object of dragObjectsRef.current.values()) object.visible = false
      for (const nested of dragNestedRef.current.values()) nested.visible = false
      objectMovesRef.current.clear()
      gestureRecoveriesRef.current.clear()
      multiTimeoutsRef.current.clear()
    }
    for (const layer of layersRef.current) {
      if (manualReset || probeKey !== '__interactionStage') {
        applyAnimation(layer.spine, animation, layer.kind === 'main' ? loopAnimation : true)
        applyPersistentStates(layer.spine, persistentStates)
      } else {
        // An accepted hotspot may switch the preview selector back to idle.
        // Only change the preview tracks; clearing all Spine tracks here leaves
        // the reducer waiting forever for an interaction that was discarded.
        const idle = animation && !isOverlay(layer.spine, animation)
          ? animation : idleName(layer.spine)
        if (idle) layer.spine.state.setAnimation(0, idle, true)
        if (!interactionTracksRef.current.has(OVERLAY_TRACK)) {
          layer.spine.state.clearTrack(OVERLAY_TRACK)
        }
      }
      if (!interactionRef.current?.space && probeKey !== '__auxiliaryPreviewStage') suppressOversizedCameraMatte(layer.spine)
    }
  }, [animation, persistentStates, previewResetSerial, loopAnimation, probeKey])

  useEffect(() => {
    applyStagePlayback(layersRef.current.map(layer => layer.spine), playing, speed)
  }, [playing, speed])


  useEffect(() => {
    for (const layer of layersRef.current) {
      layer.spine.visible = !hiddenLayerIds.includes(layer.asset.id) && (layer.kind === 'main' || effectsVisible)
    }
    if (groupRef.current) {
      boundsRef.current = visibleLayerBounds(layersRef.current, groupRef.current)
      fit()
    }
  }, [effectsVisible, hiddenLayerIds])

  useEffect(() => {
    viewRef.current = { zoom, flipped, pan }
    fit()
  }, [flipped, pan, zoom])

  useViewReset(() => {
    callbacksRef.current.onZoomChange(1)
    callbacksRef.current.onPanChange({ x: 0, y: 0 })
  })

  useEffect(() => {
    if (probeKey !== '__interactionStage') return
    const camera = (event: Event) => {
      const clip = (event as CustomEvent<UiClip | null>).detail
      uiCameraRef.current = clip ? { clip, elapsed: 0 } : null
      fit()
    }
    window.addEventListener('source-ui-camera', camera)
    return () => window.removeEventListener('source-ui-camera', camera)
  }, [probeKey])
  useEffect(() => { fit() }, [interaction?.state.spineUi.open])

  useEffect(() => {
    callbacksRef.current = { onActivate, onZoomChange, onPanChange, onInteractionEvent, onStatus }
  }, [onActivate, onInteractionEvent, onPanChange, onZoomChange, onStatus])

  useEffect(() => {
    interactionRef.current = interaction
    redrawDebug()
    fit()
  }, [interaction])

  applyCommandsRef.current = (commands) => {
    const main = layersRef.current.find((layer) => layer.kind === 'main')?.spine
    if (!main) return
    const diagnoseMissingAnimation = (name: string, context: string) => {
      const message = `交互诊断：当前骨骼包缺少动画「${name}」（${context}），已保持 idle 不播放替代动画`
      if (diagnosticRef.current === message) return
      diagnosticRef.current = message
      callbacksRef.current.onStatus?.(message)
    }
    for (const command of commands) {
      if (command.serial <= commandSerialRef.current) continue
      commandSerialRef.current = command.serial
      const effect = command.effect
      if (effect.type === 'reset-actions') {
        const data = actionStopsRef.current.get(effect.track)
        if (data && main.state.getCurrent(effect.track) === data.entry
          && data.entry.animation?.name === effect.animation) {
          resetActionStop(data.entry, data.stop, data.entry.animation.duration, effect.stopPerc, effect.stopLimit)
        }
      } else if (effect.type === 'play') {
        const animation = main.skeleton.data.findAnimation(effect.animation)
        if (!animation) {
          diagnoseMissingAnimation(effect.animation, `轨道 ${effect.track}`)
          continue
        }
        diagnosticRef.current = ''
        const current = main.state.getCurrent(effect.track)
        // PlayByClick1/2 always call SetAnimation, even for a repeated name.
        // Only multi-click and restored entries retain their TrackEntry.
        const reuse = (effect.mode === 'multi' || effect.mode === 'restore')
          && current?.animation?.name === effect.animation
        const entry = reuse
          ? current
          : main.state.setAnimation(effect.track, effect.animation, false)
        actionStopsRef.current.delete(effect.track)
        gestureRecoveriesRef.current.delete(effect.track)
        if (effect.mode === 'actions') {
          const config = interactionRef.current?.rows.find((row) => row.index === effect.rowIndex)?.content.actions
          if (config?.stopTime != null && config.stopPerc != null) actionStopsRef.current.set(effect.track, {
            entry, stop: createActionStop(animation.duration, config.stopPerc, config.stopTime, config.stopCount),
          })
        }
        interactionTracksRef.current.add(effect.track)
        trackSerialsRef.current.set(effect.track, command.serial)
        entrySerialsRef.current.set(entry, command.serial)
        if (effect.track === 1) mainCompletionRef.current = null
        if (!reuse && (effect.mode === 'click' || effect.mode === 'actions') && effect.track === 1) {
          entry.mixDuration = effect.fadeIn ? 0.2 : 0
          entry.alpha = effect.fadeIn ? 0 : 1
          if (effect.fadeIn) fadeInEntriesRef.current.set(effect.track, entry)
        }
        if (!reuse && effect.fadeOut) {
          const empty = main.state.addEmptyAnimation(effect.track, 0.5, 0)
          entrySerialsRef.current.set(empty, command.serial)
        }
        if (effect.timeScale != null) entry.timeScale = effect.timeScale
        if (effect.mode === 'restore' && effect.progress != null) {
          entry.trackTime = animation.duration * effect.progress
          entry.timeScale = 0
          main.update(0)
          continue
        }
        if (effect.mode === 'multi' && effect.progress != null) {
          multiTimeoutsRef.current.delete(effect.track)
          if (effect.timeScale === -1 && entry.trackTime <= 0) entry.trackTime = animation.duration
          multiStopsRef.current.set(effect.track, {
            target: effect.progress,
            direction: effect.timeScale ?? 1,
            complete: effect.complete,
            clickTime: effect.clickTime,
            rowIndex: effect.rowIndex,
          })
        }
      } else if (effect.type === 'clear-tracks') {
        for (const track of effect.tracks) {
          if (effect.fade) main.state.setEmptyAnimation(track, 0.2)
          else main.state.clearTrack(track)
          actionStopsRef.current.delete(track)
          gestureRecoveriesRef.current.delete(track)
          if (track === 1) mainCompletionRef.current = null
          interactionTracksRef.current.delete(track)
          trackSerialsRef.current.delete(track)
          fadeInEntriesRef.current.delete(track)
          multiStopsRef.current.delete(track)
          multiTimeoutsRef.current.delete(track)
        }
        // ImmClearTracks calls SpineTools.ClearTrack, which also resets the
        // skeleton pose after each cleared entry. One reset after the batch
        // is equivalent here because no frame renders between clears.
        if (effect.tracks.length && !effect.fade) { main.skeleton.setToSetupPose();poseDirtyRef.current = true }
      } else if (effect.type === 'change-idle') {
        if (main.skeleton.data.findAnimation(effect.idle)) main.state.setAnimation(0, effect.idle, true)
        else diagnoseMissingAnimation(effect.idle, 'changeIdle')
      } else if (effect.type === 'object-restore') {
        const row = interactionRef.current?.rows.find(r => r.index === effect.rowIndex)
        for (const name of (row?.content.drag?.slots as string[] | undefined) ?? []) {
          const slot = main.skeleton.findSlot(name)
          if (slot) slot.color.a = 1
        }
      } else if (effect.type === 'drag-start') {
        gesturePointsRef.current.set(effect.rowIndex, {
          x: effect.x ?? pointerRef.current.configX, y: effect.y ?? pointerRef.current.configY,
        })
        const row = interactionRef.current?.rows.find(r => r.index === effect.rowIndex)
        const host = row?.dragHost
        const object = host && dragObjectsRef.current.get(host.object)
        if (host && object) {
          objectMovesRef.current.set(row!.index, { count: 0, nested: Boolean(host.nested) })
          object.position.set(effect.longPress ? effect.x ?? host.x : host.x,
            effect.longPress ? effect.y ?? host.y : host.y)
          object.visible = true
          const nested = dragNestedRef.current.get(host.object)
          if (nested) {
            nested.visible = true
            const track = nested.state.getCurrent(0), mainTrack = main.state.getCurrent(0)
            if (track && mainTrack) track.trackTime = mainTrack.trackTime
          }
          for (const name of (row?.content.drag?.slots as string[] | undefined) ?? []) {
            const slot = main.skeleton.findSlot(name)
            if (slot) slot.color.a = 0
          }
        }
      } else if (effect.type === 'drag-progress') {
        const row = interactionRef.current?.rows.find((candidate) => candidate.index === effect.rowIndex)
        if (row?.content.drag) {
          const host = row.dragHost, motion = objectMovesRef.current.get(row.index)
          const object = host && dragObjectsRef.current.get(host.object)
          if (object && motion && advanceObjectDrag(motion)) object.position.set(effect.x, effect.y)
          gesturePointsRef.current.set(row.index, { x: effect.x, y: effect.y })
          continue
        }
        if (!row?.anim) continue
        const animation = main.skeleton.data.findAnimation(row.anim)
        if (!animation) {
          diagnoseMissingAnimation(row.anim, `拖拽触点 ${row.realIndex}`)
          continue
        }
        const current = main.state.getCurrent(row.track)
        const prior = gesturePointsRef.current.get(row.index) ?? { x: effect.x, y: effect.y }
        gesturePointsRef.current.set(row.index, { x: effect.x, y: effect.y })
        if (row.content.gestureDatas && gestureRecoveriesRef.current.has(row.track)) {
          trackSerialsRef.current.set(row.track, command.serial)
          if (current) entrySerialsRef.current.set(current, command.serial)
          continue
        }
        const entry = current?.animation?.name === row.anim
          ? current
          : main.state.setAnimation(row.track, row.anim, false)
        const dx = effect.x - (row.content.gestureDatas ? prior.x : pointerRef.current.configX)
        const dy = effect.y - (row.content.gestureDatas ? prior.y : pointerRef.current.configY)
        // Rects now live in skeleton units; the game's drag `speed` was tuned
        // for the prefab's pos/main-scaled pointer space, so restore that scale.
        const space = interactionRef.current?.space
        const spaceScale = (space?.scale ?? 1) * (space?.mainScale ?? 1)
        const distance = row.gesture <= 2 ? Math.abs(dx) : row.gesture <= 4 ? Math.abs(dy) : Math.hypot(dx, dy)
        const speed = row.content.gestureDatas?.speed ?? 1
        const limit = row.content.gestureDatas?.limitPerc ?? 1
        const progress = row.content.gestureDatas
          ? gestureProgress(entry.trackTime / animation.duration, row.gesture, dx, dy, spaceScale, speed, limit)
          : Math.max(0, Math.min(limit, distance * spaceScale * speed * 0.001))
        if (row.content.gestureDatas && current !== entry) { entry.mixDuration = 0.2; entry.alpha = 1 }
        entry.trackTime = animation.duration * progress
        entry.timeScale = 0
        main.update(0)
        interactionTracksRef.current.add(row.track)
        trackSerialsRef.current.set(row.track, command.serial)
        entrySerialsRef.current.set(entry, command.serial)
        callbacksRef.current.onInteractionEvent?.({
          type: 'track-progress', track: row.track, animation: row.anim,
          progress, playing: false, playSerial: command.serial,
        })
      } else if (effect.type === 'drag-recover') {
        const row = interactionRef.current?.rows.find((candidate) => candidate.index === effect.rowIndex)
        if (row?.content.drag && row.dragHost) {
          const host = row.dragHost, object = dragObjectsRef.current.get(host.object)
          const poseScale = interactionRef.current?.l2dPos?.[2] ?? 1
          const diagnostic = { objectFound: Boolean(object), moves: objectMovesRef.current.get(row.index)?.count ?? 0,
            x: object?.x, y: object?.y, targets: host.targets.map(target => ({ animation: target.animation,
              distance: object ? Math.hypot(object.x-target.x, object.y-target.y)*objectWorldScale(host,poseScale) : -1 })) }
          let animation: string | null = null
          if (object) {
            // RoleSpineItem2 checks all targets, with the last match winning.
            animation = objectDropAnimation(host, object.x, object.y,poseScale)
            object.visible = false
            const nested = dragNestedRef.current.get(host.object)
            if (nested) nested.visible = false
            object.position.set(host.x, host.y)
          }
          gesturePointsRef.current.delete(row.index)
          objectMovesRef.current.delete(row.index)
          callbacksRef.current.onInteractionEvent?.({ type: 'object-drop', random: Math.random(), index: row.index, diagnostic, cancelled: effect.cancelled, animation, nowMs: performance.now() })
          continue
        }
        if (!row?.anim) continue
        const entry = main.state.getCurrent(row.track)
        if (!entry) continue
        gesturePointsRef.current.delete(row.index)
        if (row.content.gestureDatas) {
          if (gestureRecoveriesRef.current.has(row.track) || !entry.animation) continue
          const recovery = gestureRecovery(entry.trackTime / entry.animation.duration, row.content.gestureDatas)
          if (!recovery) continue
          gestureRecoveriesRef.current.set(row.track, { entry, ...recovery })
          if (row.track === 1) {
            const empty = main.state.addEmptyAnimation(row.track, 0.5, 0)
            const serial = trackSerialsRef.current.get(row.track)
            if (serial != null) entrySerialsRef.current.set(empty, serial)
          }
          continue
        }
        entry.timeScale = -1
        multiStopsRef.current.set(row.track, { target: 0, direction: -1, complete: true })
      }
    }
  }
  useEffect(() => { applyCommandsRef.current(interactionCommands) }, [interactionCommands])

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const handleWheel = (event: WheelEvent) => {
      event.preventDefault()
      if (!viewControl.allowedRef.current) return
      const current = viewRef.current
      const rect = host.getBoundingClientRect()
      const normalizedDelta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? rect.height : 1)
      const wheelFactor = Math.max(0.75, Math.min(1.33, Math.exp(-normalizedDelta * 0.0015)))
      const nextZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, current.zoom * wheelFactor))
      if (nextZoom === current.zoom) return
      const pointX = event.clientX - rect.left
      const pointY = event.clientY - rect.top
      const centerX = rect.width / 2
      const centerY = rect.height / 2
      const ratio = nextZoom / current.zoom
      callbacksRef.current.onPanChange({
        x: pointX - centerX - (pointX - centerX - current.pan.x) * ratio,
        y: pointY - centerY - (pointY - centerY - current.pan.y) * ratio,
      })
      callbacksRef.current.onZoomChange(nextZoom)
    }
    host.addEventListener('wheel', handleWheel, { passive: false })
    return () => host.removeEventListener('wheel', handleWheel)
  }, [])

  const guides = showGuides && interaction?.debug && !interaction.state.hallEntry
    ? interactionGuides(interaction.rows, interaction.state, performance.now()) : []

  return (
    <div
      className={`spine-stage interactive ${viewControl.allowed ? '' : 'viewport-locked'}`}
      ref={hostRef}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={(event) => finishPointer(event, true)}
      onPointerCancel={(event) => finishPointer(event, false)}
      onLostPointerCapture={(event) => finishPointer(event, false)}
      title="拖拽移动 · 滚轮缩放"
    >
      {guides.length > 0 && <div className="interaction-guide" role="note" aria-label="热区顺序提示">
        <strong>游戏配置的自动动作链</strong>
        {guides.map((guide) => <div className="interaction-guide-chain" key={guide.source.index}>
          <div>{guide.path
            ? `${guide.path.map((row) => `#${row.index} ${row.anim || '切换'}`).join(' → ')} → 自动 #${guide.target.index} ${guide.target.anim || '动作'}`
            : `#${guide.source.index} ${guide.source.anim || '动作'} → 自动 #${guide.target.index} ${guide.target.anim || '动作'}`}</div>
          <small>{guide.complete ? '本轮已触发'
            : guide.pending ? `等待 #${guide.source.index} 动作结束，随后自动播放`
            : guide.next ? guide.waiting
              ? `等待当前动作结束；下一步点击 #${guide.next.index}`
              : `下一步点击 #${guide.next.index} ${guide.next.anim || ''}`
              : '尚未找到可确认的点击顺序，可能需要其他姿态或条件'}</small>
        </div>)}
      </div>}
    </div>
  )
}
