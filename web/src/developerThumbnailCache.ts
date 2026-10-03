import type { DeveloperPickCandidate, DeveloperSceneHandle, DeveloperThumbnail } from './developerControls'

type ThumbnailJob = { key: string; sceneId: string; handle: DeveloperSceneHandle; candidate: DeveloperPickCandidate;
  subscribers: Map<symbol, (value: DeveloperThumbnail | null) => void>; resolve: (value: DeveloperThumbnail | null) => void }

/** Visible tiles share requests. Work is limited per frame and cached image
 * strings are bounded; no decoded atlas or disposed renderer is retained. */
export function createDeveloperThumbnailCache(resolveScene: (id: string) => DeveloperSceneHandle | undefined, options: {
  schedule?: (callback: () => void) => number; cancel?: (id: number) => void;
  maxEntries?: number; maxBytes?: number; perFrame?: number
} = {}) {
  const schedule = options.schedule ?? (callback => requestAnimationFrame(callback))
  const cancel = options.cancel ?? cancelAnimationFrame
  const capacity = Math.max(1, options.maxEntries ?? 160)
  const byteLimit = Math.max(1, options.maxBytes ?? 12 * 1024 * 1024)
  const perFrame = Math.max(1, options.perFrame ?? 2)
  const cache = new Map<string, { sceneId: string; handle: DeveloperSceneHandle; value: DeveloperThumbnail | null; bytes: number }>()
  const pending = new Map<string, ThumbnailJob>()
  let queue: ThumbnailJob[] = [], frame: number | null = null, bytes = 0
  const deleteCached = (key: string) => { const value = cache.get(key); if (value) bytes -= value.bytes; cache.delete(key) }
  const enqueueFrame = () => { if (frame === null && queue.length) frame = schedule(pump) }
  const pump = () => {
    frame = null
    for (let count = 0; count < perFrame && queue.length; count++) {
      const job = queue.shift()!
      if (pending.get(job.key) !== job) continue
      pending.delete(job.key)
      let value: DeveloperThumbnail | null = null
      if (resolveScene(job.sceneId) === job.handle) {
        try { value = job.handle.thumbnail?.(job.candidate) ?? null } catch { /* Missing/tainted texture is a tile fallback. */ }
        const size = value ? value.url.length * 2 : 0
        if (size <= byteLimit) {
          deleteCached(job.key)
          cache.set(job.key, { sceneId: job.sceneId, handle: job.handle, value, bytes: size }); bytes += size
          while (cache.size > capacity || bytes > byteLimit) deleteCached(cache.keys().next().value!)
        }
      }
      job.resolve(value)
    }
    enqueueFrame()
  }
  const invalidate = (sceneId?: string) => {
    for (const [key, value] of cache) if (!sceneId || value.sceneId === sceneId) deleteCached(key)
    for (const [key, job] of pending) if (!sceneId || job.sceneId === sceneId) { pending.delete(key); job.resolve(null) }
    queue = queue.filter(job => pending.get(job.key) === job)
    if (!queue.length && frame !== null) { cancel(frame); frame = null }
  }
  const subscribe = (job: ThumbnailJob, signal?: AbortSignal) => new Promise<DeveloperThumbnail | null>(resolve => {
    const subscriber = Symbol()
    const settle = (value: DeveloperThumbnail | null) => {
      signal?.removeEventListener('abort', abort)
      job.subscribers.delete(subscriber)
      resolve(value)
    }
    const abort = () => {
      settle(null)
      if (!job.subscribers.size && pending.get(job.key) === job) {
        pending.delete(job.key)
        queue = queue.filter(queued => queued !== job)
        if (!queue.length && frame !== null) { cancel(frame); frame = null }
      }
    }
    job.subscribers.set(subscriber, settle)
    signal?.addEventListener('abort', abort, { once: true })
  })
  return {
    request(sceneId: string, candidate: DeveloperPickCandidate, signal?: AbortSignal): Promise<DeveloperThumbnail | null> {
      if (signal?.aborted) return Promise.resolve(null)
      const handle = resolveScene(sceneId)
      if (!handle?.thumbnail) return Promise.resolve(null)
      const key = JSON.stringify([sceneId, candidate.kind, candidate.layerId, candidate.id, candidate.attachment ?? null, candidate.type ?? null])
      const cached = cache.get(key)
      if (cached?.handle === handle) { cache.delete(key); cache.set(key, cached); return Promise.resolve(cached.value) }
      if (cached) deleteCached(key)
      const active = pending.get(key)
      if (active?.handle === handle) return subscribe(active, signal)
      if (active) { pending.delete(key); active.resolve(null) }
      const subscribers: ThumbnailJob['subscribers'] = new Map()
      const job: ThumbnailJob = { key, sceneId, handle, candidate: { ...candidate }, subscribers,
        resolve: value => { for (const done of subscribers.values()) done(value) } }
      const promise = subscribe(job, signal)
      pending.set(key, job); queue.push(job); enqueueFrame()
      return promise
    },
    invalidate,
    stats: () => ({ entries: cache.size, bytes, pending: pending.size }),
  }
}
