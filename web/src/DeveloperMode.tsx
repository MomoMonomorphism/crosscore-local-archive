import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import {
  capriccioMaskOverrides, emptyDeveloperOverrides,
  type DeveloperOverrides, type DeveloperPickCandidate, type DeveloperPlaybackHandle, type DeveloperRule, type DeveloperScene, type DeveloperSceneHandle,
} from './developerControls'
import {
  applyDeveloperPreset, createDeveloperPreset, exportDeveloperPresets, importDeveloperPresets,
  loadDeveloperPresets, mergeDeveloperPresets, persistDeveloperPresets, presetsForScene,
  type DeveloperPreset,
} from './developerPresets'
import './developerMode.css'
import { installDeveloperPickEvents } from './developerPickEvents'
import { developerCandidateIndex, findDeveloperPlayback, patchDeveloperObject, restoreDeveloperObject, stepDeveloperCandidate } from './developerInspector'
import DeveloperLayerTiles from './DeveloperLayerTiles'
import { useDeveloperFloatingPanel } from './useDeveloperFloatingPanel'
import { createDeveloperThumbnailCache } from './developerThumbnailCache'
import type { DeveloperTileLocateRequest } from './developerTileNavigation'
import { useMotionPresence } from './useMotionPresence'
import { useDeveloperCollapseMotion } from './useDeveloperCollapseMotion'

const MODE_KEY = 'crosscore.developer-mode.v2'
const noop = () => {}
const DeveloperContext = createContext({
  enabled: false, panelOpen: false, toggleMode: noop, openTools: noop,
  registerScene: (_handle: DeveloperSceneHandle): (() => void) => noop,
  registerPlayback: (_handle: DeveloperPlaybackHandle): (() => void) => noop,
  notifyPlaybackChanged: noop,
  getOverrides: (_sceneId: string): DeveloperOverrides | null => null,
})
export const useDeveloperMode = () => useContext(DeveloperContext)

function initialMode() {
  try {
    // The old prototype's one-off setting must not silently affect this toolbox.
    sessionStorage.removeItem('crosscore.developer-mask-preview.v1')
    return sessionStorage.getItem(MODE_KEY) === 'enabled'
  } catch { return false }
}

function scenePriority(id: string) {
  return id.startsWith('gallery:') || id.startsWith('picture:') || id.startsWith('asmr:') ? 0
    : id.startsWith('preview:') ? 1 : 2
}
function sortedHandles(handles: Iterable<DeveloperSceneHandle>) {
  return [...handles].sort((a, b) => Number(a.active?.() === false) - Number(b.active?.() === false)
    || scenePriority(a.id) - scenePriority(b.id))
}

