import { GalleryHotspotDetails, GalleryVoiceTools, useGalleryLayout } from './GalleryLayout'
import { InteractionHelp } from './InteractionHelp'
import { FloatingLyrics } from './FloatingLyrics'
import { GalleryToolbar } from './GalleryToolbar'
import { ActionTriggerGuide } from './ActionTriggerGuide'
import { animationTriggers } from './animationTriggers'
import { inputFeedback, type InteractionFeedback } from './interactionPresentation'
import { ImmersiveContext, ImmersiveTools, ImmersiveEntry } from './ImmersiveMode'
import { scheduleDeadline } from './deadlineTimer'
import { PoseInterlude, preparePoseAsset, type PoseInterludeCommand } from './PoseInterlude'
import { inspectInteraction, hotspotSummary } from './interactionDiagnostics'
import CharacterPortraitStage from './CharacterPortraitStage'
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import SpineStage, { type SpineMetadata } from './SpineStage'
import AuxiliaryPreview from './AuxiliaryPreview'
import { separatePreviewLayers } from './previewLayers'
import { SpineUiHost, supportsSpineUi, type SpineUiCommand } from './SpineUiHost'
import type { ContentSection } from './PrimaryNav'
import GalleryTopbar from './GalleryTopbar'
import { interactionAnimationCatalog, interactionAnimationExplanation, interactionAnimationLabel } from './interactionAnimationCatalog'
import { figureKey, findPoseVariantIndex } from './interactionAssetMatch'
import { sitePath } from './sitePaths'
import type { PrefabSpace } from './gameFrame'
import { buildGalleryLabels, gallerySearchText } from './galleryNames'
import { cgPictureVoiceBanks, pictureSpeakerId, pictureSpeakerName, pictureVoiceText, pictureVoicePlaybackText } from './pictureVoiceBanks'
import { simplifyDisplay } from './simplifyDisplay'
import type { DisplayNamesManifest, GalleryEntry, Manifest, ModelAsset, MultiPictureActionManifest, ThumbnailManifest, VoiceBank, VoiceManifest, VoiceStream } from './types'
import {
  createInteractionState,
  completePoseLoad,
  reduceInteraction,
  type InteractionEffect,
  type InteractionEvent,
  type InteractionRow,
  type InteractionState,
} from './interactionMachine'

// Route-level code splitting: these three views are not needed for the landing
// gallery view, so their code (and any view-only dependencies) load on demand.
const AsmrStage = lazy(() => import('./AsmrStage'))
const IllustrationStage = lazy(() => import('./IllustrationStage'))
const AuditStage = lazy(() => import('./AuditStage'))

const BootFallback = () => (
  <div className="boot-fallback">
    <span className="boot-mark">CC</span>
    <span>Loading Module</span>
  </div>
)

const NO_PREVIEW_STATES: string[] = []
type HallEntryConfig = { index: number; audio: number[]; clearTracks: number[]; baseIdle: string | null; effect?: string | null }

const formatBytes = (bytes: number) => {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

const STATE_KEY = 'crosscore-local-viewer.state'
const DEFAULT_ENTRY = 'character:crestedplume'
const DEFAULT_VARIANT = '3006_skin_crestedplume03_spine/3006_skin_CrestedPlume03'
const MIN_ZOOM = 0.25
const MAX_ZOOM = 4

type InteractionManifest = {
  models: Record<string, InteractionRow[]>
  interludeDefaults?: Record<string, { animation: string; loop: boolean }>
  display: Record<string, { l2dName: string | null; l2dPos?: [number, number, number] | null }>
  poses: Record<string, {
    initialRole: number
    initialSpine: string
    poses: Record<string, { role: number; l2dName: string; touchIndexes: number[]; touchSpace?: PrefabSpace | null }>
  }>
}

type ViewState = {
  zoom: number
  pan: { x: number; y: number }
  flipped: boolean
}

const defaultView = (): ViewState => ({ zoom: 1, pan: { x: 0, y: 0 }, flipped: false })

const SEMANTIC_VOICE_CATEGORIES = [
  ['touch', '接触'],
  ['home', '主页'],
  ['battle', '战斗'],
  ['profile', '养成'],
  ['facility', '设施'],
  ['shop', '商店'],
  ['other', '其他'],
] as const

/**
 * Say which table labelled a bank, and whether the curated one has drifted.
 *
 * The two sources disagree for 11 roles: the curated `CfgCardRoleVoice` still
 * points at the cues it was authored against, but those banks were re-baked, so
 * the labels no longer match the audio (Thunder's official table puts a
 * 91-character line on a 1.03 s stream). Those roles fall back to the sound book,
 * and the panel says so rather than presenting the switch as normal.
 */
const labelSourceNote = (bank: VoiceBank) => {
  const conflicts = bank.labelConflictCount ?? 0
  if (bank.labelSource === 'roleVoice') {
    return conflicts
      ? `标签来源：角色图鉴表 · ${conflicts} 条与声库表不一致`
      : '标签来源：角色图鉴表'
  }
  if (bank.labelSource === 'soundBook') {
    return bank.officialAligned === false
      ? '标签来源：声库表（图鉴表的 cue 编号已与该批次音频错位，故改用声库）'
      : '标签来源：声库表'
  }
  return '未找到对应语义表'
}

function requestedState() {
  const params = new URLSearchParams(window.location.search)
  const requestedView = params.get('view')
  const view: 'gallery' | 'asmr' | 'picture' | 'audit' =
    requestedView === 'asmr' || requestedView === 'picture' || requestedView === 'audit' ? requestedView : 'gallery'
  let saved: Record<string, unknown> = {}
  try { saved = JSON.parse(localStorage.getItem(STATE_KEY) ?? '{}') as Record<string, unknown> } catch { /* ignore */ }
  // Use the landing skin only for first-time visitors. Saved selections and
  // explicit resource links continue to take precedence.
  const hasSavedSelection = ['entry', 'variant', 'portrait'].some(key => typeof saved[key] === 'string' && saved[key] !== '')
  const defaultLanding = view === 'gallery' && !hasSavedSelection && !['entry', 'variant', 'portrait'].some(key => params.has(key))
  const savedZoom = typeof saved.zoom === 'number' ? saved.zoom : 1
  return {
    view,
    entry: params.get('entry') ?? (defaultLanding ? DEFAULT_ENTRY : typeof saved.entry === 'string' ? saved.entry : ''),
    portrait: params.get('portrait') ?? (params.has('entry') ? '' : typeof saved.portrait === 'string' ? saved.portrait : ''),
    variant: params.get('variant') ?? (defaultLanding ? DEFAULT_VARIANT : typeof saved.variant === 'string' ? saved.variant : ''),
    animation: params.get('animation') ?? (typeof saved.animation === 'string' ? saved.animation : ''),
    speed: typeof saved.speed === 'number' ? saved.speed : 1,
    effects: typeof saved.effects === 'boolean' ? saved.effects : true,
    states: (params.get('states') ?? (typeof saved.states === 'string' ? saved.states : '')).split(',').filter(Boolean),
    zoom: Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, savedZoom)),
    pan: {
      x: typeof saved.panX === 'number' ? saved.panX : 0,
      y: typeof saved.panY === 'number' ? saved.panY : 0,
    },
    flipped: typeof saved.flipped === 'boolean' ? saved.flipped : false,
    audit: {
      autorun: params.get('autorun') === '1',
      shards: Math.max(1, Math.min(8, Number(params.get('shards')) || 1)),
      shard: Math.max(0, Number(params.get('shard')) || 0),
      retry: params.get('retry') === 'blank' ? 'blank' as const : null,
    },
  }
}

const initialState = requestedState()
const isPublicPreview = import.meta.env.VITE_STATIC_DEMO === '1'

