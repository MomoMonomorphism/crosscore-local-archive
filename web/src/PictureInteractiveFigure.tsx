import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import SpineStage from './SpineStage'
import { scheduleDeadline } from './deadlineTimer'
import { PoseInterlude, preparePoseAsset, type PoseInterludeCommand } from './PoseInterlude'
import { separatePreviewLayers } from './previewLayers'
import { figureKey, findPoseVariantIndex } from './interactionAssetMatch'
import { completePoseLoad, createInteractionState, reduceInteraction } from './interactionMachine'
import type { InteractionEffect, InteractionEvent, InteractionRow, InteractionState } from './interactionMachine'
import type { Manifest, MultiPictureActionManifest, Variant } from './types'

const NO_STATES: string[] = []
const NO_HIDDEN_LAYERS: string[] = []
const ignorePreviewMetadata = () => {}

type Props = {
  modelId: string
  variant: Variant
  gallery: Manifest
  contract: MultiPictureActionManifest
  animation: string | null
  playing: boolean
  previewResetSerial?: number
  debug: boolean
  onHotspotCount: (count: number) => void
  onAudio: (audioId: number) => void
  onStatus: (status: string) => void
  onError: (message: string) => void
  onAnimations: (names: string[], idle: string | null) => void
  onResetAnimation: () => void
  onPoseChange: (name: string) => void
}

/** The same RoleSpineItem2 reducer and renderer used by the character gallery,
 * bound to CfgSpineMultiImageAction instead of CfgSpineAction. */