export default function DeveloperModeProvider({ children }: { children: ReactNode }) {
  const [enabled, setEnabled] = useState(initialMode)
  const enabledRef = useRef(enabled)
  const [panelOpen, setPanelOpen] = useState(false)
  const [collapsed, setCollapsed] = useState(false)
  const [browserOpen, setBrowserOpen] = useState(false)
  const [browserCollapsed, setBrowserCollapsed] = useState(false)
  const [followTileSelection, setFollowTileSelection] = useState(true)
  const [tileLocateRequest, setTileLocateRequest] = useState<DeveloperTileLocateRequest | null>(null)
  const tileLocateToken = useRef(0)
  const [activeWindow, setActiveWindow] = useState<'inspector' | 'browser'>('inspector')
  const handlesRef = useRef(new Map<string, DeveloperSceneHandle>())
  const playbackHandlesRef = useRef(new Map<string, DeveloperPlaybackHandle>())
  const [playbackVersion, setPlaybackVersion] = useState(0)
  const [thumbnailVersion, setThumbnailVersion] = useState(0)
  const draftsRef = useRef<Record<string, DeveloperOverrides>>({})
  const [registryVersion, setRegistryVersion] = useState(0)
  const [, setDraftVersion] = useState(0)
  const [sceneId, setSceneId] = useState('')
  const manualSceneRef = useRef(false)
  const [scene, setScene] = useState<DeveloperScene | null>(null)
  const [presets, setPresets] = useState<DeveloperPreset[]>(loadDeveloperPresets)
  const [presetId, setPresetId] = useState('')
  const [presetName, setPresetName] = useState('')
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [pickMode, setPickMode] = useState(false)
  const [pickResult, setPickResult] = useState<{ sceneId: string; candidates: DeveloperPickCandidate[]; selected: DeveloperPickCandidate | null } | null>(null)
  const pickModeRef = useRef(false)
  const panelOpenRef = useRef(panelOpen)
  const sceneIdRef = useRef(sceneId)
  panelOpenRef.current = panelOpen
  sceneIdRef.current = sceneId
  const highlightedRef = useRef<{ handle: DeveloperSceneHandle; candidate: DeveloperPickCandidate } | null>(null)
  const pickActionsRef = useRef({ select: (_handle: DeveloperSceneHandle, _candidates: DeveloperPickCandidate[]) => {} })
  const inspectorWindow = useDeveloperFloatingPanel(panelOpen, collapsed)
  const browserWindow = useDeveloperFloatingPanel(browserOpen, browserCollapsed)
  const inspectorPresence = useMotionPresence(enabled && panelOpen)
  const browserPresence = useMotionPresence(enabled && browserOpen)
  const inspectorCollapse = useDeveloperCollapseMotion(collapsed, enabled && panelOpen, inspectorPresence.reducedMotion, inspectorWindow.pauseMeasure)
  const browserCollapse = useDeveloperCollapseMotion(browserCollapsed, enabled && browserOpen, browserPresence.reducedMotion, browserWindow.pauseMeasure)
  const panelRef = inspectorWindow.ref
  const browserRef = browserWindow.ref
  const importRef = useRef<HTMLInputElement>(null)
  const importGeneration = useRef(0)
  const thumbnailRequests = useRef(new Set<AbortController>())
  const thumbnailActive = enabled && browserOpen && !browserCollapsed && browserPresence.settled && !browserCollapse.animating
  const thumbnailActiveRef = useRef(thumbnailActive); thumbnailActiveRef.current = thumbnailActive
  const [thumbnailActivity, setThumbnailActivity] = useState(0)
  const abortThumbnails = useCallback(() => {
    for (const request of thumbnailRequests.current) request.abort()
    thumbnailRequests.current.clear()
  }, [])
  const thumbnailCacheRef = useRef<ReturnType<typeof createDeveloperThumbnailCache> | null>(null)
  if (!thumbnailCacheRef.current) thumbnailCacheRef.current = createDeveloperThumbnailCache(id => handlesRef.current.get(id))
  useEffect(() => () => { abortThumbnails(); importGeneration.current++; thumbnailCacheRef.current?.invalidate() }, [abortThumbnails])
  useLayoutEffect(() => {
    if (!thumbnailActive) abortThumbnails()
    // Re-observe after the final expanded layout, so interrupted close/open
    // cannot strand a tile in an aborted generation or load the whole grid.
    if (thumbnailActive) setThumbnailActivity(value => value + 1)
  }, [thumbnailActive, abortThumbnails])
  useLayoutEffect(() => {
    if (panelRef.current) panelRef.current.inert = !(enabled && panelOpen)
    if (browserRef.current) browserRef.current.inert = !(enabled && browserOpen)
  }, [enabled, panelOpen, browserOpen, inspectorPresence.present, browserPresence.present])
  useLayoutEffect(() => {
    if (inspectorCollapse.contentRef.current) inspectorCollapse.contentRef.current.inert = collapsed || !(enabled && panelOpen)
    if (browserCollapse.contentRef.current) browserCollapse.contentRef.current.inert = browserCollapsed || !(enabled && browserOpen)
  }, [enabled, panelOpen, browserOpen, collapsed, browserCollapsed])
  const thumbnailSceneId = scene?.id ?? ''
  const requestThumbnail = useCallback((candidate: DeveloperPickCandidate, signal?: AbortSignal) => {
    if (!enabledRef.current || !thumbnailActiveRef.current || signal?.aborted) return Promise.resolve(null)
    const request = new AbortController()
    const abort = () => request.abort()
    signal?.addEventListener('abort', abort, { once: true })
    thumbnailRequests.current.add(request)
    return thumbnailCacheRef.current!.request(thumbnailSceneId, candidate, request.signal).finally(() => {
      signal?.removeEventListener('abort', abort); thumbnailRequests.current.delete(request)
    })
  }, [thumbnailSceneId, thumbnailActivity])

  const clearPickSelection = useCallback(() => {
    const current = highlightedRef.current
    highlightedRef.current = null
    try { current?.handle.highlight?.(null) } catch { /* A renderer may have just unloaded. */ }
    setPickResult(null)
    setTileLocateRequest(null)
  }, [])
  const stopPicking = useCallback((clear = false) => {
    pickModeRef.current = false
    setPickMode(false)
    if (clear) clearPickSelection()
  }, [clearPickSelection])

  const registerScene = useCallback((handle: DeveloperSceneHandle) => {
    if (highlightedRef.current?.handle.id === handle.id && highlightedRef.current.handle !== handle) clearPickSelection()
    thumbnailCacheRef.current?.invalidate(handle.id)
    if (sceneIdRef.current === handle.id) setThumbnailVersion(value => value + 1)
    handlesRef.current.set(handle.id, handle)
    setRegistryVersion(value => value + 1)
    return () => {
      if (handlesRef.current.get(handle.id) !== handle) return
      if (highlightedRef.current?.handle === handle) clearPickSelection()
      thumbnailCacheRef.current?.invalidate(handle.id)
      if (sceneIdRef.current === handle.id) setThumbnailVersion(value => value + 1)
      handlesRef.current.delete(handle.id)
      setRegistryVersion(value => value + 1)
    }
  }, [clearPickSelection])
  const getOverrides = useCallback((id: string) => enabledRef.current ? draftsRef.current[id] ?? null : null, [])
  const notifyPlaybackChanged = useCallback(() => setPlaybackVersion(value => value + 1), [])
  const registerPlayback = useCallback((handle: DeveloperPlaybackHandle) => {
    playbackHandlesRef.current.set(handle.id, handle)
    notifyPlaybackChanged()
    return () => {
      if (playbackHandlesRef.current.get(handle.id) !== handle) return
      playbackHandlesRef.current.delete(handle.id)
      notifyPlaybackChanged()
    }
  }, [notifyPlaybackChanged])
  const toggleMode = useCallback(() => {
    const next = !enabledRef.current
    enabledRef.current = next
    setEnabled(next)
    if (!next) {
      if (panelRef.current?.contains(document.activeElement) || browserRef.current?.contains(document.activeElement))
        document.querySelector<HTMLButtonElement>('.gallery-brand')?.focus({ preventScroll: true })
      if (panelRef.current) panelRef.current.inert = true
      if (browserRef.current) browserRef.current.inert = true
      panelOpenRef.current = false
      thumbnailActiveRef.current = false
      importGeneration.current++
      abortThumbnails()
      stopPicking(true)
      inspectorWindow.cancelDrag(); browserWindow.cancelDrag()
      thumbnailCacheRef.current?.invalidate()
      setThumbnailVersion(value => value + 1)
      draftsRef.current = {}
      setDraftVersion(value => value + 1)
      setPanelOpen(false)
      setBrowserOpen(false)
      setTileLocateRequest(null)
      setMessage('')
      setError('')
    }
  }, [abortThumbnails, stopPicking])
  const openTools = useCallback(() => {
    if (!enabledRef.current) return
    if (!manualSceneRef.current) setSceneId(sortedHandles(handlesRef.current.values())[0]?.id ?? '')
    setCollapsed(false)
    setPanelOpen(true)
    setBrowserOpen(true)
    setBrowserCollapsed(false)
    setActiveWindow('inspector')
  }, [])

  const handles = useMemo(() => sortedHandles(handlesRef.current.values()), [registryVersion, panelOpen, browserOpen])
  useEffect(() => {
    if (!handles.some(handle => handle.id === sceneId)) manualSceneRef.current = false
    if (!manualSceneRef.current) setSceneId(sortedHandles(handlesRef.current.values())[0]?.id ?? '')
  }, [handles, sceneId])
  useEffect(() => {
    try { sessionStorage.setItem(MODE_KEY, enabled ? 'enabled' : 'local') } catch { /* Mode memory is optional. */ }
  }, [enabled])
  const refreshSnapshot = useCallback(() => {
    const target = manualSceneRef.current ? sceneId : sortedHandles(handlesRef.current.values())[0]?.id ?? ''
    if (target !== sceneId) setSceneId(target)
    const handle = handlesRef.current.get(target)
    try { setScene(handle?.snapshot() ?? null) }
    catch { setError('画面信息暂时不可用，请在加载完成后刷新。') }
  }, [sceneId])
  const refresh = () => {
    thumbnailCacheRef.current?.invalidate(sceneId)
    setThumbnailVersion(value => value + 1)
    refreshSnapshot()
  }
  useEffect(() => { refreshSnapshot() }, [refreshSnapshot, registryVersion, panelOpen, browserOpen])
  useEffect(() => { setPresetId(''); setPresetName(''); setMessage(''); setError('') }, [sceneId])
  useEffect(() => {
    if (!enabled) stopPicking(true)
    else if (!panelOpen) stopPicking(false)
  }, [enabled, panelOpen, stopPicking])
  useEffect(() => {
    const highlighted = highlightedRef.current
    if (highlighted && (highlighted.handle.id !== sceneId || handlesRef.current.get(sceneId) !== highlighted.handle)) clearPickSelection()
    if (pickResult && pickResult.sceneId !== sceneId) setPickResult(null)
  }, [sceneId, registryVersion, clearPickSelection, pickResult])
  useEffect(() => {
    if (!pickMode || !enabled || !panelOpen) return
    const surfaces = [...handlesRef.current.values()].flatMap(handle => {
      try { const surface = handle.pick && handle.active?.() !== false ? handle.surface?.() : null; return surface ? [surface] : [] }
      catch { return [] }
    })
    for (const surface of surfaces) surface.classList.add('developer-pick-surface')
    return () => { for (const surface of surfaces) surface.classList.remove('developer-pick-surface') }
  }, [pickMode, enabled, panelOpen, registryVersion])
  useEffect(() => {
    // Capture before canvas/React handlers. The entire pointer gesture is owned
    // by the picker, including the subsequent browser click, so selecting a
    // layer cannot skip an entrance, start a drag, or trigger a gameplay hotspot.
    const isToolTarget = (event: Event) => !!(panelRef.current?.contains(event.target as Node) || browserRef.current?.contains(event.target as Node))
    const findHandle = (event: Event): DeveloperSceneHandle | undefined => {
      if (!enabledRef.current || !panelOpenRef.current || !pickModeRef.current || isToolTarget(event)) return
      const targetElement = event.target instanceof Element ? event.target : null
      if (targetElement?.closest('input,select,textarea,[contenteditable="true"],.gallery-topbar,.gallery-tools,.control-deck,.illustration-controls,.illustration-mode-bar,.immersive-tools,.gallery-compact-toolbar,.view-tools,.asmr-transport,.asmr-playbar')) return
      const values = sortedHandles(handlesRef.current.values())
      const selected = handlesRef.current.get(sceneIdRef.current)
      if (selected) values.splice(0, 0, selected)
      const path = event.composedPath()
      // A visible interlude can deliberately have pointer-events:none. Its
      // picture still needs picking when it is the selected scene even though
      // the browser targets the canvas behind it. Never extend this fallback
      // onto toolbar or form controls.
      if (selected?.pick && selected.active?.() !== false && 'clientX' in event && 'clientY' in event) {
        const target = event.target instanceof Element ? event.target : null
        const control = target?.closest('button,a,input,select,textarea,[role="button"],[contenteditable="true"],.gallery-topbar,.gallery-tools,.control-deck,.illustration-controls,.immersive-tools,.gallery-compact-toolbar,.view-tools,.asmr-transport')
        if (!control) try {
          const surface = selected.surface?.(), bounds = surface?.getBoundingClientRect()
          const x = Number(event.clientX), y = Number(event.clientY)
          if (surface?.getClientRects().length && bounds && bounds.width > 0 && bounds.height > 0
            && x >= bounds.left && x <= bounds.right && y >= bounds.top && y <= bounds.bottom) return selected
        } catch { /* Scene may unload while a pointer is being moved. */ }
      }
      return values.find(handle => {
        if (!handle.pick || handle.active?.() === false) return false
        try { const surface = handle.surface?.(); return !!surface && (path.includes(surface) || surface.contains(event.target as Node)) }
        catch { return false }
      })
    }
    const removeEvents = installDeveloperPickEvents(document, {
      findHandle,
      canPick: handle => enabledRef.current && panelOpenRef.current && pickModeRef.current
        && handlesRef.current.get(handle.id) === handle && handle.active?.() !== false,
      onPick: (handle, candidates) => pickActionsRef.current.select(handle, candidates),
      onError: () => setError('此画面暂时无法点选，请等待加载完成后重试。'),
      isPanelTarget: isToolTarget,
      blurTarget: window,
      isHidden: () => document.hidden,
    })
    return () => {
      removeEvents()
      try { highlightedRef.current?.handle.highlight?.(null) } catch { /* Scene already disposed. */ }
    }
  }, [])
  const restoreWindowFocus = (closing: HTMLElement | null, fallback: string) => {
    if (!closing?.contains(document.activeElement)) return
    // Restore immediately, before the retained closing shell becomes inert.
    // No delayed focus callback can steal focus from a rapidly reopened window.
    const alternative = document.querySelector<HTMLElement>(fallback)
    const opener = alternative && !alternative.closest('[inert],[aria-hidden="true"]') ? alternative
      : document.querySelector<HTMLElement>('.gallery-developer-tools')
    opener?.focus({ preventScroll: true })
  }
  const closeInspector = () => {
    panelOpenRef.current = false
    importGeneration.current++
    stopPicking(false)
    inspectorWindow.cancelDrag()
    restoreWindowFocus(panelRef.current, '.developer-inspector-entry')
    if (panelRef.current) panelRef.current.inert = true
    setPanelOpen(false)
  }
  const closeBrowser = () => {
    thumbnailActiveRef.current = false
    abortThumbnails()
    browserWindow.cancelDrag()
    restoreWindowFocus(browserRef.current, '.developer-browser-entry')
    if (browserRef.current) browserRef.current.inert = true
    setBrowserOpen(false)
    setTileLocateRequest(null)
  }
  useEffect(() => {
    if (panelOpen) panelRef.current?.querySelector<HTMLButtonElement>('.developer-close')?.focus()
  }, [panelOpen])
  useEffect(() => {
    if (!panelOpen && !browserOpen) return
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && pickModeRef.current) {
        event.preventDefault(); event.stopImmediatePropagation(); stopPicking(); return
      }
      if (event.key === 'Escape' && !event.defaultPrevented) {
        if (browserRef.current?.contains(document.activeElement)) { event.preventDefault(); closeBrowser() }
        else if (panelRef.current?.contains(document.activeElement)) { event.preventDefault(); closeInspector() }
      }
    }
    document.addEventListener('keydown', keyboard, true)
    return () => document.removeEventListener('keydown', keyboard, true)
  }, [panelOpen, browserOpen, stopPicking])

  const requestTileLocation = (handle: DeveloperSceneHandle, candidate: DeveloperPickCandidate, raise = false) => {
    if (!enabledRef.current || handlesRef.current.get(handle.id) !== handle) return
    setTileLocateRequest({ sceneId: handle.id, candidate: { ...candidate }, token: ++tileLocateToken.current })
    if (browserOpen && browserCollapsed) browserCollapse.captureToggle()
    setBrowserOpen(true)
    setBrowserCollapsed(false)
    if (raise) setActiveWindow('browser')
  }
  const locatePicked = (handle: DeveloperSceneHandle, candidate: DeveloperPickCandidate | null, candidates: DeveloperPickCandidate[], follow = true) => {
    const previous = highlightedRef.current
    if (previous?.handle !== handle) {
      try { previous?.handle.highlight?.(null) } catch { /* Scene already unloaded. */ }
    }
    highlightedRef.current = candidate ? { handle, candidate } : null
    handle.highlight?.(candidate)
    manualSceneRef.current = true
    setSceneId(handle.id)
    setScene(handle.snapshot())
    setError('')
    setPickResult({ sceneId: handle.id, candidates, selected: candidate })
    if (candidate && follow && followTileSelection) requestTileLocation(handle, candidate)
    else setTileLocateRequest(null)
  }
  pickActionsRef.current.select = (handle, candidates) => locatePicked(handle, candidates[0] ?? null, candidates)

  const overrides = draftsRef.current[sceneId] ?? emptyDeveloperOverrides()
  const replaceOverrides = (value: DeveloperOverrides) => {
    // Optional fields must be absent after cancellation, rather than present as
    // undefined, so saved/imported presets share the same strict schema.
    const { solo, ...rest } = value
    draftsRef.current = { ...draftsRef.current, [sceneId]: solo ? { ...rest, solo } : rest }
    setDraftVersion(version => version + 1)
  }
  const updateRule = (kind: 'layers' | 'slots', id: string, patch: DeveloperRule) => {
    replaceOverrides(patchDeveloperObject(overrides, kind === 'layers' ? 'layer' : 'slot', id, patch))
  }
  const toggleSolo = (kind: 'layer' | 'slot', id: string) => {
    replaceOverrides({ ...overrides, solo: overrides.solo?.kind === kind && overrides.solo.id === id ? undefined : { kind, id } })
  }
  const savePresets = (next: DeveloperPreset[]) => {
    if (!persistDeveloperPresets(next)) {
      setError('预设保存失败：浏览器存储不可用或空间不足。当前调试设置仍可使用，可先导出备份。')
      return false
    }
    setPresets(next)
    setError('')
    return true
  }
  const savePreset = () => {
    if (!scene || !presetName.trim()) { setError('请输入预设名称。'); return }
    try {
      const existing = presets.find(item => item.sceneId === scene.id && item.name === presetName.trim())
      const created = createDeveloperPreset(scene.id, presetName.trim(), overrides)
      const value = existing ? { ...created, id: existing.id, createdAt: existing.createdAt } : created
      const next = mergeDeveloperPresets(presets, [value])
      if (savePresets(next)) { setPresetId(value.id); setMessage(existing ? '已更新同名预设。' : '预设已保存；下次可主动应用。') }
    } catch (cause) { setError(cause instanceof Error ? cause.message : '预设保存失败。') }
  }
  const exportPresets = (current = false) => {
    try {
      const values = current && scene ? [createDeveloperPreset(scene.id, presetName.trim() || `${scene.label} 调试预设`, overrides)] : presets
      const url = URL.createObjectURL(new Blob([exportDeveloperPresets(values)], { type: 'application/json' }))
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = current ? 'crosscore-current-developer-preset.json' : 'crosscore-developer-presets.json'
      anchor.click()
      window.setTimeout(() => URL.revokeObjectURL(url), 1000)
      setMessage(current ? '已导出当前调试设置。' : '已导出全部命名预设。')
      setError('')
    } catch (cause) { setError(cause instanceof Error ? cause.message : '导出失败。') }
  }
  const importPresets = async (file: File) => {
    const generation = ++importGeneration.current
    try {
      if (file.size > 4 * 1024 * 1024) throw new Error('开发者预设文件不能超过4MB。')
      const text = await file.text()
      if (generation !== importGeneration.current || !enabledRef.current || !panelOpenRef.current) return
      const incoming = importDeveloperPresets(text)
      const next = mergeDeveloperPresets(presets, incoming)
      if (savePresets(next)) setMessage(`已导入 ${incoming.length} 个预设，尚未应用到画面。`)
    } catch (cause) { if (generation === importGeneration.current && enabledRef.current && panelOpenRef.current)
      setError(cause instanceof Error ? cause.message : '无法读取预设文件。') }
  }
  const visiblePresets = scene ? presetsForScene(presets, scene.id) : []
  const supportsPicking = handles.some(handle => !!handle.pick && !!handle.surface)
  const selectedPick = pickResult?.sceneId === sceneId ? pickResult.selected : null
  const currentCandidates = pickResult?.sceneId === sceneId ? pickResult.candidates : []
  const candidateIndex = developerCandidateIndex(currentCandidates, selectedPick)
  const selectedLayer = selectedPick ? scene?.layers.find(layer => layer.id === selectedPick.layerId) : undefined
  const selectedSlot = selectedPick?.kind === 'slot' ? scene?.slots.find(slot => slot.id === selectedPick.id) : undefined
  const selectionExists = !!selectedPick && (selectedPick.kind === 'layer' ? selectedLayer?.id === selectedPick.id : !!selectedSlot)
  const selectedRuleKey = selectedPick?.kind === 'slot' ? 'slots' : 'layers'
  const selectedRule = selectedPick ? overrides[selectedRuleKey][selectedPick.id] ?? {} : {}
  const selectedClipping = selectedPick?.kind === 'slot' && selectedSlot?.type === 'clipping'
  const selectedSolo = !!selectedPick && overrides.solo?.kind === selectedPick.kind && overrides.solo.id === selectedPick.id
  const playback = useMemo(() => {
    let surface: HTMLElement | null = null
    try { surface = handlesRef.current.get(sceneId)?.surface?.() ?? null } catch { /* Loading page. */ }
    return findDeveloperPlayback(surface, playbackHandlesRef.current.values())
  }, [sceneId, registryVersion, playbackVersion])
  let playbackState = { playing: false, available: false }
  try { playbackState = playback?.getState() ?? playbackState } catch { /* Loading page. */ }
  const selectInspectorCandidate = (candidate: DeveloperPickCandidate, candidates = currentCandidates, follow = true) => {
    const handle = handlesRef.current.get(sceneId)
    if (!handle) { clearPickSelection(); return }
    try { locatePicked(handle, candidate, candidates, follow) }
    catch { setError('对象信息已发生变化，请刷新信息后重新选择。') }
  }
  const selectBrowserObject = (candidate: DeveloperPickCandidate) => {
    if (!scene || scene.id !== sceneId) return
    selectInspectorCandidate(candidate, [candidate], false)
    setPanelOpen(true)
    setActiveWindow('inspector')
  }
  const locateSelectedThumbnail = () => {
    const handle = handlesRef.current.get(sceneId)
    if (!handle || !selectedPick) return
    try {
      const fresh = handle.snapshot()
      const exists = selectedPick.kind === 'layer'
        ? fresh.layers.some(layer => layer.id === selectedPick.id && layer.id === selectedPick.layerId)
        : fresh.slots.some(slot => slot.id === selectedPick.id && slot.layerId === selectedPick.layerId)
      if (!exists) { setError('对象已不在当前画面中，请重新点选。'); return }
      setScene(fresh)
      requestTileLocation(handle, selectedPick, true)
      setError('')
    } catch { setError('素材信息暂时不可用，请等待加载完成后重试。') }
  }
  const builtin = scene ? capriccioMaskOverrides(scene) : null

  return <DeveloperContext.Provider value={{ enabled, panelOpen: panelOpen || browserOpen, toggleMode, openTools, registerScene, getOverrides, registerPlayback, notifyPlaybackChanged }}>
    {children}
    {inspectorPresence.present && createPortal(<aside id="developer-inspector-window" ref={panelRef} className={`developer-panel developer-inspector-panel${collapsed ? ' developer-panel-collapsed' : ''}`}
      style={{ ...inspectorWindow.style, zIndex: activeWindow === 'inspector' ? 10002 : 10001 }}
      onPointerDownCapture={() => setActiveWindow('inspector')} onFocusCapture={() => setActiveWindow('inspector')}
      aria-labelledby="developer-heading" aria-hidden={!(enabled && panelOpen)} data-motion-phase={inspectorPresence.phase}>
      <div className="developer-panel-shell" ref={inspectorCollapse.shellRef}>
      <header className="developer-panel-header" {...inspectorWindow.headerEvents}>
        <div><small>INSPECTOR</small><h2 id="developer-heading">点选与调整{pickMode && <span className="developer-pick-status">点选中</span>}</h2></div>
        <div className="developer-header-buttons">
          <button type="button" title={collapsed ? '展开面板' : '收起面板'} aria-label={collapsed ? '展开开发工具' : '收起开发工具'}
            onClick={() => { inspectorCollapse.captureToggle(); setCollapsed(value => !value) }}>{collapsed ? '+' : '−'}</button>
          <button type="button" className="developer-close" aria-label="关闭点选与调整" onClick={closeInspector}>×</button>
        </div>
      </header>
      <div className="developer-quick-tools" aria-label="常用开发控制">
        <button type="button" className="developer-browser-entry" aria-expanded={browserOpen} onClick={() => {
          setBrowserOpen(true); setBrowserCollapsed(false); setActiveWindow('browser')
        }}>图层磁贴</button>
        <button type="button" disabled={!supportsPicking} className={pickMode ? 'developer-selected' : ''} aria-pressed={pickMode} onClick={() => {
          const next = !pickModeRef.current
          pickModeRef.current = next; setPickMode(next)
        }}>{pickMode ? '退出点选' : '点选'}</button>
        <button type="button" disabled={!playbackState.available} aria-label={playbackState.playing ? '暂停当前页面播放' : '继续当前页面播放'}
          title="控制当前页面的动画；ASMR页面控制音频" onClick={() => {
          try {
            const live = playback?.getState()
            if (live?.available) { playback?.setPlaying(!live.playing); notifyPlaybackChanged() }
          } catch { setError('当前画面播放状态暂时不可用，请等待加载完成。') }
        }}>{playbackState.playing ? '暂停' : '继续'}</button>
        <button type="button" disabled={!pickResult} onClick={clearPickSelection}>清除选择</button>
        <button type="button" disabled={!scene} onClick={() => { replaceOverrides(emptyDeveloperOverrides()); setMessage('当前画面已恢复原始效果。'); setError('') }}>恢复当前画面</button>
      </div>
      <div className="developer-inspector" aria-label="选中对象检查器">
        <div className="developer-scene-select"><label htmlFor="developer-scene">画面</label>
          <select id="developer-scene" value={sceneId} onChange={event => { manualSceneRef.current = true; setSceneId(event.target.value) }}>
            {!handles.length && <option value="">等待画面加载</option>}
            {handles.map(handle => <option key={handle.id} value={handle.id}>{handle.label}</option>)}
          </select><button type="button" onClick={refresh}>刷新信息</button></div>
        <div className="developer-candidate-switcher" aria-label="切换重叠候选">
          <button type="button" disabled={!currentCandidates.length} aria-label="上一个重叠候选" onClick={() => {
            const candidate = stepDeveloperCandidate(currentCandidates, selectedPick, -1)
            if (candidate) selectInspectorCandidate(candidate)
          }}>‹</button>
          <output aria-live="polite">{candidateIndex < 0 ? '—' : candidateIndex + 1}/{currentCandidates.length}</output>
          <button type="button" disabled={!currentCandidates.length} aria-label="下一个重叠候选" onClick={() => {
            const candidate = stepDeveloperCandidate(currentCandidates, selectedPick, 1)
            if (candidate) selectInspectorCandidate(candidate)
          }}>›</button>
          <select aria-label="选择重叠候选" disabled={!currentCandidates.length} value={candidateIndex < 0 ? '' : String(candidateIndex)} onChange={event => {
            const candidate = currentCandidates[Number(event.target.value)]
            if (candidate) selectInspectorCandidate(candidate)
          }}>
            {candidateIndex < 0 && <option value="">{selectedPick ? '当前为关联对象' : '未选中对象'}</option>}
            {currentCandidates.map((candidate, index) => <option key={`${candidate.kind}:${candidate.id}`} value={index}>{index + 1}. {candidate.label}</option>)}
          </select>
        </div>
        <div className="developer-thumbnail-navigation">
          <label title="点选画布或切换候选后，自动打开磁贴并定位对应资源"><input type="checkbox" checked={followTileSelection}
            onChange={event => { setFollowTileSelection(event.target.checked); if (!event.target.checked) setTileLocateRequest(null) }}/>
            跟随点选</label>
          <button type="button" disabled={!selectedPick || !selectionExists} onClick={locateSelectedThumbnail}>定位缩略图</button>
        </div>
        {selectedPick ? <>
          <div className="developer-inspector-heading"><strong title={selectedPick.label}>{selectedSlot?.name ?? selectedLayer?.label ?? selectedPick.label}</strong>
            <span>{selectedPick.kind === 'slot' ? '槽位' : '图层'} · {selectedSlot?.type ?? selectedLayer?.kind ?? selectedPick.type}</span></div>
          <dl className="developer-inspector-meta">
            <dt>素材</dt><dd><code title={selectedLayer?.assetId}>{selectedLayer?.assetId ?? '不可用'}</code></dd>
            <dt>槽位</dt><dd><code title={selectedSlot?.name}>{selectedSlot?.name ?? '—'}</code></dd>
            <dt>附件</dt><dd><code title={selectedSlot ? selectedSlot.attachment ?? '无' : selectedPick.attachment ?? ''}>{selectedSlot ? selectedSlot.attachment ?? '无' : selectedPick.attachment ?? '—'}</code></dd>
          </dl>
          {selectedSlot && <p className="developer-inspector-state">{selectedClipping ? '裁切槽位控制几何范围，不使用图片透明度。'
            : `快照α ${Math.round(selectedSlot.alpha * 100)}%（刷新更新）${selectedSlot.attachment ? '' : ' · 当前无附件'}。显示仅允许绘制，透明度不强制显现。`}</p>}
          {selectedSlot && selectedSlot.attachments.length > 1 && <details className="developer-attachment-list"><summary>可用附件 {selectedSlot.attachments.length}</summary><code>{selectedSlot.attachments.join('\n')}</code></details>}
          <div className="developer-inspector-controls">
            <label><input type="checkbox" disabled={!selectionExists} checked={selectedClipping ? !selectedRule.disableClipping
              : selectedPick.kind === 'layer' ? selectedRule.hidden === undefined ? !!selectedLayer?.visible : !selectedRule.hidden : !selectedRule.hidden}
              onChange={event => updateRule(selectedRuleKey, selectedPick.id, selectedClipping ? { disableClipping: !event.target.checked } : { hidden: !event.target.checked })}/>
              {selectedClipping ? '启用裁切' : '显示'}</label>
            <button type="button" disabled={!selectionExists || selectedClipping} className={selectedSolo ? 'developer-selected' : ''}
              aria-pressed={selectedSolo} onClick={() => toggleSolo(selectedPick.kind, selectedPick.id)}>{selectedSolo ? '退出独显' : '独显'}</button>
            <button type="button" onClick={() => replaceOverrides(restoreDeveloperObject(overrides, selectedPick.kind, selectedPick.id))}>恢复单项</button>
          </div>
          <label className="developer-opacity developer-inspector-opacity">透明度<input type="range" min="0" max="1" step="0.01" disabled={!selectionExists || selectedClipping}
            value={selectedRule.opacity ?? 1} onChange={event => updateRule(selectedRuleKey, selectedPick.id, { opacity: Number(event.target.value) })}/>
            <output>{Math.round((selectedRule.opacity ?? 1) * 100)}%</output></label>
          {selectedPick.kind === 'layer' && /裁切|clipping|mask|遮罩|溶解/i.test(selectedLayer?.kind ?? selectedPick.type ?? '')
            && <label className="developer-filter"><input type="checkbox" disabled={!selectionExists} checked={!!selectedRule.disableClipping}
              onChange={event => updateRule('layers', selectedPick.id, { disableClipping: event.target.checked })}/>禁用此图层裁切／材质遮罩</label>}
          {!!selectedPick.relatedClipping?.length && <div className="developer-inspector-clipping"><small>关联裁切</small>{selectedPick.relatedClipping.map(id => {
            const slot = scene?.slots.find(item => item.id === id)
            return <button type="button" key={id} disabled={!slot} onClick={() => {
              if (slot) selectInspectorCandidate({ id: slot.id, kind: 'slot', layerId: slot.layerId, label: slot.name, type: slot.type, attachment: slot.attachment, order: slot.order })
            }}>{slot?.name ?? id}</button>
          })}</div>}
          {!selectionExists && <p className="developer-muted">对象已不在当前快照中，可刷新信息或重新点选；其原调试设置仍可单独恢复。</p>}
        </> : <p className="developer-inspector-empty">{pickResult && !currentCandidates.length ? '此点未命中可见对象。' : pickMode ? '点击画布，或从图层浏览器选择对象。' : '开启点选，或从图层浏览器选择对象。'}
          {pickMode && <small>点选时拦截画布交互，动画仍在播放。</small>}</p>}
      </div>
      {error && <p className="developer-error developer-fixed-feedback" role="alert">{error}</p>}
      {message && <p className="developer-message developer-fixed-feedback" role="status">{message}</p>}
      <div className="developer-collapse-content developer-inspector-content" ref={inspectorCollapse.contentRef}
        hidden={!inspectorCollapse.contentPresent} aria-hidden={collapsed}>
      <div className="developer-panel-body">
        {scene && <>
          <details className="developer-section"><summary>命名预设</summary>
            {builtin && <div className="developer-builtin"><button type="button" onClick={() => { replaceOverrides(builtin); setMessage('已应用：隐藏随想曲04B动作黑影。'); setError('') }}>应用随想曲04B动作黑影预设</button><small>隐藏heidian、heiying1，保留画框黑边。</small></div>}
            <div className="developer-preset-save"><input aria-label="预设名称" placeholder="输入预设名称" value={presetName} maxLength={80}
              onChange={event => setPresetName(event.target.value)}/><button type="button" onClick={savePreset}>保存当前设置</button></div>
            <div className="developer-preset-apply"><select aria-label="选择当前画面的预设" value={presetId} onChange={event => {
              setPresetId(event.target.value)
              setPresetName(visiblePresets.find(item => item.id === event.target.value)?.name ?? '')
            }}><option value="">选择已保存预设</option>{visiblePresets.map(item => <option value={item.id} key={item.id}>{item.name}</option>)}</select>
              <button type="button" disabled={!presetId} onClick={() => {
                const preset = presets.find(item => item.id === presetId)
                const value = preset && applyDeveloperPreset(preset, scene)
                if (!value || !preset) { setError('此预设不属于当前画面。'); return }
                replaceOverrides(value); setMessage(`已应用：${preset.name}`); setError('')
              }}>应用</button>
              <button type="button" disabled={!presetId} onClick={() => {
                if (savePresets(presets.filter(item => item.id !== presetId))) { setPresetId(''); setMessage('预设已删除，画面设置保持不变。') }
              }}>删除</button></div>
            <div className="developer-action-row"><button type="button" onClick={() => exportPresets(true)}>导出当前设置</button>
              <button type="button" onClick={() => exportPresets()}>导出全部预设</button>
              <button type="button" onClick={() => importRef.current?.click()}>导入JSON</button>
              <input ref={importRef} type="file" accept="application/json,.json" hidden onChange={event => {
                const file = event.target.files?.[0]; if (file) void importPresets(file); event.target.value = ''
              }}/></div><small className="developer-muted">按当前角色／皮肤与画面类型保存，导入或选择后不会自动应用。</small>
          </details>
        </>}
        {!scene && <p className="developer-muted">当前页面尚无可控制的画面。选择角色、皮肤或动态插画并等待加载完成。</p>}
        <details className="developer-section developer-help-section"><summary>使用说明</summary>
          <p className="developer-help">两个窗口可独立拖动、收起或关闭。跟随点选会定位画布选中的素材及重叠候选；也可用“定位缩略图”返回当前对象。点击磁贴会打开对应检查器。</p>
          <div className="developer-action-row"><button type="button" onClick={() => {
            draftsRef.current = {}; setDraftVersion(version => version + 1); setMessage('全部已加载画面已恢复原始效果。'); setError('')
          }}>恢复全部画面</button>
            {overrides.solo && <button type="button" onClick={() => replaceOverrides({ ...overrides, solo: undefined })}>取消独显</button>}</div>
          <p className="developer-help">点选会拦截画布上的游戏交互，动画不会自动暂停。候选按前后顺序排列，几何命中可能包含透明像素。隐藏、独显或调整透明度后，当前选择与候选会保留，便于恢复。</p>
          <p className="developer-help">透明度乘以动画当前值，动画隐藏的附件不会因调高透明度而出现。疑似遮罩标记仅用于定位；黑影可隐藏，裁切需单独禁用。</p>
          <p className="developer-help">“恢复单项”只清除当前对象的规则和针对它的独显，其他对象的设置保留。切回本地模式会恢复原效果，保存的命名预设保留。</p>
        </details>
      </div></div>
      </div>
    </aside>, document.body)}
    {browserPresence.present && createPortal(<aside id="developer-browser-window" ref={browserRef}
      className={`developer-panel developer-browser-panel${browserCollapsed ? ' developer-browser-collapsed' : ''}`}
      style={{ ...browserWindow.style, zIndex: activeWindow === 'browser' ? 10002 : 10001 }}
      onPointerDownCapture={() => setActiveWindow('browser')} onFocusCapture={() => setActiveWindow('browser')}
      aria-labelledby="developer-browser-heading" aria-hidden={!(enabled && browserOpen)} data-motion-phase={browserPresence.phase}>
      <div className="developer-panel-shell" ref={browserCollapse.shellRef}>
      <header className="developer-panel-header" {...browserWindow.headerEvents}>
        <div><small>LAYER LIBRARY</small><h2 id="developer-browser-heading">图层与遮罩</h2></div>
        <div className="developer-header-buttons">
          <button type="button" className="developer-inspector-entry" title="打开点选与调整面板" onClick={() => {
            setPanelOpen(true); setActiveWindow('inspector')
          }}>调整</button>
          <button type="button" title={browserCollapsed ? '展开磁贴' : '收起磁贴'} aria-label={browserCollapsed ? '展开图层磁贴' : '收起图层磁贴'}
            onClick={() => { thumbnailActiveRef.current = false; abortThumbnails(); browserCollapse.captureToggle(); setBrowserCollapsed(value => !value) }}>{browserCollapsed ? '+' : '−'}</button>
          <button type="button" aria-label="关闭图层磁贴" onClick={closeBrowser}>×</button>
        </div>
      </header>
      <div className="developer-collapse-content developer-browser-content" ref={browserCollapse.contentRef}
        hidden={!browserCollapse.contentPresent} aria-hidden={browserCollapsed}>
      <div className="developer-browser-scene developer-scene-select">
        <label htmlFor="developer-browser-scene">画面</label><select id="developer-browser-scene" value={sceneId} onChange={event => {
          manualSceneRef.current = true; setSceneId(event.target.value)
        }}>{!handles.length && <option value="">等待画面加载</option>}{handles.map(handle => <option key={handle.id} value={handle.id}>{handle.label}</option>)}</select>
        <button type="button" onClick={refresh}>刷新</button>
      </div>
      <div className="developer-browser-body">
        <DeveloperLayerTiles scene={scene?.id === sceneId ? scene : null} overrides={overrides} selected={selectedPick} onSelect={selectBrowserObject}
          locateRequest={tileLocateRequest} browserExpanded={enabled && browserOpen && !browserCollapsed && browserPresence.settled && !browserCollapse.animating}
          thumbnailVersion={thumbnailVersion} requestThumbnail={requestThumbnail}
          onUpdateRule={updateRule} onToggleSolo={toggleSolo}
          onRestoreObject={(kind, id) => replaceOverrides(restoreDeveloperObject(overrides, kind, id))}/>
      </div></div>
      </div>
    </aside>, document.body)}
  </DeveloperContext.Provider>
}