export default function App() {
  const [hallEntries, setHallEntries] = useState<Record<string, HallEntryConfig>>({})
  useEffect(() => {
    let cancelled = false
    void fetch('/api/hall-entries').then(r => { if (!r.ok) throw new Error('入场配置读取失败');return r.json() })
      .then(data => { if (!cancelled) setHallEntries(data) }).catch(() => {})
    return () => { cancelled = true }
  }, [])
  const [view, setView] = useState<'gallery' | 'asmr' | 'picture' | 'audit'>(initialState.view)
  const [asmrAlbumId, setAsmrAlbumId] = useState<number | null>(null)
  const [manifest, setManifest] = useState<Manifest | null>(null)
  const [displayNames, setDisplayNames] = useState<DisplayNamesManifest | null>(null)
  const [category, setCategory] = useState<'character' | 'cg'>('character')
  const [query, setQuery] = useState('')
  const [selectedId, setSelectedId] = useState('')
  const [variantIndex, setVariantIndex] = useState(0)
  const [animations, setAnimations] = useState<string[]>([])
  const [overlayAnimations, setOverlayAnimations] = useState<string[]>([])
  const [stateAnimations, setStateAnimations] = useState<string[]>([])
  const [persistentStates, setPersistentStates] = useState<string[]>(initialState.states)
  const [layers, setLayers] = useState<SpineMetadata['layers']>([])
  const [hiddenLayerIds, setHiddenLayerIds] = useState<string[]>([])
  const [animation, setAnimation] = useState<string | null>(initialState.animation || null)
  const [playbackPlaying, setPlaying] = useState(true)
  const [auxiliaryPreview, setAuxiliaryPreview] = useState<ModelAsset | null>(null)
  const playing = playbackPlaying && !auxiliaryPreview
  const [speed, setSpeed] = useState(initialState.speed)
  const [effectsVisible, setEffectsVisible] = useState(initialState.effects)
  const [flipped, setFlipped] = useState(initialState.flipped)
  const [zoom, setZoom] = useState(initialState.zoom)
  const [pan, setPan] = useState(initialState.pan)
  const [status, setStatus] = useState('正在读取本地图鉴…')
  const [error, setError] = useState('')
  const [retryKey, setRetryKey] = useState(0)
  const [cacheStatus, setCacheStatus] = useState<{ packages: number; bytes: number } | null>(null)
  const [voices, setVoices] = useState<VoiceManifest | null>(null)
  const [thumbnails, setThumbnails] = useState<ThumbnailManifest | null>(null)
  const [characterInteractions, setCharacterInteractions] = useState<InteractionManifest | null>(null)
  const [multiActions, setMultiActions] = useState<MultiPictureActionManifest | null>(null)
  const [interactionState, setInteractionState] = useState<InteractionState | null>(null)
  const [interactionDebug, setInteractionDebug] = useState(false)
  const [showAllHotspots, setShowAllHotspots] = useState(false)
  const [focusedHotspot, setFocusedHotspot] = useState<number | null>(null)
  const [interactionFeedback, setInteractionFeedback] = useState<InteractionFeedback | null>(null)
  const [interactionCommands, setInteractionCommands] = useState<Array<{ serial: number; effect: InteractionEffect }>>([])
  const [rawPreviewActive, setRawPreviewActive] = useState(Boolean(new URLSearchParams(window.location.search).get('animation')))
  const [rawPreviewSerial, setRawPreviewSerial] = useState(0)
  // Opt-in, asset-scoped inspection; never stored in localStorage.
  const [previewSlotOverride, setPreviewSlotOverride] = useState(() => {
    const params = new URLSearchParams(window.location.search)
    const slots = params.get('previewHideSlots')?.split('|').filter(Boolean) ?? []
    return slots.length ? { asset: params.get('variant'), slots } : null
  })
  const [interludeCommand, setInterludeCommand] = useState<PoseInterludeCommand | null>(null)
  const [voiceStatus, setVoiceStatus] = useState('')
  const [floatingLyrics, setFloatingLyrics] = useState(true)
  const [playingLyric, setPlayingLyric] = useState('')
  const [lyricsPassthrough, setLyricsPassthrough] = useState(false)
  const [lyricsReset, setLyricsReset] = useState(0)
  const layout = useGalleryLayout(view === 'gallery')
  useEffect(() => { setFocusedHotspot(null) }, [layout.tab, layout.toolsOpen])
  const [actionQuery, setActionQuery] = useState('')
  const [expandedAction, setExpandedAction] = useState<string | null>(null)
  const [modeDetailsOpen, setModeDetailsOpen] = useState(false)
  const [voiceVolume, setVoiceVolume] = useState(.65)
  const voiceVolumeRef = useRef(voiceVolume)
  voiceVolumeRef.current = voiceVolume
  const [voiceLanguage, setVoiceLanguage] = useState<'ja' | 'zh'>('ja')
  const [voiceLanguageOpen, setVoiceLanguageOpen] = useState(false)
  const [voiceCategory, setVoiceCategory] = useState<string>('all')
  const [voiceQuery, setVoiceQuery] = useState('')
  const [activeVoiceIndex, setActiveVoiceIndex] = useState(0)
  const [activeVoiceBankId, setActiveVoiceBankId] = useState('')
  const [pictureBankId, setPictureBankId] = useState('')
  const [pictureSpeaker, setPictureSpeaker] = useState('all')
  const audioRef = useRef<HTMLAudioElement | null>(null)
  useEffect(() => { if (audioRef.current) audioRef.current.volume = voiceVolume }, [voiceVolume])
  const lastVoiceRef = useRef(0)
  const interactionStateRef = useRef<InteractionState | null>(null)
  const interactionModelRef = useRef('')
  const commandSerialRef = useRef(0)
  const activeTrackSerialsRef = useRef(new Map<number, number>())
  const sourceUiCallbacksRef = useRef(new Map<number, { serial: number; token: string }>())
  const pendingPoseFollowUpRef = useRef<{ modelId: string; variantId: string; assetId: string; index: number | null; spine: string } | null>(null)
  const runPoseFollowUpRef = useRef<(assetId: string, idle: string | null) => Array<{ serial: number; effect: InteractionEffect }>>(() => [])
  const viewByVariantRef = useRef(new Map<string, ViewState>(initialState.variant
    ? [[initialState.variant, { zoom: initialState.zoom, pan: initialState.pan, flipped: initialState.flipped }]]
    : []))
  const currentViewVariantRef = useRef('')
  const latestViewRef = useRef<ViewState>({ zoom: initialState.zoom, pan: initialState.pan, flipped: initialState.flipped })
  const previousVariantRef = useRef<string | null>(null)

  const refreshCacheStatus = useCallback(() => {
    fetch('/api/cache-status')
      .then((response) => response.ok ? response.json() as Promise<{ packages: number; bytes: number }> : null)
      .then((data) => { if (data) setCacheStatus(data) })
      .catch(() => undefined)
  }, [])

  useEffect(() => {
    refreshCacheStatus()
    fetch('/api/manifest')
      .then((response) => {
        if (!response.ok) throw new Error(`清单请求失败：HTTP ${response.status}`)
        return response.json() as Promise<Manifest>
      })
      .then((data) => {
        setManifest(data)
        const requestedEntryId = data.entryAliases?.[initialState.entry] ?? initialState.entry
        const requestedVariantId = data.variantAliases?.[initialState.variant] ?? initialState.variant
        const oldEntryDefault = data.entryDefaultVariants?.[initialState.entry]
        const explicitVariant = new URLSearchParams(window.location.search).has('variant')
        const ownershipVariant = explicitVariant ? requestedVariantId : oldEntryDefault
          ?? (new URLSearchParams(window.location.search).has('entry') ? '' : requestedVariantId)
        const requested = data.entries.find((entry) => entry.variants.some((item) => item.id === ownershipVariant))
          ?? data.entries.find((entry) => entry.id === requestedEntryId)
          ?? data.entries.find((entry) => entry.category === 'character')
        if (requested) {
          setSelectedId(requested.id)
          setCategory(requested.category)
          const requestedIndex = requested.variants.findIndex((item) => item.id === requestedVariantId)
          const oldEntryIndex = requested.variants.findIndex((item) => item.id === oldEntryDefault)
          setVariantIndex(explicitVariant && requestedIndex >= 0
            ? requestedIndex
            : oldEntryIndex >= 0 ? oldEntryIndex : requestedIndex >= 0 ? requestedIndex : 0)
        }
      })
      .catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)))
    fetch('/api/display-names')
      .then((response) => response.ok ? response.json() as Promise<DisplayNamesManifest> : null)
      .then((data) => { if (data) setDisplayNames(data) })
      .catch(() => undefined)
    fetch('/api/voices')
      .then((response) => response.ok ? response.json() as Promise<VoiceManifest> : null)
      .then((data) => { if (data) setVoices(data) })
      .catch(() => undefined)
    fetch('/api/thumbnails')
      .then((response) => response.ok ? response.json() as Promise<ThumbnailManifest> : null)
      .then((data) => { if (data) setThumbnails(data) })
      .catch(() => undefined)
    fetch('/api/interactions')
      .then((response) => response.ok ? response.json() as Promise<InteractionManifest> : null)
      .then((data) => { if (data) setCharacterInteractions(data) })
      .catch(() => undefined)
    fetch('/api/multi-interactions')
      .then((response) => response.ok ? response.json() as Promise<MultiPictureActionManifest> : null)
      .then((data) => { if (data) setMultiActions(data) })
      .catch(() => undefined)
  }, [refreshCacheStatus])

  const interactions = useMemo<InteractionManifest | null>(() => {
    if (category !== 'cg') return characterInteractions
    if (!multiActions) return null
    return {
      models: multiActions.models,
      poses: multiActions.poses,
      display: multiActions.archive,
      interludeDefaults: multiActions.interludeDefaults,
    }
  }, [category, characterInteractions, multiActions])

  const galleryLabels = useMemo(() => buildGalleryLabels(manifest?.entries ?? [], displayNames, multiActions),
    [manifest, displayNames, multiActions])

  const entries = useMemo(() => {
    if (!manifest) return []
    const term = query.trim().toLocaleLowerCase()
    return manifest.entries.filter((entry) => {
      if (entry.category !== category) return false
      if (!term) return true
      return gallerySearchText(entry, galleryLabels[entry.id]).toLocaleLowerCase().includes(term)
    })
  }, [category, galleryLabels, manifest, query])

  useEffect(() => {
    if (entries.length && !entries.some((entry) => entry.id === selectedId)) {
      setSelectedId(entries[0].id)
      setVariantIndex(0)
    }
  }, [entries, selectedId])

  const [portraitId, setPortraitId] = useState(initialState.portrait)
  const portraitRecords = useRef<Record<string, number>>({})
  const selected = manifest?.entries.find((entry) => entry.id === selectedId) ?? entries[0]
  const selectedLabel = selected ? galleryLabels[selected.id] : null
  const portrait = selected?.portraits?.find((item) => item.modelId === portraitId) ?? (!selected?.variants.length ? selected?.portraits?.[0] : undefined)
  useEffect(() => { portraitRecords.current = {}; if (portrait) setStatus('静态原图 · 完整立绘') }, [portrait?.modelId])
  const variant = portrait ? undefined : selected?.variants[Math.min(variantIndex, Math.max(selected.variants.length - 1, 0))]
  useEffect(() => {
    if (previousVariantRef.current && variant?.id !== previousVariantRef.current) {
      setRawPreviewActive(false)
    }
    previousVariantRef.current = variant?.id ?? null
  }, [variant?.id])
  const selectedIllustrationId = useMemo(() => {
    if (variant?.archiveId) return variant.archiveId
    if (!selected || !variant || selected.category !== 'cg') return null
    const matches = Object.values(multiActions?.archive ?? {}).filter((item) =>
      item.entryMatches.some(([entryId, variantId]) => entryId === selected.id && variantId === variant.id))
    return matches.length === 1 ? matches[0].id : selectedLabel?.archiveId ?? null
  }, [multiActions, selected, selectedLabel?.archiveId, variant])
  const interactionBinding = useMemo(() => {
    if (!interactions || !selected || !variant) return null
    for (const [modelId, contract] of Object.entries(interactions.poses)) {
      const pose = Object.values(contract.poses).find((candidate) =>
        selected.variants[findPoseVariantIndex(selected.variants, candidate.l2dName)]?.id === variant.id)
      if (pose) return {
        modelId,
        role: pose.role,
        spine: pose.l2dName,
        rows: interactions.models[modelId] ?? [],
        space: pose.touchSpace ?? null,
        l2dPos: interactions.display[modelId]?.l2dPos ?? null,
      }
    }
    return null
  }, [interactions, selected, variant])
  const rawPreviewMode = Boolean(interactionBinding && rawPreviewActive)
  const previewHiddenSlots = rawPreviewMode && previewSlotOverride?.asset === variant?.id
    ? previewSlotOverride?.slots ?? NO_PREVIEW_STATES : NO_PREVIEW_STATES
  const hallConfig = interactionBinding ? hallEntries[interactionBinding.modelId] : undefined
  const hotspotIssues = useMemo(() => {
    const contract = interactionBinding && interactions?.poses[interactionBinding.modelId]
    return contract && interactionBinding ? inspectInteraction(interactionBinding.rows, contract) : []
  }, [interactionBinding, interactions])
  const hotspotCounts = interactionBinding && interactionState ? hotspotSummary(interactionBinding.rows, interactionState) : null
  const hotspotErrors = new Set(hotspotIssues.filter(issue => issue.level === 'error').map(issue => issue.row)).size
  const hotspotReviews = new Set(hotspotIssues.filter(issue => issue.level === 'review').map(issue => issue.row)).size
  const hotspotCorrections = category === 'cg' ? (multiActions?.corrections ?? [])
    .filter(correction => String(correction.modelId) === interactionBinding?.modelId)
    .map(correction => `#${correction.rowIndex} 已按安卓原配置更正；来源 ${correction.source.asset}（${correction.id}）`) : []
  const hallFallbackIdle = animations.find(name => /(^|_)idle(?:_?\d+)?($|_)/i.test(name))
    ?? animations.find(name => /stand|loop/i.test(name)) ?? animations[0] ?? ''
  const hallActualIdle = interactionState?.idle === 'idle' ? hallFallbackIdle : interactionState?.idle
  const hallReason = !hallConfig ? '游戏配置未声明大厅入场' : !animations.includes('in') ? '当前骨骼没有 in 动画'
    : !hallConfig.baseIdle ? '尚未确认原始待机' : interactionState?.role !== 1 ? '请先回到第一套姿态'
      : hallActualIdle !== hallConfig.baseIdle ? '请先通过游戏交互回到默认待机'
        : interactionState?.spineUi.open || interactionState?.dragging != null ? '请先结束当前小游戏或拖动'
          : rawPreviewMode ? '请先退出素材预览' : ''
  const rawPreviewInteraction = useMemo(() => interactionBinding ? {
    rows: [] as InteractionRow[],
    state: createInteractionState([], interactionBinding.spine, 'idle', interactionBinding.role),
    debug: false,
    space: interactionBinding.space,
    l2dPos: interactionBinding.l2dPos,
  } : null, [interactionBinding])
  const interactionAnimationInfo = useMemo(() => interactionAnimationCatalog(
    interactionBinding?.rows ?? [], interactionBinding?.role ?? 1,
  ), [interactionBinding])
  const interludeNames = useMemo(() => new Set(
    [characterInteractions, multiActions].flatMap(contract => Object.values(contract?.models ?? {})
      .flatMap(rows => rows.flatMap(row => row.poseSwitch ? [figureKey(row.poseSwitch.interludeSpine)] : []))),
  ), [characterInteractions, multiActions])
  const previewLayers = useMemo(() => separatePreviewLayers(variant?.effects ?? [], interludeNames), [variant, interludeNames])
  const stageEffects = previewLayers.attached
  useEffect(() => { setAuxiliaryPreview(null); setExpandedAction(null) }, [variant?.id, portrait?.modelId, view])

  useEffect(() => {
    if (!interactionBinding) {
      activeTrackSerialsRef.current.clear()
      interactionModelRef.current = ''
      interactionStateRef.current = null
      pendingPoseFollowUpRef.current = null
      setInterludeCommand(null)
      setInteractionState(null)
      return
    }
    if (pendingPoseFollowUpRef.current?.modelId !== interactionBinding.modelId) {
      pendingPoseFollowUpRef.current = null
    }
    const current = interactionStateRef.current
    const sameRuntimePose = interactionModelRef.current === interactionBinding.modelId
      && figureKey(current?.spine) === figureKey(interactionBinding.spine)
    if (sameRuntimePose) return
    const next = createInteractionState(
      interactionBinding.rows,
      interactionBinding.spine,
      'idle',
      interactionBinding.role,
    )
    interactionModelRef.current = interactionBinding.modelId
    interactionStateRef.current = next
    setInteractionState(next)
    setInteractionCommands([])
    activeTrackSerialsRef.current.clear()
    setInterludeCommand(null)
  }, [interactionBinding])

  useEffect(() => {
    latestViewRef.current = { zoom, pan, flipped }
  }, [flipped, pan, zoom])

  useEffect(() => {
    const nextId = variant?.id
    if (!nextId || currentViewVariantRef.current === nextId) return
    if (currentViewVariantRef.current) {
      viewByVariantRef.current.set(currentViewVariantRef.current, latestViewRef.current)
    }
    const nextView = viewByVariantRef.current.get(nextId) ?? defaultView()
    currentViewVariantRef.current = nextId
    latestViewRef.current = nextView
    setZoom(nextView.zoom)
    setPan(nextView.pan)
    setFlipped(nextView.flipped)
  }, [variant?.id])
  const motionAnimations = useMemo(
    () => interactionBinding ? animations : animations.filter((name) => !stateAnimations.includes(name)),
    [animations, interactionBinding, stateAnimations],
  )
  const displayStateAnimations = useMemo(
    () => interactionBinding
      ? stateAnimations.filter((name) => !interactionAnimationInfo.has(name))
      : stateAnimations,
    [interactionAnimationInfo, interactionBinding, stateAnimations],
  )
  const japaneseVoice = variant
    ? voices?.variantEntries?.[variant.id] ?? (selected ? voices?.entries[selected.id] : undefined)
    : portrait ? (selected ? voices?.entries[selected.id] : undefined) ?? Object.values(voices?.entries ?? {}).find((bank) => String(bank.roleId) === portrait.roleId) : undefined
  const chineseVoice = variant && japaneseVoice?.sourceGroup !== 'cv_skin'
    ? voices?.chineseVariantEntries?.[variant.id] ?? (selected ? voices?.chineseEntries?.[selected.id] : undefined)
    : portrait ? (selected ? voices?.chineseEntries?.[selected.id] : undefined) ?? Object.values(voices?.chineseEntries ?? {}).find((bank) => String(bank.roleId) === portrait.roleId) : undefined
  const pictureBanks = useMemo(() => cgPictureVoiceBanks(selected, variant, multiActions, voices), [selected, variant, multiActions, voices])
  const pictureVoice = pictureBanks.find(bank => bank.id === pictureBankId) ?? pictureBanks[0]
  const selectedVoice = category === 'cg' ? pictureVoice : voiceLanguage === 'zh' ? chineseVoice ?? japaneseVoice : japaneseVoice
  const pictureSpeakers = useMemo(() => [...new Map((pictureVoice?.streams ?? []).map(stream =>
    [pictureSpeakerId(stream), { id: pictureSpeakerId(stream), name: simplifyDisplay(pictureSpeakerName(stream, displayNames?.roleNames ?? {})) }])).values()], [pictureVoice, displayNames])
  const choosePictureBank = (id: string) => {
    audioRef.current?.pause(); audioRef.current = null
    setActiveVoiceIndex(0); setActiveVoiceBankId(''); setVoiceStatus('')
    setPictureBankId(id); setPictureSpeaker('all'); setVoiceCategory('all'); setVoiceQuery('')
  }
  const effectiveVoiceLanguage = voiceLanguage === 'zh' && chineseVoice ? '中配' : '日配'
  // RoleSpineItem2 passes the complete audioId to RoleAudioPlayMgr. A pose's
  // voice can live in a different skin bank than the one selected for the
  // archive panel, so resolve interaction cues across the local voice index.
  const interactionVoiceLookup = useMemo(() => {
    const lookup = new Map<number, { bank: VoiceBank; stream: VoiceStream }>()
    if (!voices) return lookup
    const japaneseBanks = [...Object.values(voices.entries), ...Object.values(voices.variantEntries ?? {}),
      ...Object.values(voices.auxiliaryEntries ?? {})]
    const chineseBanks = [...Object.values(voices.chineseEntries ?? {}), ...Object.values(voices.chineseVariantEntries ?? {})]
    for (const bank of effectiveVoiceLanguage === '中配' ? [...japaneseBanks, ...chineseBanks] : japaneseBanks) {
      for (const stream of bank.streams) {
        for (const id of [stream.semantic?.audioId, stream.interactionAudioId, ...(stream.interactionAudioIds ?? [])]) {
          if (id != null && (!lookup.has(id) || bank.sourceGroup === 'cv_cn')) lookup.set(id, { bank, stream })
        }
      }
    }
    if (multiActions) {
      for (const [id, location] of Object.entries(multiActions.audioLookup)) {
        const bank = voices.pictureEntries?.[location.bankId]
        const stream = bank?.streams.find((item) => item.index === location.streamIndex)
        if (bank && stream) lookup.set(Number(id), { bank, stream })
      }
    }
    return lookup
  }, [voices, multiActions, effectiveVoiceLanguage])
  const semanticStreams = useMemo(
    () => selectedVoice?.streams.filter((stream) => stream.semantic) ?? [],
    [selectedVoice],
  )
  const availableVoiceCategories = useMemo(
    () => {
      if (!selectedVoice) return []
      const categories: Array<readonly [string, string]> = [['all', '全部']]
      categories.push(...SEMANTIC_VOICE_CATEGORIES.filter(([id]) => semanticStreams.some((stream) => stream.semantic?.category === id)))
      if (selectedVoice.streams.some((stream) => !stream.semantic)) categories.push(['raw', '未识别'])
      return categories
    },
    [selectedVoice, semanticStreams],
  )
  const visibleVoiceStreams = useMemo(() => {
    if (!selectedVoice) return []
    let streams = selectedVoice.streams
    if (category === 'cg' && pictureSpeaker !== 'all') streams = streams.filter(stream => pictureSpeakerId(stream) === pictureSpeaker)
    if (voiceCategory === 'raw') streams = streams.filter((stream) => !stream.semantic)
    else if (voiceCategory !== 'all') streams = streams.filter((stream) => stream.semantic?.category === voiceCategory)
    const term = voiceQuery.trim().toLocaleLowerCase()
    if (!term) return streams
    // Search the simplified label as well as the raw one: the sound book is
    // traditional, so a query for `接触` would otherwise miss every `接觸` row.
    const foldText = category === 'cg' ? pictureVoiceText : simplifyDisplay
    return streams.filter((stream) => foldText(`${stream.name} ${stream.semantic?.label ?? ''} ${stream.semantic?.labelSimplified ?? ''} ${stream.semantic?.script ?? ''} ${category === 'cg' ? pictureSpeakerName(stream, displayNames?.roleNames ?? {}) : ''}`)
      .toLocaleLowerCase()
      .includes(foldText(term)))
  }, [selectedVoice, voiceCategory, voiceQuery, category, pictureSpeaker, displayNames])

  const voiceCategoryCount = useCallback((id: string) => {
    if (!selectedVoice) return 0
    if (id === 'all') return selectedVoice.streams.length
    if (id === 'raw') return selectedVoice.streams.filter((stream) => !stream.semantic).length
    return selectedVoice.streams.filter((stream) => stream.semantic?.category === id).length
  }, [selectedVoice])

  useEffect(() => {
    audioRef.current?.pause()
    audioRef.current = null
    lastVoiceRef.current = 0
    setActiveVoiceIndex(0)
    setVoiceStatus('')
    setVoiceCategory('all')
    setVoiceQuery('')
    setPictureBankId('')
    setPictureSpeaker('all')
    setActiveVoiceBankId('')
  }, [selectedId, variant?.id, portrait?.modelId, voiceLanguage, view])

  useEffect(() => {
    if (availableVoiceCategories.length && !availableVoiceCategories.some(([id]) => id === voiceCategory)) {
      setVoiceCategory(availableVoiceCategories[0][0])
    }
  }, [availableVoiceCategories, voiceCategory])

  const playVoiceStream = useCallback((stream: VoiceStream, animate = false, bank = selectedVoice) => {
    if (!bank) return
    lastVoiceRef.current = stream.index
    if (animate) {
      const clickAnimations = motionAnimations.filter((name) => /click|touch|tap/i.test(name))
      if (clickAnimations.length) {
        setAnimation(clickAnimations[Math.floor(Math.random() * clickAnimations.length)])
        if (interactionBinding) {
          setRawPreviewActive(true)
          setRawPreviewSerial((serial) => serial + 1)
          setPersistentStates([])
        }
      }
    }
    audioRef.current?.pause()
    const audio = new Audio(sitePath(`assets/voice/${encodeURIComponent(bank.id)}/${stream.index}.wav`))
    setPlayingLyric('')
    audioRef.current = audio
    audio.volume = voiceVolumeRef.current
    const voiceLabel = stream.semantic?.labelSimplified || stream.semantic?.label || stream.name
    const voiceScript = stream.semantic?.script
    setActiveVoiceIndex(stream.index)
    setActiveVoiceBankId(bank.id)
    if (category === 'cg' && pictureBanks.some(item => item.id === bank.id)) {
      setPictureBankId(bank.id)
      if (pictureVoice?.id !== bank.id) setPictureSpeaker('all')
    }
    setVoiceStatus(bank.sourceGroup === 'picture' ? '正在准备语音…' : `正在准备 ${voiceLabel}…`)
    audio.onplaying = () => {
      if (audioRef.current !== audio) return
      setPlayingLyric((bank.sourceGroup === 'picture' ? pictureVoiceText : simplifyDisplay)(voiceScript || '此语音暂无台词文本'))
      setVoiceStatus(bank.sourceGroup === 'picture'
        ? pictureVoicePlaybackText(stream)
        : `${voiceLabel} · ${voiceScript || stream.name} · ${stream.duration.toFixed(1)} 秒`)
    }
    audio.onended = () => {
      if (audioRef.current !== audio) return
      setActiveVoiceIndex(0)
      setVoiceStatus(stream.semantic?.category === 'touch'
        ? `点击立绘继续播放 · ${bank.streams.filter((item) => item.semantic?.category === 'touch').length} 条接触语音`
        : '可从语音档案继续选择台词')
    }
    audio.onerror = () => { if (audioRef.current === audio) { setActiveVoiceIndex(0); setVoiceStatus('语音解码失败') } }
    void audio.play().catch(() => { if (audioRef.current === audio) { setActiveVoiceIndex(0); setVoiceStatus('浏览器阻止了音频播放，请再点击一次') } })
  }, [interactionBinding, motionAnimations, selectedVoice, category, pictureBanks, pictureVoice?.id])

  const playVoice = useCallback(() => {
    if (!selectedVoice?.streams.length) return
    const touchLines = selectedVoice.streams.filter((stream) => stream.semantic?.category === 'touch')
    const conversational = selectedVoice.streams.filter((stream) => stream.duration >= .7 && stream.duration <= 8)
    const candidates = touchLines.length ? touchLines : conversational.length ? conversational : selectedVoice.streams
    const choices = candidates.filter((stream) => stream.index !== lastVoiceRef.current)
    const pool = choices.length ? choices : candidates
    const stream = pool[Math.floor(Math.random() * pool.length)]
    playVoiceStream(stream, true)
  }, [playVoiceStream, selectedVoice])

  const queueInteractionEffect = useCallback((effect: InteractionEffect) => {
    if (!['play', 'reset-actions', 'clear-tracks', 'change-idle', 'drag-start', 'drag-progress', 'drag-recover', 'object-restore'].includes(effect.type)) return
    const command = { serial: ++commandSerialRef.current, effect }
    if (effect.type === 'play') activeTrackSerialsRef.current.set(effect.track, command.serial)
    else if (effect.type === 'drag-progress') {
      const row = interactionBinding?.rows.find((row) => row.index === effect.rowIndex)
      // Moving a UI object does not create or replace a Spine TrackEntry.
      if (row && !row.content.drag) activeTrackSerialsRef.current.set(row.track, command.serial)
    }
    else if (effect.type === 'clear-tracks') {
      for (const track of effect.tracks) activeTrackSerialsRef.current.delete(track)
    }
    setInteractionCommands((current) => [...current.slice(-31), command])
    return command
  }, [interactionBinding])

  const runInteractionEffects = useCallback((effects: InteractionEffect[]) => {
    const commands: Array<{ serial: number; effect: InteractionEffect }> = []
    for (const effect of effects) {
      const command = queueInteractionEffect(effect)
      if (command) commands.push(command)
      if (effect.type === 'audio') {
        const local = selectedVoice?.streams.find((candidate) =>
          candidate.semantic?.audioId === effect.cue || candidate.interactionAudioId === effect.cue
          || candidate.interactionAudioIds?.includes(effect.cue))
        const resolved = local && selectedVoice
          ? { bank: selectedVoice, stream: local }
          : interactionVoiceLookup.get(effect.cue)
        if (resolved) playVoiceStream(resolved.stream, false, resolved.bank)
        else setVoiceStatus(`交互语音 ${effect.cue} 未在本地声库索引中解析`)
      } else if (effect.type === 'pose-interlude') {
        const asset = selected?.variants.flatMap((candidate) => [
          candidate.main, ...candidate.effects.map((item) => item.asset),
        ]).find((candidate) => figureKey(candidate.sourceName) === figureKey(effect.spine))
        const defaults = interactions?.interludeDefaults?.[effect.spine]
        if (asset && defaults) {
          setInterludeCommand({
            serial: ++commandSerialRef.current, asset,
            animation: defaults.animation, loop: defaults.loop, durationMs: effect.durationMs,
            ...latestViewRef.current,
          })
          setStatus(`正在播放姿态过场 ${effect.spine} · ${defaults.animation}…`)
        } else {
          setStatus(`姿态过场资源未解析：${effect.spine}`)
        }
      } else if (effect.type === 'load-pose' || effect.type === 'prepare-pose') {
        const localIndex = selected ? findPoseVariantIndex(selected.variants, effect.spine) : -1
        const targetEntry = localIndex >= 0 ? selected
          : selected?.category === 'cg'
            ? manifest?.entries.find((entry) => entry.category === 'cg'
              && findPoseVariantIndex(entry.variants, effect.spine) >= 0)
            : undefined
        const target = targetEntry ? findPoseVariantIndex(targetEntry.variants, effect.spine) : -1
        if (target >= 0 && targetEntry) {
          const targetVariant = targetEntry.variants[target]
          if (effect.type === 'prepare-pose') {
            void preparePoseAsset(targetVariant.main).catch(() => { /* The actual load reports failures. */ })
            continue
          }
          const pending = { modelId: interactionModelRef.current, variantId: targetVariant.id,
            assetId: targetVariant.main.id, index: effect.afterIndex, spine: effect.spine }
          pendingPoseFollowUpRef.current = pending
          // A Lua pose change continues the current viewing session. Do not
          // restore a view saved while browsing the destination independently.
          // Explicit clicks on variant buttons keep their per-variant history.
          viewByVariantRef.current.set(targetVariant.id, latestViewRef.current)
            // Commands addressed the discarded skeleton; a newly mounted
            // pose must only receive actions issued after its own load.
            setInteractionCommands([])
            activeTrackSerialsRef.current.clear()
            if (targetEntry.id !== selected?.id) setSelectedId(targetEntry.id)
            setVariantIndex(target)
        } else {
          setError(`姿态资源未出现在当前角色形态列表：${effect.spine}`)
        }
      } else if (effect.type === 'open-asmr') {
        setAsmrAlbumId(effect.id)
        setView('asmr')
      } else if (effect.type === 'open-spine-ui') {
        setStatus('该触点请求打开游戏内 Spine UI；本地查看器已记录此事件')
      }
    }
    return commands
  }, [interactionBinding, interactionVoiceLookup, interactions, manifest, playVoiceStream, queueInteractionEffect, selected, selectedVoice])

  const handleInteractionEvent = useCallback((event: InteractionEvent) => {
    const binding = interactionBinding
    const current = interactionStateRef.current
    if (!binding || !current) return
    if (event.type === 'track-progress' || event.type === 'track-complete' || event.type === 'track-callback'
      || event.type === 'track-abandoned' || event.type === 'multi-reset') {
      const track = event.type === 'multi-reset'
        ? binding.rows.find((row) => row.index === event.index)?.track
        : event.track
      if (track == null || (event.playSerial != null
        && activeTrackSerialsRef.current.get(track) !== event.playSerial)) return
      if (event.type !== 'track-progress' && event.type !== 'track-callback') {
        const callback = sourceUiCallbacksRef.current.get(track)
        if (callback && callback.serial === activeTrackSerialsRef.current.get(track)
          && event.type === 'track-complete') {
          window.dispatchEvent(new CustomEvent('source-ui-complete', { detail: callback.token }))
        }
        sourceUiCallbacksRef.current.delete(track)
        activeTrackSerialsRef.current.delete(track)
      }
    }
    const transition = reduceInteraction(binding.rows, current, event)
    const feedback = inputFeedback(binding.rows, event, transition)
    if (feedback) setInteractionFeedback(feedback)
    interactionStateRef.current = transition.state
    setInteractionState(transition.state)
    if (transition.accepted) {
      if (event.type === 'hall-frame' && current.hallEntry && !transition.state.hallEntry)
        setStatus('大厅入场结束 · 已恢复游戏交互')
      if (event.type === 'object-drop') {
        const played = transition.effects.find(effect => effect.type === 'play')
        const detail = event.diagnostic
        const result = event.cancelled ? '输入被取消，未播放'
          : played?.type === 'play' ? `已发出 ${played.animation}（轨道 ${played.track}）`
          : '未命中目标，未发出动画'
        setStatus(`拖放 #${event.index}：${result}；物件${detail?.objectFound ? '存在' : '缺失'}；移动回调 ${detail?.moves ?? '?'} 次；`
          + `位置 ${detail?.x?.toFixed(1) ?? '?'},${detail?.y?.toFixed(1) ?? '?'}；`
          + (detail?.targets.map(target => `${target.animation} 距离 ${target.distance.toFixed(2)}`).join(' / ') ?? '')
          + '（命中要求 <10）')
      }
      if (event.type === 'track-abandoned') {
        setStatus(`交互轨道 ${event.track} 与骨骼播放状态失同步，已自动恢复`)
      }
      runInteractionEffects(transition.effects)
      if (event.type === 'spine-event' && event.name === 'SpineUI') {
        setStatus(`${transition.state.spineUi.open ? '专用互动界面已开启' : '专用互动界面已关闭'} · ${event.animation ?? '未知动画'}`)
      }
    } else if (event.type === 'drag-begin') {
      setStatus(`拖动 #${event.index} 被拒绝：${transition.reason ?? '触点、待机或输入状态不允许'}；当前拖动 ${current.dragging ?? '无'}；主轨 ${current.tracks['1']?.animation ?? '空'}`)
    } else if (event.type === 'press') {
      const stage = (window as typeof window & { __interactionStage?: { tracks?: () => Array<{ track: number; animation: string | null; trackTime: number; duration: number | null; timeScale: number }> } }).__interactionStage
      const track = stage?.tracks?.().find((entry) => entry.track === 1)
      setStatus(`交互判定：命中 #${event.index}，${transition.reason ?? '当前无法触发'}${track ? `；Spine 主轨 ${track.animation} ${track.trackTime.toFixed(2)}/${track.duration?.toFixed(2) ?? '?'} 秒 ×${track.timeScale}` : ''}`)

    }
  }, [interactionBinding, runInteractionEffects])

  const handleSourceUiCommand = useCallback((command: SpineUiCommand) => {
    if (command.type === 'play' && command.index != null) {
      const row = interactionBinding?.rows.find(r => r.index === command.index)
      const before = row && activeTrackSerialsRef.current.get(row.track)
      handleInteractionEvent({ type: 'press', index: command.index, nowMs: performance.now(),
        internal: true, force: command.force, random: Math.random() })
      const serial = row && activeTrackSerialsRef.current.get(row.track)
      if (row && serial != null && serial !== before && command.token) sourceUiCallbacksRef.current.set(row.track, { serial, token: command.token })
    } else if (command.type === 'reset') {
      handleInteractionEvent({ type: 'ui-reset', indexes: command.indexes ?? [] })
    } else if (command.type === 'voice' && command.cue != null) {
      runInteractionEffects([{ type: 'audio', cue: command.cue, rowIndex: 0 }])
    }
  }, [handleInteractionEvent, interactionBinding, runInteractionEffects])

  useEffect(() => {
    runPoseFollowUpRef.current = (assetId, idle) => {
      const pending = pendingPoseFollowUpRef.current
      if (!pending || pending.assetId !== assetId || pending.variantId !== variant?.id
        || pending.modelId !== interactionBinding?.modelId) return []
      const state = interactionStateRef.current
      const rows = interactions?.models[pending.modelId]
      if (!state || !rows || figureKey(state.spine) !== figureKey(pending.spine)) return []
      // SetImg invokes PlayByIndex in the creation callback. Apply its commands
      // on the ready skeleton before its first render, not two frames later.
      pendingPoseFollowUpRef.current = null
      const result = completePoseLoad(rows, state, performance.now(), idle ?? undefined, pending.index)
      interactionStateRef.current = result.state
      setInteractionState(result.state)
      if (!result.accepted) setStatus(`姿态加载后续 #${pending.index} 被拒绝：${result.reason ?? '未知原因'}`)
      return runInteractionEffects(result.effects)
    }
  }, [interactionBinding?.modelId, interactions, runInteractionEffects, variant?.id])

  useEffect(() => {
    if (!interactionBinding || !interactionState) {
      delete (window as typeof window & { __interaction?: unknown }).__interaction
      return
    }
    ;(window as typeof window & { __interaction?: unknown }).__interaction = () => ({
      modelId: interactionBinding.modelId,
      role: interactionState.role,
      spine: interactionState.spine,
      idle: interactionState.idle,
      activeIndexes: Object.entries(interactionState.active).filter(([, active]) => active).map(([index]) => Number(index)),
      records: { ...interactionState.records },
      clickCounts: { ...interactionState.clickCounts },
      tracks: { ...interactionState.tracks },
      dragging: interactionState.dragging,
    })
  }, [interactionBinding, interactionState])

  const interactionPauseRef = useRef<{ model: string | undefined; at: number } | null>(null)
  useEffect(() => {
    if ((view !== 'gallery' || portrait || rawPreviewMode) && interactionStateRef.current?.hallEntry) {
      handleInteractionEvent({ type: 'hall-cancel' })
      audioRef.current?.pause()
    }
  }, [view, portrait, rawPreviewMode, handleInteractionEvent])
  useLayoutEffect(() => {
    const model = interactionBinding?.modelId
    if (!playing) {
      if (!interactionPauseRef.current || interactionPauseRef.current.model !== model)
        interactionPauseRef.current = { model, at: performance.now() }
    } else if (interactionPauseRef.current) {
      const paused = interactionPauseRef.current
      interactionPauseRef.current = null
      if (paused.model === model) handleInteractionEvent({ type: 'resume-clock', elapsedMs: performance.now() - paused.at })
    }
  }, [playing, interactionBinding?.modelId, handleInteractionEvent])

  useEffect(() => {
    const deadlines = [interactionState?.changeIdle?.atMs, interactionState?.pendingPoseLoad?.atMs].filter((v): v is number => v != null)
    if (!deadlines.length || !playing) return
    return scheduleDeadline(Math.min(...deadlines), nowMs => handleInteractionEvent({ type: 'tick', nowMs }))
  }, [handleInteractionEvent, interactionState?.changeIdle, interactionState?.pendingPoseLoad, playing])

  useEffect(() => {
    if (variant) setError('')
  }, [variant?.id])

  useEffect(() => {
    if (view === 'picture') return // The illustration page owns its archive-ID URL.
    if (!selected || (!variant && !portrait)) return
    const savedAnimation = portrait || (interactionBinding && !rawPreviewActive) ? '' : animation ?? ''
    const savedStates = portrait || (interactionBinding && !rawPreviewActive) ? '' : persistentStates.join(',')
    const state = {
      entry: selected.id,
      variant: variant?.id ?? '',
      portrait: portrait?.modelId,
      animation: savedAnimation,
      speed,
      effects: effectsVisible,
      states: savedStates,
      zoom,
      panX: pan.x,
      panY: pan.y,
      flipped,
    }
    localStorage.setItem(STATE_KEY, JSON.stringify(state))
    const previousParams = new URLSearchParams(window.location.search)
    const params = new URLSearchParams()
    for (const key of ['offlineShooting', 'offlineUi']) {
      if (previousParams.get(key) === '1') params.set(key, '1')
    }
    if (view !== 'gallery') params.set('view', view)
    params.set('entry', selected.id)
    if (portrait) params.set('portrait', portrait.modelId)
    else if (variant) params.set('variant', variant.id)
    if (savedAnimation) params.set('animation', savedAnimation)
    if (savedStates) params.set('states', savedStates)
    if (view === 'audit') {
      if (initialState.audit.autorun) params.set('autorun', '1')
      if (initialState.audit.shards > 1) params.set('shards', String(initialState.audit.shards))
      if (initialState.audit.shard > 0) params.set('shard', String(initialState.audit.shard))
      if (initialState.audit.retry) params.set('retry', initialState.audit.retry)
    }
    window.history.replaceState(null, '', `${window.location.pathname}?${params}`)
  }, [animation, effectsVisible, flipped, interactionBinding, pan, persistentStates, rawPreviewActive, selected, speed, variant, portrait, zoom, view])

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (auxiliaryPreview || layout.drawer || view !== 'gallery') return
      const target = event.target as HTMLElement | null
      if (target?.matches('input, select, textarea')) return
      if (event.code === 'Space') { event.preventDefault(); setPlaying((value) => !value) }
      if (event.key.toLowerCase() === 'f') setFlipped((value) => !value)
      if (event.key.toLowerCase() === 'e' && variant?.effects.length) setEffectsVisible((value) => !value)
      if (!layout.immersive.active || layout.immersive.adjustable) {
        if (event.key === '0') { setZoom(1); setPan({ x: 0, y: 0 }) }
        if (event.key === '+' || event.key === '=') setZoom((value) => Math.min(MAX_ZOOM, value + .1))
        if (event.key === '-') setZoom((value) => Math.max(MIN_ZOOM, value - .1))
      }
      if (event.key === 'ArrowLeft' && selected) { pendingPoseFollowUpRef.current = null; setVariantIndex((value) => Math.max(0, value - 1)) }
      if (event.key === 'ArrowRight' && selected) { pendingPoseFollowUpRef.current = null; setVariantIndex((value) => Math.min(selected.variants.length - 1, value + 1)) }
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [selected, variant, auxiliaryPreview, layout.drawer, view, layout.immersive.active, layout.immersive.adjustable])

  const chooseEntry = (entry: GalleryEntry) => {
    pendingPoseFollowUpRef.current = null
    if (layout.compact) layout.setLibraryOpen(false)
    setActionQuery('')
    setPortraitId('')
    setSelectedId(entry.id)
    setVariantIndex(0)
    setAnimations([])
    setOverlayAnimations([])
    setStateAnimations([])
    setPersistentStates([])
    setLayers([])
    setHiddenLayerIds([])
    setAnimation(null)
    setRawPreviewActive(false)
    setError('')
  }

  const receiveMetadata = useCallback((metadata: SpineMetadata) => {
    setAnimations(metadata.animations)
    setOverlayAnimations(metadata.overlayAnimations)
    setStateAnimations(metadata.stateAnimations)
    setLayers(metadata.layers)
    setPersistentStates((current) => current.filter((name) => metadata.stateAnimations.includes(name)))
    const motions = metadata.animations.filter((name) => !metadata.stateAnimations.includes(name))
    setAnimation((current) => current && metadata.animations.includes(current)
      ? current
      : motions.find((name) => /idle|stand|loop/i.test(name)) ?? motions[0] ?? null)
  }, [])
  const receiveRuntimeReady = useCallback((assetId: string, idle: string | null) => runPoseFollowUpRef.current(assetId, idle), [])
  const ignorePreviewMetadata = useCallback(() => undefined, [])
  useEffect(() => {
    setFocusedHotspot(null)
    setInteractionFeedback(null)
  }, [variant?.id, rawPreviewMode, interactionState?.role])
  const receiveStatus = useCallback((next: string) => {
    setStatus(next)
    if (next.startsWith('交互判定：未命中')) setInteractionFeedback({ title: '没有命中当前启用的热区，可从下方操作标签定位。', rejected: true })
    if (next.startsWith('Spine ')) refreshCacheStatus()
  }, [refreshCacheStatus])
  const receiveError = useCallback((next: string) => setError(next), [])

  const selectSection = (section: ContentSection) => {
    pendingPoseFollowUpRef.current = null
    if (section === 'character' || section === 'cg') {
      setCategory(section)
      setQuery('')
      setView('gallery')
    } else if (section === 'picture') {
      setView('picture')
    } else {
      setAsmrAlbumId(null)
      setView('asmr')
    }
  }

  const chooseAnimation = (name: string | null) => {
    if (interactionBinding) { setRawPreviewActive(Boolean(name)); setPersistentStates([]) }
    setRawPreviewSerial(serial => serial + 1)
    setAnimation(name)
  }
  const actionTag = (name: string) => {
    const info = interactionAnimationInfo.get(name)
    return interactionBinding ? info ? interactionAnimationLabel(info)
      : animationTriggers(interactionBinding.rows, name).length ? '配置关联'
      : stateAnimations.includes(name) ? '图层状态' : overlayAnimations.includes(name) ? '叠加' : '素材'
      : overlayAnimations.includes(name) ? '叠加' : '素材'
  }


  const tracks = interactionState ? Object.entries(interactionState.tracks) : []
  const viewingMaterial = !portrait && (rawPreviewMode || !interactionBinding)
  const modePhase = portrait ? '静态' : !playing ? '已暂停' : viewingMaterial ? '素材预览'
    : interactionState?.hallEntry ? '大厅入场' : interactionState?.pendingPoseLoad ? '切换中'
      : interactionState?.spineUi.open ? '专用互动' : tracks.some(([, value]) => value.playing) ? '播放中'
        : tracks.length ? '动作保留' : '待机'
  const modeName = portrait ? '静态立绘' : viewingMaterial ? animation || '未选择动作'
    : interactionState?.hallEntry ? '入场 → 游戏交互' : interactionState?.pendingPoseLoad ? '正在切换姿态'
      : interactionState?.spineUi.open ? '小游戏界面' : tracks.length ? [...new Set(tracks.map(([, value]) => value.animation))].join(' / ')
        : interactionState?.idle || '载入中'
  const feedbackRow = interactionBinding?.rows.find(row => row.index === interactionFeedback?.index)
  const recentTitle = error ? '载入失败' : interactionFeedback?.rejected
    ? `未触发${interactionFeedback.index != null ? ` · 热区 #${interactionFeedback.index}` : ''}`
    : interactionFeedback?.title.startsWith('已触发 ')
      ? `${interactionFeedback.index != null ? `热区 #${interactionFeedback.index} → ` : '已触发 '}${interactionFeedback.title.slice(4)}`
      : interactionFeedback?.title || '等待画面操作'
  const recentDetail = error || (interactionFeedback?.rejected ? interactionFeedback.title.replace(/^本次未触发：/, '')
    : interactionFeedback && feedbackRow?.content.changeIdle ? `随后切换待机 ${feedbackRow.content.changeIdle[0]}`
      : interactionFeedback && feedbackRow?.poseSwitch ? `目标姿态 ${feedbackRow.poseSwitch.targetRole}`
        : interactionFeedback ? '' : '从下方定位热区，在画面中操作。')
  const gameModeButton = interactionBinding && <button className="gallery-game-mode-button" aria-pressed={!rawPreviewMode} disabled={Boolean(interactionState?.hallEntry)}
        title={rawPreviewMode ? '返回可点击、拖动的游戏交互' : '游戏交互已开启；点击切换到素材预览'}
        onClick={() => chooseAnimation(rawPreviewMode ? null : animation || interactionState?.idle || motionAnimations[0] || null)}>
        {rawPreviewMode ? '游戏交互 关' : '游戏交互 开'}</button>
  const currentModePanel = <div className="gallery-mode-status" aria-label="当前播放状态">
    <div className="gallery-mode-heading"><small>当前状态</small><span>{modePhase}</span>

    </div>
    <strong className="gallery-mode-name" title={modeName}>{modeName}</strong>
    {!portrait && <div className="gallery-mode-controls">
      {gameModeButton}
      {interactionBinding && <button className="raw-preview-replay gallery-hall-entry"
              disabled={!interactionState?.hallEntry && Boolean(hallReason)}
              title={interactionState?.hallEntry ? '跳过并恢复游戏交互' : hallReason || '重播原配置入场动作与语音；部分原生粒子转场暂不支持'}
              onClick={() => {
                if (interactionStateRef.current?.hallEntry) { handleInteractionEvent({ type: 'hall-exit' });return }
                if (!hallConfig?.baseIdle || hallReason) return
                audioRef.current?.pause()
                setPlaying(true)
                handleInteractionEvent({ type: 'hall-enter', baseIdle: hallConfig.baseIdle,
                  fallbackIdle: hallFallbackIdle,
                  clearTracks: hallConfig.clearTracks, audio: hallConfig.audio, rowIndex: hallConfig.index, random: Math.random() })
                setStatus('大厅入场 · 点击画面或按“跳过入场”结束，随后恢复交互')
              }}>{interactionState?.hallEntry ? '跳过入场' : '重播入场'}</button>}
      {rawPreviewMode && animation && <button onClick={() => setRawPreviewSerial(serial => serial + 1)}>重播当前素材</button>}
    </div>}
    <div className="gallery-mode-details">
      <button type="button" aria-expanded={modeDetailsOpen} onClick={() => setModeDetailsOpen(open => !open)}>{modeDetailsOpen ? '▾' : '▸'} 状态详情</button>
      {modeDetailsOpen && <div><strong>{portrait ? '静态立绘' : viewingMaterial ? '素材预览' : '游戏交互'}</strong>
          <p>{modeName}</p>
          {!viewingMaterial && interactionState && <><p>姿态 {interactionState.role} · 待机 {interactionState.idle}</p>
            {tracks.map(([track, value]) => <p key={track}>轨道 {track} · {value.animation} · {value.playing ? '播放中' : '停点／保留'} · {Math.round(value.progress * 100)}%</p>)}</>}
        </div>}
    </div>
  </div>

  const filteredAnimations = motionAnimations.filter(name => name.toLowerCase().includes(actionQuery.toLowerCase()))
  const actionTools = <>
            <input className="gallery-action-search" aria-label="搜索动作" placeholder="搜索动作名称" value={actionQuery} onChange={e => { setActionQuery(e.target.value); setFocusedHotspot(null) }}/>
            <p className="gallery-tool-note">点动作名称直接预览；右侧“指引”查看触发方法。</p>
            <div className="gallery-action-list gallery-action-guide-list">{filteredAnimations.map(name => <article key={name} className={animation === name && (!interactionBinding || rawPreviewMode) ? 'selected' : ''}>
              <div className="gallery-action-row">
                <button className="gallery-action-play" aria-label={`预览动作 ${name}`} disabled={Boolean(interactionState?.hallEntry) || Boolean(portrait)}
                  onClick={() => { setFocusedHotspot(null); chooseAnimation(name) }} title="直接播放素材预览，不执行交互前置条件或语音">
                  <code>▷ {name}</code><small>{actionTag(name)}</small>
                </button>
                <button className="gallery-action-guide-toggle" aria-label={`触发指引 ${name}`} aria-expanded={expandedAction === name}
                  onClick={() => { setExpandedAction(expandedAction === name ? null : name); setFocusedHotspot(null) }}>指引 {expandedAction === name ? '▾' : '▸'}</button>
              </div>
              {expandedAction === name && <div className="gallery-action-expanded">
                <ActionTriggerGuide animation={name} rows={interactionBinding?.rows ?? []} state={interactionState} hallEntry={Boolean(hallConfig)}
                  canLocate={!rawPreviewMode && Boolean(interactionState) && !interactionState?.hallEntry && !interactionState?.spineUi.open && !interactionState?.pendingPoseLoad}
                  onLocate={setFocusedHotspot}/>
              </div>}
            </article>)}{!filteredAnimations.length && <p className="gallery-empty">{motionAnimations.length ? '没有匹配的动作，试试其他关键词。' : portrait ? '当前为静态立绘' : '暂无可播放动作'}</p>}</div>
  </>
  const voiceTools = <GalleryVoiceTools bank={selectedVoice} streams={visibleVoiceStreams} categories={availableVoiceCategories} category={voiceCategory} onCategory={setVoiceCategory} count={voiceCategoryCount} query={voiceQuery} onQuery={setVoiceQuery} active={activeVoiceBankId === selectedVoice?.id ? activeVoiceIndex : 0} canStop={activeVoiceIndex !== 0} onPlay={stream => playVoiceStream(stream)} onStop={() => { audioRef.current?.pause(); audioRef.current = null; setActiveVoiceIndex(0); setVoiceStatus('语音已停止') }} language={voiceLanguage} hasChinese={Boolean(chineseVoice)} onLanguage={setVoiceLanguage} sourceNote={category === 'cg' ? selectedVoice ? `游戏档案关联声库 · ${selectedVoice.sourceFile}` : '暂无已确认的档案声库关联' : selectedVoice ? labelSourceNote(selectedVoice) : ''} volume={voiceVolume} onVolume={setVoiceVolume}
              picture={category === 'cg' ? { banks: pictureBanks, onBank: choosePictureBank, speaker: pictureSpeaker, onSpeaker: setPictureSpeaker, speakers: pictureSpeakers, roleNames: displayNames?.roleNames ?? {} } : undefined}/>
  const formTools = <div className="chip-row">
              {selected?.portraits?.map((item) => <button key={item.modelId}
                className={portrait?.modelId === item.modelId ? 'active' : ''}
                onClick={() => { setPortraitId(item.modelId); setRawPreviewActive(false); setAnimations([]); setOverlayAnimations([]); setStateAnimations([]); setPersistentStates([]); setLayers([]); setAnimation(null); setError(''); setZoom(1); setPan({ x: 0, y: 0 }); setStatus('静态原图 · 点击配置区域播放语音') }}>
                {item.label}
              </button>)}
              {selected?.variants.map((item, index) => (
                <button
                  key={item.id}
                  className={!portrait && index === variantIndex ? 'active' : ''}
                  onClick={() => { pendingPoseFollowUpRef.current = null; setPortraitId(''); setVariantIndex(index); setRawPreviewActive(false); setAnimations([]); setOverlayAnimations([]); setStateAnimations([]); setPersistentStates([]); setLayers([]); setHiddenLayerIds([]); setAnimation(null); setError('') }}
                >
                  {item.label}
                </button>
              ))}
            </div>

  if (view === 'asmr') {
    return <Suspense fallback={<BootFallback />}><AsmrStage navigate={setView}
      onSelectSection={selectSection} initialAlbumId={asmrAlbumId}
      roleNames={displayNames?.roleNames ?? {}} /></Suspense>
  }
  if (view === 'picture') {
    return <Suspense fallback={<BootFallback />}><IllustrationStage navigate={setView}
      onSelectSection={selectSection} gallery={manifest}
      roleNames={displayNames?.roleNames ?? {}} /></Suspense>
  }
  if (view === 'audit') {
    return <Suspense fallback={<BootFallback />}><AuditStage navigate={setView} options={initialState.audit} /></Suspense>
  }

  return (
    <ImmersiveContext.Provider value={layout.immersive}><div ref={layout.root} className={`app-shell gallery-shell ${layout.immersive.active ? 'immersive-active' : ''} ${category === 'cg' ? 'gallery-cg' : 'gallery-character'} ${layout.libraryOpen ? '' : 'library-closed'} ${layout.toolsOpen ? '' : 'tools-closed'}`}>
      <ImmersiveTools mode={layout.immersive} playing={playing} onPlay={portrait ? undefined : () => setPlaying(v => !v)} debug={interactionDebug} onDebug={interactionBinding && !rawPreviewMode ? () => setInteractionDebug(v => !v) : undefined}
        subtitles={floatingLyrics} onSubtitles={() => setFloatingLyrics(v => !v)}
        subtitlesPassthrough={lyricsPassthrough} onSubtitlesPassthrough={() => setLyricsPassthrough(v => !v)} onResetSubtitles={() => setLyricsReset(v => v + 1)}
        primaryControls={!portrait && <>{gameModeButton}<label className="immersive-speed">速度 <select aria-label="沉浸播放速度" value={speed} onChange={e => setSpeed(Number(e.target.value))}>
          <option value={0.5}>0.5×</option><option value={1}>1.0×</option><option value={1.5}>1.5×</option><option value={2}>2.0×</option>
        </select></label></>}
        moreControls={<>{currentModePanel}<button aria-pressed={flipped} onClick={() => setFlipped(v => !v)}>水平翻转</button></>}
        onPanelChange={() => setFocusedHotspot(null)}
        panels={[
          { id: 'forms', title: '形态', content: <div className="immersive-forms"><p>{selectedLabel?.primary} · 选择形态</p>{formTools}</div> },
          { id: 'actions', title: '动作与指引', content: <><div className="immersive-current">{modePhase} · {modeName}</div>{actionTools}</> },
          { id: 'voices', title: '台词列表', content: voiceTools },
        ]}/>

      <GalleryTopbar active={category} onSelect={selectSection}/>
      <div className="gallery-mobilebar"><button aria-label="选择资源" aria-expanded={layout.libraryOpen} onClick={() => { layout.setLibraryOpen(!layout.libraryOpen); if (layout.landscape) layout.setToolsOpen(false) }}>☰ 资源{isPublicPreview && ' · 非官方'} <span>{selectedLabel?.primary}</span></button><button onClick={() => layout.showTools('interaction')}>交互</button><button onClick={() => layout.showTools('actions')}>动作</button><button onClick={() => layout.showTools('voices')}>台词</button></div>
      {layout.drawer && <button className="gallery-scrim" aria-label="关闭面板" onClick={() => { layout.setLibraryOpen(false); if (layout.landscape) layout.setToolsOpen(false) }}/>}

      <aside className="library-panel">
        <button className="gallery-rail" aria-label="展开资源栏" onClick={() => layout.setLibraryOpen(true)}>☰<span>资源</span></button>
        <div className="gallery-library-heading"><strong>{category === 'character' ? '角色资源' : 'CG 资源'} <small>{category === 'character' ? manifest?.characterCount : manifest?.cgCount}</small></strong><button aria-label="收起资源栏" onClick={() => layout.setLibraryOpen(false)}>◧</button></div>
        <label className="search-box">
          <span>⌕</span>
          <input value={query} onChange={(event) => setQuery(event.target.value)} aria-label="搜索资源" placeholder="搜索名称 / ID / 形态" />
        </label>

        <div className="entry-count">{entries.length} 个条目</div>
        {cacheStatus && <div className="cache-note">本地缓存 {cacheStatus.packages} 包 · {formatBytes(cacheStatus.bytes)}</div>}
        <section className={`entry-list ${category === 'cg' ? 'cg-entry-list' : ''}`}>
          {entries.map((entry) => (
            <button
              className={`entry-card ${entry.id === selected?.id ? 'selected' : ''}`}
              key={entry.id}
              title={`${galleryLabels[entry.id].primary}${galleryLabels[entry.id].secondary ? ` · ${galleryLabels[entry.id].secondary}` : ''} · ${entry.characterIds.join(' · ') || 'CG'} · ${entry.variants.length + (entry.portraits?.length ?? 0)} 形态`}
              onClick={() => chooseEntry(entry)}
            >
              <span className="entry-monogram">
                {thumbnails?.entries[entry.id]
                  ? <img src={sitePath(`assets/${thumbnails.entries[entry.id].path}`)} alt="" loading="lazy" />
                  : entry.portraits?.[0] ? <img src={sitePath(entry.portraits[0].url) + '?thumbnail=1'} alt="" loading="lazy" style={{ objectFit: 'contain' }} /> : galleryLabels[entry.id].primary.slice(0, 2).toUpperCase()}
              </span>
              <span className="entry-copy">
                <strong>{galleryLabels[entry.id].primary}</strong>
                <small>{galleryLabels[entry.id].secondary ? `${galleryLabels[entry.id].secondary} · ` : ''}
                  {entry.characterIds.join(' · ') || 'CG'} · {entry.variants.length + (entry.portraits?.length ?? 0)} 形态</small>
              </span>
              <span className="entry-arrow">›</span>
            </button>
          ))}
          {manifest && !entries.length && <p className="gallery-empty">没有匹配的资源，试试其他关键词。</p>}
        </section>
      </aside>

      <section className="viewer-panel">
        <header className="viewer-header">
          <div>
            <span className="eyebrow">{category === 'character' ? 'CHARACTER PROFILE' : 'CG SPINE RESOURCE'}</span>
            <h2 title={selectedLabel?.primary}>{selectedLabel?.primary ?? '载入中'}</h2>
            {(selectedLabel?.secondary || variant) && <p title={[selectedLabel?.secondary, variant && `Spine ${variant.main.spineVersion}`].filter(Boolean).join(' · ')}>
              {selectedLabel?.secondary}{selectedLabel?.secondary && variant && ' · '}
              {variant && <span className="viewer-header-meta">Spine {variant.main.spineVersion}</span>}
            </p>}
          </div>
          <div className="viewer-header-actions">
            {selectedIllustrationId != null && <button className="viewer-header-secondary" onClick={() => {
              const params = new URLSearchParams(window.location.search)
              params.set('view', 'picture')
              params.set('illustration', `archive:${selectedIllustrationId}`)
              window.history.replaceState(null, '', `${window.location.pathname}?${params}`)
              setView('picture')
            }}>在插画档案中查看 ↗</button>}
            <ImmersiveEntry onEnter={layout.immersive.enter} disabled={!variant && !portrait}/>
          </div>
        </header>

        <div className="stage-wrap">
          <FloatingLyrics visible={floatingLyrics && activeVoiceIndex !== 0} text={playingLyric} passthrough={lyricsPassthrough} resetSerial={lyricsReset}/>
          {interludeCommand && !rawPreviewMode && <PoseInterlude command={interludeCommand} playing={playing} speed={speed}
            onDone={serial => setInterludeCommand(current => current?.serial === serial ? null : current)} onError={receiveError} />}
          {interactionBinding && interactionState?.spineUi.open && supportsSpineUi(interactionBinding.modelId)
            && <div style={{ display: rawPreviewMode ? 'none' : 'contents' }}><SpineUiHost key={`${interactionBinding.modelId}:${interactionState.spineUi.openedAtMs}`}
              model={interactionBinding.modelId} idle={!interactionState.tracks['1']} playing={playing && !rawPreviewMode}
              multiTracks={interactionState.tracks}
              speed={speed}
              rolePosition={interactionBinding.l2dPos ?? [0, 0, 1]}
              onCommand={handleSourceUiCommand} onError={receiveError} /></div>}
          <div className="stage-grid" />
          {portrait && <CharacterPortraitStage key={portrait.modelId} portrait={portrait} flipped={flipped} zoom={zoom} pan={pan} onPan={setPan} onZoom={setZoom}
            onTouch={(row) => {
              if (audioRef.current && !audioRef.current.ended && !audioRef.current.paused) return
              const ids = row.audioId ?? []
              const key = `${portrait.modelId}:${row.index}`
              const index = portraitRecords.current[key] ?? 0
              const id = ids[index % ids.length]
              const resolved = interactionVoiceLookup.get(id)
              if (!resolved) { setVoiceStatus('该触点配置的语音在当前资源中不可用'); return }
              portraitRecords.current[key] = index + 1
              playVoiceStream(resolved.stream, false, resolved.bank)
            }} /> }
          {variant && (
            <div className={`stage-runtime ${rawPreviewMode ? 'stage-runtime-hidden' : ''} ${interactionState?.spineUi.open && interactionBinding && supportsSpineUi(interactionBinding.modelId) ? 'source-ui-running' : ''}`}>
              <SpineStage
                key={`${variant.id}:${retryKey}`}
                asset={variant.main}
                effects={stageEffects}
                animation={interactionBinding ? null : animation}
                playing={playing}
                speed={speed}
                effectsVisible={effectsVisible}
                flipped={flipped}
                zoom={zoom}
                pan={pan}
                persistentStates={interactionBinding ? NO_PREVIEW_STATES : persistentStates}
                hiddenLayerIds={hiddenLayerIds}
                onZoomChange={setZoom}
                onPanChange={setPan}
                onMetadata={receiveMetadata}
                onRuntimeReady={receiveRuntimeReady}
                onStatus={receiveStatus}
                onError={receiveError}
                onActivate={category !== 'cg' && selectedVoice ? playVoice : undefined}
                interaction={interactionBinding && interactionState
                  ? { rows: interactionBinding.rows, state: interactionState, debug: interactionDebug, showAll: showAllHotspots,
                    focusIndex: interactionState.hallEntry || interactionState.spineUi.open || interactionState.pendingPoseLoad ? null : focusedHotspot,
                    space: interactionBinding.space, l2dPos: interactionBinding.l2dPos }
                  : null}
                interactionCommands={interactionCommands}
                previewResetSerial={interactionBinding ? 0 : rawPreviewSerial}
                onInteractionEvent={handleInteractionEvent}
                showGuides={false}
              />
            </div>
          )}
          {variant && rawPreviewMode && rawPreviewInteraction && (
            <div className="stage-runtime">
              <SpineStage
                key={`raw:${variant.id}:${retryKey}:${previewHiddenSlots.join('|')}`}
                asset={variant.main}
                effects={stageEffects}
                animation={animation}
                loopAnimation={false}
                probeKey="__rawPreviewStage"
                previewHiddenSlots={previewHiddenSlots}
                playing={playing}
                speed={speed}
                effectsVisible={effectsVisible}
                flipped={flipped}
                zoom={zoom}
                pan={pan}
                persistentStates={persistentStates}
                previewResetSerial={rawPreviewSerial}
                hiddenLayerIds={hiddenLayerIds}
                onZoomChange={setZoom}
                onPanChange={setPan}
                onMetadata={ignorePreviewMetadata}
                onStatus={receiveStatus}
                onError={receiveError}
                interaction={rawPreviewInteraction}
              />
            </div>
          )}
          {previewHiddenSlots.length > 0 && <div className="preview-slot-debug" role="status">
            <span>调试预览 · 隐藏槽位：{previewHiddenSlots.join('、')}</span>
            <button onClick={() => setPreviewSlotOverride(null)}>恢复原始显示</button>
          </div>}
          {!variant && !portrait && !error && <div className="empty-state">正在建立本地图鉴…</div>}
          {error && (
            <div className="error-state">
              <strong>载入失败</strong><span>{error}</span>
              <button onClick={() => { setError(''); setRetryKey((value) => value + 1) }}>重新载入</button>
            </div>
          )}
          <div className="stage-corner top-left" />
          <div className="stage-corner top-right" aria-hidden="true" />
          <div className="stage-corner bottom-left" aria-hidden="true" />
          <div className="stage-corner bottom-right" />
        </div>

        <footer className="control-deck">
          <div className="variant-strip">
            <span className="control-label">形态</span>
            {formTools}
          </div>

          <GalleryToolbar items={[
            { id: 'play', minWidth: 0, node: (<button className="play-button" disabled={Boolean(portrait)} onClick={() => setPlaying((value) => !value)} aria-label={playing ? '暂停' : '播放'}>
              {playing ? 'Ⅱ' : '▶'}
            </button>) },
            { id: 'auxiliary', minWidth: 99999, node: (!portrait && previewLayers.auxiliary.length > 0 && <label className="action-select">
              <span>辅助素材</span>
              <select aria-label="独立预览辅助素材" value="" disabled={Boolean(interactionState?.hallEntry)} onChange={event => {
                const state = interactionStateRef.current
                if (state && performance.now() < state.interludeUntilMs) {
                  setStatus('请等待姿态过场结束后再预览辅助素材'); return
                }
                const item = previewLayers.auxiliary.find(layer => layer.asset.id === event.target.value)
                if (item) { audioRef.current?.pause(); setAuxiliaryPreview(item.asset) }
              }}>
                <option value="">选择素材单独查看…</option>
                {previewLayers.auxiliary.map(item => <option key={item.asset.id} value={item.asset.id}>{item.asset.sourceName}</option>)}
              </select>
            </label>) },
            { id: 'speed', minWidth: 280, node: (<label className="speed-select">
              <select aria-label="播放速度" disabled={Boolean(portrait)} value={speed} onChange={(event) => setSpeed(Number(event.target.value))}>
                <option value={0.5}>0.5×</option>
                <option value={1}>1.0×</option>
                <option value={1.5}>1.5×</option>
                <option value={2}>2.0×</option>
              </select>
            </label>) },
            { id: 'zoom', minWidth: 440, node: (<><button title="缩小（-）" onClick={() => setZoom((value) => Math.max(MIN_ZOOM, value - .1))} aria-label="缩小">−</button>
              <button title="重置视图（0）" onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }) }} aria-label="重置视图">{Math.round(zoom * 100)}%</button>
              <button title="放大（+）" onClick={() => setZoom((value) => Math.min(MAX_ZOOM, value + .1))} aria-label="放大">＋</button></>) },
            { id: 'flip', minWidth: 740, node: (<button title="水平翻转（F）" className={flipped ? 'active' : ''} onClick={() => setFlipped((value) => !value)} aria-label="水平翻转">↔</button>) },
            { id: 'effects', minWidth: 99999, node: (variant && stageEffects.length > 0 && (
                <button title="切换特效层（E）" className={effectsVisible ? 'active' : ''} onClick={() => setEffectsVisible((value) => !value)} aria-label="切换特效层">
                  FX {stageEffects.length}
                </button>
              )) },
            { id: 'cv', minWidth: 620, node: (selectedVoice && category !== 'cg' && (
                <div className="cv-language-control">
                  <button title={`当前${effectiveVoiceLanguage}，点击切换配音`} className={voiceLanguageOpen ? 'active' : ''}
                    onClick={() => setVoiceLanguageOpen((value) => !value)} aria-label="选择配音语言"
                    aria-expanded={voiceLanguageOpen} aria-haspopup="true">
                    CV {effectiveVoiceLanguage} ▾
                  </button>
                  {voiceLanguageOpen && <div className="cv-language-menu" role="group" aria-label="配音语言">
                    <button className={voiceLanguage === 'ja' ? 'active' : ''}
                      onClick={() => { setVoiceLanguage('ja'); setVoiceLanguageOpen(false) }}>日配</button>
                    <button className={voiceLanguage === 'zh' ? 'active' : ''} disabled={!chineseVoice}
                      title={chineseVoice ? `${chineseVoice.streamCount} 条中配音轨` : '该角色或形态没有本地中配资源'}
                      onClick={() => { setVoiceLanguage('zh'); setVoiceLanguageOpen(false) }}>中配{chineseVoice ? '' : ' · 暂无'}</button>
                    <button onClick={() => { playVoice(); setVoiceLanguageOpen(false) }}>随机播放</button>
                  </div>}
                </div>
              )) },
            { id: 'lyrics', minWidth: 0, node: (selectedVoice && (
                <button title="显示或隐藏画布上的台词；选句试听请使用右侧台词栏" className={floatingLyrics ? 'active' : ''} aria-pressed={floatingLyrics} onClick={() => setFloatingLyrics(v => !v)} aria-label="悬浮台词">
                  台词
                </button>
              )) },
            { id: 'hotspots', minWidth: 0, node: (interactionBinding && (
                <button
                  title="显示当前启用的热区；已启用数 / 全配置数。交互提示中可开启全部热区并查看明细。"
                  className={interactionDebug ? 'active' : ''}
                  onClick={() => setInteractionDebug((value) => !value)}
                  aria-label="显示交互热区"
                >
                  热区 {hotspotCounts ? `${hotspotCounts.enabled}/${hotspotCounts.total}` : `—/${interactionBinding.rows.filter(row => row.hittable).length}`}
                  {hotspotErrors || hotspotReviews ? ' !' : ''}
                </button>
              )) },
            { id: 'lyrics-pass', minWidth: Infinity, node: <button aria-pressed={lyricsPassthrough} onClick={() => setLyricsPassthrough(v => !v)} title="开启后点击和拖拽传给角色；关闭后可直接拖动字幕框">字幕点击穿透 {lyricsPassthrough ? '开' : '关'}</button> },
            { id: 'lyrics-reset', minWidth: Infinity, node: <button onClick={() => setLyricsReset(v => v + 1)}>字幕位置复位</button> },
          ]}/>
        </footer>

      </section>
      <aside className="gallery-tools" aria-label="交互、动作与台词"><button className="gallery-rail" aria-label="展开查看工具" onClick={() => layout.setToolsOpen(true)}>◧<span>查看工具</span></button>
        <div className="gallery-tool-content"><div className="gallery-tabs" role="tablist" aria-label="查看内容"><button role="tab" id="gallery-interaction-tab" aria-controls="gallery-interaction" aria-selected={layout.tab === 'interaction'} onClick={() => layout.setTab('interaction')}>交互指引</button><button role="tab" id="gallery-actions-tab" aria-controls="gallery-actions" aria-selected={layout.tab === 'actions'} onClick={() => layout.setTab('actions')}>动作素材 <small>{motionAnimations.length}</small></button><button role="tab" id="gallery-voices-tab" aria-controls="gallery-voices" aria-selected={layout.tab === 'voices'} onClick={() => layout.setTab('voices')}>台词 <small>{selectedVoice?.streamCount ?? 0}</small></button><button aria-label="收起工具栏" onClick={() => layout.setToolsOpen(false)}>◧</button></div>
          <div className="gallery-shared-status" hidden={layout.tab === 'voices'}>{currentModePanel}</div>
          <section id="gallery-interaction" role="tabpanel" aria-labelledby="gallery-interaction-tab" hidden={layout.tab !== 'interaction'} className="gallery-tool-page gallery-interaction-tab">
          <div className="gallery-interaction-page">
          <div className={`gallery-interaction-feedback ${error || interactionFeedback?.rejected ? 'feedback-rejected' : interactionFeedback ? 'feedback-accepted' : ''}`}>
            <h3>最近操作</h3>
            <div className="gallery-feedback-result" title={recentTitle}><span className="gallery-feedback-dot" aria-hidden="true"/><span>{recentTitle}</span></div>
            <p className="gallery-feedback-followup" title={recentDetail}>{recentDetail || '\u00a0'}</p>
          </div>
          <div className="gallery-interaction-body">

          <div>{rawPreviewMode ? <p className="gallery-preview-note">素材预览与游戏交互状态隔离；预览隐藏动作不会解锁游戏条件。</p> : interactionBinding && interactionState ?
            <InteractionHelp key={`${interactionBinding.modelId}:${interactionState.role}:${interactionState.spine}`} rows={interactionBinding.rows} state={interactionState}
              onShowActions={() => layout.setTab('actions')} active={layout.tab === 'interaction' && layout.toolsOpen} showAll={interactionDebug && showAllHotspots} onShowAll={value => { setShowAllHotspots(value); setInteractionDebug(true) }} onLocate={setFocusedHotspot}/>
            : <p className="gallery-preview-note">{portrait ? '静态原图；已配置的触点可播放语音。' : '当前资源没有游戏交互配置，可从动作列表预览。'}</p>}
            {interactionBinding && interactionState && !rawPreviewMode && <GalleryHotspotDetails rows={interactionBinding.rows} state={interactionState} issues={hotspotIssues} corrections={hotspotCorrections}/>}
          </div>
          <details className="interaction-runtime-details"><summary>技术反馈</summary><p>{status}</p><p>{voiceStatus}</p><p>{interactionFeedback?.title}</p></details>
          </div>
          </div>
        </section>
          <section id="gallery-actions" role="tabpanel" aria-labelledby="gallery-actions-tab" hidden={layout.tab !== 'actions'} className="gallery-tool-page">
            {!layout.immersive.active && actionTools}
            <details className="gallery-layer-controls"><summary>图层与叠加状态</summary>
          {(layers.length > 1 || displayStateAnimations.length > 0) && (
            <div className="inspector-strip">
              {layers.length > 1 && (
                <div className="inspector-group">
                  <span className="control-label">图层</span>
                  {layers.map((layer) => {
                    const hidden = hiddenLayerIds.includes(layer.id)
                    return (
                      <button
                        key={layer.id}
                        className={hidden ? '' : 'active'}
                        title={layer.label}
                        onClick={() => setHiddenLayerIds((current) => hidden ? current.filter((id) => id !== layer.id) : [...current, layer.id])}
                      >
                        {layer.kind === 'back' ? 'B' : layer.kind === 'front' ? 'F' : 'M'}
                      </button>
                    )
                  })}
                </div>
              )}
              {displayStateAnimations.length > 0 && (
                <div className="inspector-group state-group">
                  <span className="control-label">状态</span>
                  {displayStateAnimations.map((name) => {
                    const active = persistentStates.includes(name)
                    return (
                      <button
                        key={name}
                        className={active ? 'active' : ''}
                        onClick={() => {
                          setRawPreviewSerial((serial) => serial + 1)
                          if (interactionBinding) {
                            setRawPreviewActive(true)
                          }
                          setPersistentStates((current) => active ? current.filter((item) => item !== name) : [...current, name])
                        }}
                      >{name}</button>
                    )
                  })}
                </div>
              )}
            </div>
          )}

            </details>
          </section>
          <section id="gallery-voices" role="tabpanel" aria-labelledby="gallery-voices-tab" hidden={layout.tab !== 'voices'} className="gallery-tool-page">
            {!layout.immersive.active && voiceTools}
          </section>
        </div>
      </aside>
      {auxiliaryPreview && <AuxiliaryPreview key={auxiliaryPreview.id} asset={auxiliaryPreview} onClose={() => setAuxiliaryPreview(null)} />}
    </div></ImmersiveContext.Provider>
  )
}
