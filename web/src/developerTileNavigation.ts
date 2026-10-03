import type { DeveloperPickCandidate } from './developerControls'
import { filterDeveloperLayerTiles, type DeveloperLayerTile, type DeveloperTileTab } from './developerLayerTileModel'

export type DeveloperTileLocateRequest = { sceneId: string; candidate: DeveloperPickCandidate; token: number }
export type DeveloperTileFilters = { tab: DeveloperTileTab; layerId: string; search: string }

export function developerTileIdentity(candidate: DeveloperPickCandidate): string {
  return JSON.stringify([candidate.kind, candidate.id, candidate.layerId])
}

export function eligibleDeveloperTileLocate(request: DeveloperTileLocateRequest | null, sceneId: string,
  expanded: boolean, lastStartedToken: number, newestToken = request?.token ?? -1): request is DeveloperTileLocateRequest {
  return !!request && expanded && request.sceneId === sceneId && Number.isSafeInteger(request.token)
    && request.token >= 0 && request.token > lastStartedToken && request.token >= newestToken
}

/** Change only the constraints that exclude this exact object. Names, image
 * URLs and even same-id objects in another layer cannot substitute for it. */
export function repairDeveloperTileFilters(tiles: readonly DeveloperLayerTile[], candidate: DeveloperPickCandidate,
  filters: DeveloperTileFilters): { tile: DeveloperLayerTile; filters: DeveloperTileFilters } | null {
  const tile = tiles.find(value => developerTileIdentity(value.candidate) === developerTileIdentity(candidate))
  if (!tile) return null
  const tab = filterDeveloperLayerTiles([tile], filters.tab, '', '').length ? filters.tab : tile.kind === 'slot' ? 'slots' : 'layers'
  const layerId = !filters.layerId || filters.layerId === tile.candidate.layerId ? filters.layerId
    : tile.layer ? tile.candidate.layerId : ''
  const search = filterDeveloperLayerTiles([tile], tab, layerId, filters.search).length ? filters.search : ''
  return { tile, filters: tab === filters.tab && layerId === filters.layerId && search === filters.search
    ? filters : { tab, layerId, search } }
}

/** Rectangles are viewport-relative; convert to the grid's own scroll space.
 * The caller scrolls only the grid, without changing document scroll/focus. */
export function centeredDeveloperTileScroll(metrics: { scrollTop: number; scrollHeight: number; clientHeight: number;
  gridTop: number; clientTop?: number; tileTop: number; tileHeight: number }): number | null {
  const { scrollTop, scrollHeight, clientHeight, gridTop, tileTop, tileHeight } = metrics
  const clientTop = metrics.clientTop ?? 0
  if (![scrollTop, scrollHeight, clientHeight, gridTop, clientTop, tileTop, tileHeight].every(Number.isFinite)
    || clientHeight <= 0 || tileHeight <= 0) return null
  const top = scrollTop + tileTop - gridTop - clientTop + tileHeight / 2 - clientHeight / 2
  return Math.max(0, Math.min(Math.max(0, scrollHeight - clientHeight), top))
}

/** Animate only nearby tiles. Traversing a large list would visit many thumbnail
 * observation regions and queue previews the user never intended to see. */
export function developerTileScrollDuration(from: number, to: number, viewportHeight: number, reducedMotion: boolean): number {
  const distance = Math.abs(to - from)
  return !reducedMotion && [from, to, viewportHeight].every(Number.isFinite) && viewportHeight > 0
    && distance > 2 && distance <= Math.min(360, viewportHeight * 0.6) ? 190 : 0
}

type DeveloperTileScrollTarget = { scrollTop: number; clientHeight: number }
type DeveloperTileScrollScheduler = {
  now: () => number
  request: (callback: (time: number) => void) => number
  cancel: (frame: number) => void
}

/** Own only the grid's scrollTop. Every replacement/cancellation invalidates
 * queued frames, including a callback already delivered by the scheduler. */
export function createDeveloperTileScrollController(scheduler: DeveloperTileScrollScheduler = {
  now: () => performance.now(), request: callback => requestAnimationFrame(callback), cancel: frame => cancelAnimationFrame(frame),
}) {
  let generation = 0
  let frame: number | null = null
  let active: { target: DeveloperTileScrollTarget; lastWritten: number } | null = null
  const cancel = () => {
    generation++
    if (frame !== null) scheduler.cancel(frame)
    frame = null
    active = null
  }
  const locate = (target: DeveloperTileScrollTarget, top: number, reducedMotion: boolean,
    current: () => boolean, complete: () => void) => {
    cancel()
    const version = generation
    if (!Number.isFinite(top) || !Number.isFinite(target.scrollTop) || !current()) return
    const from = target.scrollTop
    const duration = developerTileScrollDuration(from, top, target.clientHeight, reducedMotion)
    if (!duration) {
      target.scrollTop = top
      complete()
      return
    }
    active = { target, lastWritten: from }
    const started = scheduler.now()
    const tick = (time: number) => {
      if (version !== generation || !active) return
      if (!current()) { cancel(); return }
      const progress = Math.max(0, Math.min(1, (time - started) / duration))
      const next = from + (top - from) * (1 - Math.pow(1 - progress, 3))
      active.lastWritten = next
      target.scrollTop = next
      if (progress < 1) frame = scheduler.request(tick)
      else {
        frame = null
        active = null
        complete()
      }
    }
    frame = scheduler.request(tick)
  }
  const onScroll = (target: DeveloperTileScrollTarget) => {
    // Programmatic scroll events can be delayed/coalesced. Compare the current
    // position with the most recent write instead of treating every event as
    // user input; wheel/pointer/keyboard intent is also cancelled by the UI.
    if (active?.target !== target || Math.abs(target.scrollTop - active.lastWritten) <= 2) return false
    cancel()
    return true
  }
  return { locate, cancel, onScroll }
}