export default function PictureInteractiveFigure({
  modelId, variant, gallery, contract, animation, playing, previewResetSerial = 0, debug, onHotspotCount,
  onAudio, onStatus, onError, onAnimations, onResetAnimation, onPoseChange,
}: Props) {
  const rows: InteractionRow[] = contract.models[modelId] ?? []
  const model = contract.poses[modelId]
  const [state, setState] = useState<InteractionState>(() =>
    createInteractionState(rows, model.initialSpine, 'idle', model.initialRole))
  const stateRef = useRef(state)
  const [activeVariant, setActiveVariant] = useState(variant)
  const [commands, setCommands] = useState<Array<{ serial: number; effect: InteractionEffect }>>([])
  const [interlude, setInterlude] = useState<PoseInterludeCommand | null>(null)
  const pendingPose = useRef<{ assetId: string; afterIndex: number | null } | null>(null)
  const serialRef = useRef(0)
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const hotspotCount = rows.filter((row) => row.hittable && row.pose === state.role).length
  useEffect(() => onHotspotCount(hotspotCount), [hotspotCount, onHotspotCount])
  const previewing = animation !== null
  const livePlaying = playing && !previewing
  const pausedAt = useRef<number | null>(null)
  const pose = model.poses[String(state.role)] ?? model.poses['1']
  const previewState = useMemo(() => createInteractionState([], state.spine, state.idle, state.role),
    [state.spine, state.idle, state.role])
  const interludeNames = useMemo(() => new Set(rows
    .flatMap((row) => row.poseSwitch ? [figureKey(row.poseSwitch.interludeSpine)] : [])), [rows])
  const effects = useMemo(() => separatePreviewLayers(activeVariant.effects, interludeNames).attached,
    [activeVariant.effects, interludeNames])
  const handleMetadata = useCallback((metadata: { animations: string[] }) =>
    onAnimations(metadata.animations, stateRef.current.idle), [onAnimations])

  const runEffects = useCallback((items: InteractionEffect[]) => {
    const commands: Array<{ serial: number; effect: InteractionEffect }> = []
    for (const effect of items) {
      if (['play', 'clear-tracks', 'change-idle', 'drag-start', 'drag-progress', 'drag-recover'].includes(effect.type)) {
        const command = { serial: ++serialRef.current, effect }
        commands.push(command)
        setCommands((current) => [...current.slice(-31), command])
      } else if (effect.type === 'audio') {
        onAudio(effect.cue)
      } else if (effect.type === 'pose-interlude') {
        onStatus(`正在切换姿态：${effect.spine}`)
        const asset = gallery.entries
          .filter((entry) => entry.category === 'cg')
          .flatMap((entry) => entry.variants.flatMap((candidate) => [
            candidate.main, ...candidate.effects.map((layer) => layer.asset),
          ]))
          .find((candidate) => figureKey(candidate.sourceName) === figureKey(effect.spine))
        const defaults = contract.interludeDefaults[effect.spine]
        if (asset && defaults) setInterlude({
          serial: ++serialRef.current, asset,
          animation: defaults.animation, loop: defaults.loop, durationMs: effect.durationMs,
          zoom, pan, flipped: false,
        })
      } else if (effect.type === 'load-pose' || effect.type === 'prepare-pose') {
        const destination = gallery.entries
          .filter((entry) => entry.category === 'cg')
          .flatMap((entry) => entry.variants)
          .find((candidate) => findPoseVariantIndex([candidate], effect.spine) === 0)
        if (!destination) {
          onError(`姿态资源未找到：${effect.spine}`)
          continue
        }
        if (effect.type === 'prepare-pose') {
          void preparePoseAsset(destination.main).catch(() => {})
          continue
        }
          pendingPose.current = { assetId: destination.main.id, afterIndex: effect.afterIndex }
          setCommands([])
          setActiveVariant(destination)
          onResetAnimation()
          onPoseChange(effect.spine)
          onStatus(`姿态已切换：${effect.spine}`)
      }
    }
    return commands
  }, [contract, modelId, pose, zoom, pan, gallery, onAudio, onError, onPoseChange, onResetAnimation, onStatus, rows])

  const onInteractionEvent = useCallback((event: InteractionEvent) => {
    const current = stateRef.current
    const result = reduceInteraction(rows, current, event)
    stateRef.current = result.state
    setState(result.state)
    if (result.accepted) {
      if (event.type === 'press' && result.effects.some((effect) => effect.type === 'play')) onResetAnimation()
      runEffects(result.effects)
    } else if (event.type === 'press') {
      onStatus(`命中热区 #${event.index}：${result.reason ?? '当前无法触发'}`)
    }
  }, [onResetAnimation, onStatus, rows, runEffects])

  useEffect(() => {
    if (!livePlaying) { pausedAt.current ??= performance.now(); return }
    if (pausedAt.current !== null) {
      const elapsedMs = performance.now() - pausedAt.current
      pausedAt.current = null
      onInteractionEvent({ type: 'resume-clock', elapsedMs })
    }
  }, [livePlaying, onInteractionEvent])

  useEffect(() => {
    if (!livePlaying) return
    const deadlines = [state.changeIdle?.atMs, state.pendingPoseLoad?.atMs].filter((v): v is number => v != null)
    if (!deadlines.length) return
    return scheduleDeadline(Math.min(...deadlines), nowMs => onInteractionEvent({ type: 'tick', nowMs }))
  }, [livePlaying, onInteractionEvent, state.changeIdle, state.pendingPoseLoad])

  return <div className="picture-figure" data-variant={activeVariant.id}>
    <div className={`stage-runtime ${previewing ? 'stage-runtime-hidden' : ''}`}>
    {interlude && <PoseInterlude command={interlude} playing={livePlaying} speed={1}
      onDone={serial => setInterlude(current => current?.serial === serial ? null : current)} onError={onError} />}
    <SpineStage
      key={activeVariant.id}
      asset={activeVariant.main}
      effects={effects}
      animation={null}
      playing={livePlaying}
      speed={1}
      effectsVisible
      flipped={false}
      zoom={zoom}
      pan={pan}
      persistentStates={NO_STATES}
      hiddenLayerIds={NO_HIDDEN_LAYERS}
      onZoomChange={setZoom}
      onPanChange={setPan}
      onMetadata={handleMetadata}
      onRuntimeReady={(assetId, idle) => {
        const pending = pendingPose.current
        if (!pending || pending.assetId !== assetId) return []
        pendingPose.current = null
        const result = completePoseLoad(rows, stateRef.current, performance.now(), idle ?? undefined, pending.afterIndex)
        stateRef.current = result.state; setState(result.state)
        return runEffects(result.effects)
      }}
      onStatus={onStatus}
      onError={onError}
      interaction={{
        rows, state, debug,
        space: pose?.touchSpace ?? null,
        l2dPos: contract.archive[modelId]?.l2dPos ?? null,
      }}
      interactionCommands={commands}
      onInteractionEvent={onInteractionEvent}
    />
    </div>
    {previewing && <div className="stage-runtime">
      <SpineStage key={`preview:${activeVariant.id}`} asset={activeVariant.main} effects={effects}
        animation={animation} playing={playing} speed={1} loopAnimation={false}
        probeKey="__rawPreviewStage" previewResetSerial={previewResetSerial}
        effectsVisible flipped={false} zoom={zoom} pan={pan}
        persistentStates={NO_STATES} hiddenLayerIds={NO_HIDDEN_LAYERS}
        onZoomChange={setZoom} onPanChange={setPan} onMetadata={ignorePreviewMetadata}
        onStatus={onStatus} onError={onError}
        interaction={{ rows: [], state: previewState, debug: false, space: pose?.touchSpace ?? null,
          l2dPos: contract.archive[modelId]?.l2dPos ?? null }} />
    </div>}
  </div>
}
