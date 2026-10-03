import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { DeveloperOverrides, DeveloperPickCandidate, DeveloperRule, DeveloperScene, DeveloperThumbnail } from './developerControls'
import { canDisableDeveloperLayerClipping, createDeveloperLayerTiles, filterDeveloperLayerTiles,
  developerTileState, isSelectedDeveloperTile, type DeveloperLayerTile, type DeveloperTileTab } from './developerLayerTileModel'
import DeveloperTileThumbnail from './DeveloperTileThumbnail'
import { createDeveloperThumbnailVisibility, type DeveloperThumbnailVisibility } from './developerThumbnailVisibility'
import { centeredDeveloperTileScroll, createDeveloperTileScrollController, developerTileIdentity, eligibleDeveloperTileLocate, repairDeveloperTileFilters,
  type DeveloperTileFilters, type DeveloperTileLocateRequest } from './developerTileNavigation'

export type DeveloperLayerTilesProps = {
  scene: DeveloperScene | null
  overrides: DeveloperOverrides
  selected: DeveloperPickCandidate | null
  thumbnailVersion: number
  requestThumbnail: (candidate: DeveloperPickCandidate, signal?: AbortSignal) => Promise<DeveloperThumbnail | null>
  locateRequest: DeveloperTileLocateRequest | null
  browserExpanded: boolean
  onSelect: (candidate: DeveloperPickCandidate) => void
  onUpdateRule: (kind: 'layers' | 'slots', id: string, patch: DeveloperRule) => void
  onToggleSolo: (kind: 'layer' | 'slot', id: string) => void
  onRestoreObject: (kind: 'layer' | 'slot', id: string) => void
}

function TileTypeIcon({ tile }: { tile: DeveloperLayerTile }) {
  const clipping = tile.kind === 'slot' && tile.slot.type === 'clipping'
  return <span className={`developer-tile-icon${clipping ? ' developer-tile-icon-clip' : ''}`} aria-hidden="true">
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.4">
      {tile.kind === 'layer' ? <><path d="m10 3 7 4-7 4-7-4 7-4Z"/><path d="m3 10 7 4 7-4M3 13l7 4 7-4"/></>
        : clipping ? <><path d="M3 7V3h4m6 0h4v4m0 6v4h-4m-6 0H3v-4"/><path d="m7 7 6 6m0-6-6 6"/></>
          : tile.slot.type === 'mesh' ? <><path d="m4 4 12 1-1 11-11-1V4Z"/><path d="m4 4 11 12M4 15 16 5M4 4l6 6 5 6"/></>
            : <><path d="M3 3h14v14H3z"/><path d="m4 14 4-5 3 3 3-2 3 5"/><circle cx="13" cy="7" r="1"/></>}
    </svg>
  </span>
}

function tileType(tile: DeveloperLayerTile) {
  if (tile.kind === 'layer') return tile.mask ? '遮罩图层' : '图层'
  return tile.slot.type === 'clipping' ? '裁切槽位' : tile.mask ? '疑似遮罩' : tile.slot.type === 'mesh' ? '网格槽位'
    : tile.slot.type === 'empty' ? '空槽位' : '图片槽位'
}

const tabs: Array<{ id: DeveloperTileTab; label: string }> = [
  { id: 'layers', label: '图层' }, { id: 'slots', label: '槽位' }, { id: 'masks', label: '遮罩' },
]

/** Browser content only. Floating window lifecycle belongs to the provider. */
export default function DeveloperLayerTiles({ scene, overrides, selected, onSelect, onUpdateRule, onToggleSolo,
  onRestoreObject, thumbnailVersion, requestThumbnail, locateRequest, browserExpanded }: DeveloperLayerTilesProps) {
  const sceneId = scene?.id ?? ''
  const [ownedFilters, setOwnedFilters] = useState<DeveloperTileFilters & { sceneId: string }>({ sceneId, tab: 'layers', search: '', layerId: '' })
  const filters = ownedFilters.sceneId === sceneId ? ownedFilters : { sceneId, tab: 'layers' as const, search: '', layerId: '' }
  const { tab, search, layerId } = filters
  const updateFilters = (patch: Partial<DeveloperTileFilters>) => {
    // An explicit browser action takes over from an unfinished auto locate.
    // Its started token remains consumed so clearing a later search cannot
    // resurrect that request and unexpectedly pull the grid away again.
    cancelLocateMotion()
    setOwnedFilters(current => ({
      ...(current.sceneId === sceneId ? current : { sceneId, tab: 'layers' as const, search: '', layerId: '' }), ...patch,
    }))
  }
  const [pendingLocate, setPendingLocate] = useState<DeveloperTileLocateRequest | null>(null)
  const lastStartedToken = useRef(-1)
  const newestToken = useRef(-1)
  if (locateRequest && Number.isSafeInteger(locateRequest.token)) newestToken.current = Math.max(newestToken.current, locateRequest.token)
  const latestLocate = useRef({ sceneId, locateRequest, browserExpanded }); latestLocate.current = { sceneId, locateRequest, browserExpanded }
  const tileElements = useRef(new Map<string, HTMLElement>())
  const gridRef = useRef<HTMLDivElement>(null)
  const scrollController = useRef<ReturnType<typeof createDeveloperTileScrollController> | null>(null)
  if (!scrollController.current) scrollController.current = createDeveloperTileScrollController()
  const selectionCue = useRef<Animation | null>(null)
  const [reducedMotion, setReducedMotion] = useState(() => typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches)
  const cancelLocateMotion = useCallback(() => {
    scrollController.current?.cancel()
    selectionCue.current?.cancel()
    selectionCue.current = null
    setPendingLocate(null)
  }, [])
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const preference = window.matchMedia('(prefers-reduced-motion: reduce)')
    const update = () => setReducedMotion(preference.matches)
    update()
    preference.addEventListener('change', update)
    return () => preference.removeEventListener('change', update)
  }, [])
  useLayoutEffect(() => {
    scrollController.current?.cancel()
    selectionCue.current?.cancel()
    selectionCue.current = null
    // A locate already started before collapse is consumed. Expanding later
    // must not resume it over the user's newer scroll position; requests that
    // first arrive while collapsed are still eligible when opened.
    if (!browserExpanded) setPendingLocate(null)
    return () => {
      scrollController.current?.cancel()
      selectionCue.current?.cancel()
      selectionCue.current = null
    }
  }, [sceneId, browserExpanded, locateRequest?.token, reducedMotion])
  const visibilityRef = useRef<DeveloperThumbnailVisibility | null>(null)
  const observeThumbnail = useCallback((element: HTMLElement, callback: (visible: boolean) => void) => {
    const root = gridRef.current
    if (!root) return () => {}
    if (visibilityRef.current?.root !== root) {
      visibilityRef.current?.dispose()
      visibilityRef.current = createDeveloperThumbnailVisibility(root)
    }
    return visibilityRef.current.observe(element, callback)
  }, [])
  useEffect(() => () => { visibilityRef.current?.dispose(); visibilityRef.current = null }, [])
  const tiles = useMemo(() => createDeveloperLayerTiles(scene), [scene])
  const filtered = useMemo(() => filterDeveloperLayerTiles(tiles, tab, layerId, search), [tiles, tab, layerId, search])
  useEffect(() => {
    // Reset and locate share one transition, so a scene's default filters cannot
    // overwrite the new pending request after its repairs have been applied.
    const changedScene = ownedFilters.sceneId !== sceneId
    let next: DeveloperTileFilters = changedScene ? { tab: 'layers', search: '', layerId: '' } : ownedFilters
    if (changedScene || !locateRequest || locateRequest.sceneId !== sceneId || locateRequest.token < newestToken.current)
      setPendingLocate(null)
    if (eligibleDeveloperTileLocate(locateRequest, sceneId, browserExpanded, lastStartedToken.current, newestToken.current)) {
      const plan = repairDeveloperTileFilters(tiles, locateRequest.candidate, next)
      if (plan) {
        next = plan.filters
        lastStartedToken.current = locateRequest.token
        setPendingLocate(locateRequest)
      }
    }
    if (changedScene || next.tab !== ownedFilters.tab || next.search !== ownedFilters.search || next.layerId !== ownedFilters.layerId)
      setOwnedFilters({ sceneId, ...next })
  }, [sceneId, ownedFilters, tiles, locateRequest, browserExpanded])
  useLayoutEffect(() => {
    if (!pendingLocate || !browserExpanded || pendingLocate.sceneId !== sceneId
      || locateRequest?.token !== pendingLocate.token || pendingLocate.token < newestToken.current
      || !filtered.some(tile => developerTileIdentity(tile.candidate) === developerTileIdentity(pendingLocate.candidate))) return
    const frame = requestAnimationFrame(() => {
      const live = latestLocate.current
      if (!live.browserExpanded || live.sceneId !== pendingLocate.sceneId || live.locateRequest?.token !== pendingLocate.token
        || pendingLocate.token < newestToken.current || developerTileIdentity(live.locateRequest.candidate) !== developerTileIdentity(pendingLocate.candidate)) return
      const grid = gridRef.current, element = tileElements.current.get(developerTileIdentity(pendingLocate.candidate))
      if (!grid || !element || !grid.contains(element) || !grid.getClientRects().length || !element.getClientRects().length) return
      const top = centeredDeveloperTileScroll({ scrollTop: grid.scrollTop, scrollHeight: grid.scrollHeight, clientHeight: grid.clientHeight,
        gridTop: grid.getBoundingClientRect().top, clientTop: grid.clientTop, tileTop: element.getBoundingClientRect().top,
        tileHeight: element.getBoundingClientRect().height })
      if (top === null) return
      const current = () => {
        const latest = latestLocate.current
        return latest.browserExpanded && latest.sceneId === pendingLocate.sceneId && latest.locateRequest?.token === pendingLocate.token
          && pendingLocate.token >= newestToken.current && grid.isConnected && element.isConnected && grid.contains(element)
          && !!grid.getClientRects().length && !!element.getClientRects().length
      }
      scrollController.current!.locate(grid, top, reducedMotion, current, () => {
        selectionCue.current?.cancel()
        selectionCue.current = null
        // A single border reveal leaves the authored selection intact. Never
        // fade the tile contents or loop; a repeated locate may reveal it again.
        const reduceNow = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
        if (!reducedMotion && !reduceNow && typeof element.animate === 'function' && element.classList.contains('developer-tile-selected')) {
          const style = getComputedStyle(element)
          const cue = element.animate([
            { borderColor: 'rgba(255,151,111,0.18)', boxShadow: 'inset 0 0 0 2px rgba(238,146,113,0)' },
            { borderColor: style.borderColor, boxShadow: style.boxShadow },
          ], { duration: 220, easing: 'cubic-bezier(.2,.7,.25,1)', iterations: 1 })
          selectionCue.current = cue
          const release = () => { if (selectionCue.current === cue) selectionCue.current = null }
          cue.onfinish = release
          cue.oncancel = release
        }
        setPendingLocate(value => value?.token === pendingLocate.token ? null : value)
      })
    })
    return () => { cancelAnimationFrame(frame); scrollController.current?.cancel() }
  }, [pendingLocate, browserExpanded, sceneId, locateRequest, filtered, reducedMotion])

  return <div className="developer-layer-tiles">
    <div className="developer-tiles-toolbar">
      <div className="developer-tiles-tabs" aria-label="浏览对象类型">{tabs.map(item => {
        const count = filterDeveloperLayerTiles(tiles, item.id, layerId, search).length
        return <button key={item.id} type="button" aria-pressed={tab === item.id} className={tab === item.id ? 'developer-selected' : ''}
          onClick={() => updateFilters({ tab: item.id })}>{item.label} <small>{count}</small></button>
      })}</div>
      <div className="developer-tiles-filters">
        <input type="search" value={search} placeholder="搜索名称、附件或来源" aria-label="搜索图层、槽位或附件"
          onChange={event => updateFilters({ search: event.target.value })}/>
        <select aria-label="图层范围" value={layerId} onChange={event => updateFilters({ layerId: event.target.value })}>
          <option value="">全部图层</option>{scene?.layers.map(layer => <option value={layer.id} key={layer.id}>{layer.label}</option>)}
        </select>
        <button type="button" disabled={!search && !layerId} onClick={() => updateFilters({ search: '', layerId: '' })}>清除筛选</button>
      </div>
      <p className="developer-tiles-hint">资源缩略图 · 点击磁贴在主面板检视。{tab === 'masks' ? '疑似遮罩仅供定位，黑影用隐藏，裁切用禁用。' : '隐藏对象仍可预览。'}
        <span>{filtered.length} 项</span></p>
    </div>
    <div ref={gridRef} className="developer-tiles-grid" aria-label="图层与槽位磁贴"
      onWheelCapture={cancelLocateMotion} onPointerDownCapture={cancelLocateMotion}
      onKeyDownCapture={event => {
        if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) cancelLocateMotion()
      }} onScroll={event => { if (scrollController.current?.onScroll(event.currentTarget)) cancelLocateMotion() }}>
      {filtered.map(tile => {
        const candidate = tile.candidate
        const { ruleKey, rule, clipping, allowed, isSolo, forcedVisible, excluded, status, note, modified } = developerTileState(tile, overrides)
        const canBypass = tile.kind === 'layer' && canDisableDeveloperLayerClipping(tile.layer)
        const tileSelected = isSelectedDeveloperTile(tile, selected)
        const source = tile.kind === 'layer' ? tile.layer.assetId : tile.slot.attachment ?? '当前无附件'
        const owner = tile.kind === 'layer' ? tile.layer.kind : tile.layer?.label ?? tile.slot.layerId
        const identity = developerTileIdentity(candidate)
        return <article key={identity} ref={element => { if (element) tileElements.current.set(identity, element); else tileElements.current.delete(identity) }}
          className={`developer-tile${tileSelected ? ' developer-tile-selected' : ''}${!allowed || excluded ? ' developer-tile-hidden' : ''}`}
          data-developer-layer={tile.kind === 'layer' ? candidate.id : undefined} data-developer-slot={tile.kind === 'slot' ? candidate.id : undefined}>
          <button type="button" className="developer-tile-select" aria-pressed={tileSelected} aria-label={`检视${tileType(tile)} ${candidate.label}`}
            onClick={() => onSelect(selected?.kind === candidate.kind && selected.id === candidate.id
              ? { ...candidate, relatedClipping: selected.relatedClipping } : candidate)}>
            <DeveloperTileThumbnail candidate={candidate}
              requestKey={JSON.stringify([scene?.id, thumbnailVersion, tab, layerId, search, candidate.kind, candidate.id, candidate.attachment, candidate.type])}
              requestThumbnail={requestThumbnail} observe={observeThumbnail} fallback={<TileTypeIcon tile={tile}/>}/>
            <span className="developer-tile-heading"><span className="developer-tile-heading-copy">
              <small>{tileType(tile)}{tileSelected && <span className="developer-tile-selected-label"> · 已选中</span>}</small>
              <strong title={candidate.label}>{candidate.label}</strong></span></span>
            <span className="developer-tile-source" title={source}>{tile.kind === 'layer' ? '来源' : '附件'}：{source}</span>
            <span className="developer-tile-owner" title={owner}>{owner}</span>
            <span className="developer-tile-status"><span>{status}</span>{isSolo || forcedVisible ? <small>独显</small> : modified && <small>已调整</small>}</span>
            {note && <span className="developer-tile-note">{note}</span>}
          </button>
          <div className="developer-tile-actions">
            <button type="button" aria-label={`${clipping ? allowed ? '禁用裁切' : '启用裁切' : allowed || forcedVisible ? '隐藏' : '显示'} ${candidate.label}`}
              onClick={() => onUpdateRule(ruleKey, candidate.id, clipping ? { disableClipping: allowed }
                : { hidden: allowed || forcedVisible })}>{clipping ? allowed ? '禁用裁切' : '启用裁切' : allowed || forcedVisible ? '隐藏' : '显示'}</button>
            {!clipping && <button type="button" aria-pressed={isSolo} className={isSolo ? 'developer-selected' : ''}
              onClick={() => onToggleSolo(tile.kind, candidate.id)}>{isSolo ? '取消独显' : '独显'}</button>}
            {canBypass && <button type="button" aria-pressed={!!rule.disableClipping} onClick={() => onUpdateRule('layers', candidate.id,
              { disableClipping: !rule.disableClipping })}>{rule.disableClipping ? '恢复裁切' : '禁用裁切'}</button>}
            <button type="button" disabled={!modified} onClick={() => onRestoreObject(tile.kind, candidate.id)}>恢复</button>
            {tile.kind === 'layer' && <button type="button" className="developer-tile-browse-slots" onClick={() => updateFilters({ tab: 'slots', layerId: candidate.id })}>查看槽位</button>}
          </div>
        </article>
      })}
      {!filtered.length && <p className="developer-tiles-empty">{!scene ? '当前页面尚无可控制的画面，等待资源加载完成。'
        : !tiles.length ? '此画面暂无图层或槽位。' : '没有匹配的对象，可切换类型或清除筛选。'}</p>}
    </div>
  </div>
}
