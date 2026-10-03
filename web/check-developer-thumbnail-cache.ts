import assert from 'node:assert/strict'
import { createDeveloperThumbnailCache } from './src/developerThumbnailCache.ts'
import type { DeveloperPickCandidate, DeveloperSceneHandle, DeveloperThumbnail } from './src/developerControls.ts'

const candidate = (id: string, attachment = 'image'): DeveloperPickCandidate => ({
  id, kind: 'slot', layerId: 'main', label: id, attachment, type: 'mesh',
})
const image = (url: string): DeveloperThumbnail => ({ url, width: 128, height: 128, kind: 'texture' })
const make = (options: { maxEntries?: number; maxBytes?: number; perFrame?: number } = {}) => {
  let next = 0, calls = 0
  const frames = new Map<number, () => void>()
  const scenes = new Map<string, DeveloperSceneHandle>()
  const handle: DeveloperSceneHandle = { id: 'scene', label: 'test',
    snapshot: () => ({ id: 'scene', label: 'test', layers: [], slots: [] }),
    thumbnail: value => { calls++; return image(value.id + ':' + value.attachment) },
  }
  scenes.set('scene', handle)
  const cache = createDeveloperThumbnailCache(id => scenes.get(id), { ...options,
    schedule: callback => { const id = ++next; frames.set(id, callback); return id },
    cancel: id => { frames.delete(id) },
  })
  const tick = () => {
    const entry = frames.entries().next().value as [number, () => void] | undefined
    if (entry) { frames.delete(entry[0]); entry[1]() }
  }
  return { cache, frames, scenes, handle, tick, calls: () => calls }
}

// The tile count is not the work count: requests are shared and at most two
// crops are made per frame. Attachment metadata must select a distinct image.
{
  const env = make()
  const first = env.cache.request('scene', candidate('a'))
  const shared = env.cache.request('scene', candidate('a'))
  const second = env.cache.request('scene', candidate('b'))
  const third = env.cache.request('scene', candidate('a', 'closed'))
  assert.equal(env.calls(), 0)
  assert.equal(env.frames.size, 1)
  env.tick()
  assert.equal(env.calls(), 2)
  assert.equal(env.cache.stats().pending, 1)
  assert.deepEqual(await first, await shared)
  assert.equal((await second)?.url, 'b:image')
  env.tick()
  assert.equal((await third)?.url, 'a:closed')
  assert.equal(env.calls(), 3)
  assert.equal((await env.cache.request('scene', candidate('a')))?.url, 'a:image')
  assert.equal(env.calls(), 3)
}

// A disappearing tile cancels only its subscription. When every interested
// tile leaves, no crop or queued frame is allowed to survive.
{
  const env = make()
  const one = new AbortController(), two = new AbortController()
  const first = env.cache.request('scene', candidate('a'), one.signal)
  const shared = env.cache.request('scene', candidate('a'), two.signal)
  one.abort()
  assert.equal(await first, null)
  assert.equal(env.cache.stats().pending, 1)
  env.tick()
  assert.equal((await shared)?.url, 'a:image')
  assert.equal(env.calls(), 1)
  const last = new AbortController()
  const cancelled = env.cache.request('scene', candidate('b'), last.signal)
  last.abort()
  assert.equal(await cancelled, null)
  assert.equal(env.cache.stats().pending, 0)
  assert.equal(env.frames.size, 0)
  env.tick()
  assert.equal(env.calls(), 1)
  assert.equal(await env.cache.request('scene', candidate('c'), last.signal), null)
}

// A scene replaced while queued cannot run its old renderer closure. Explicit
// disposal removes both cached images and waiting consumers.
{
  const env = make()
  const stale = env.cache.request('scene', candidate('a'))
  env.scenes.set('scene', { ...env.handle, thumbnail: () => image('replacement') })
  env.tick()
  assert.equal(await stale, null)
  assert.equal(env.calls(), 0)
  assert.equal(env.cache.stats().entries, 0)
  const fresh = env.cache.request('scene', candidate('a'))
  env.tick()
  assert.equal((await fresh)?.url, 'replacement')
  const queued = env.cache.request('scene', candidate('b'))
  env.cache.invalidate('scene')
  assert.equal(await queued, null)
  assert.deepEqual(env.cache.stats(), { entries: 0, bytes: 0, pending: 0 })
  assert.equal(env.frames.size, 0)
  env.scenes.delete('scene')
  assert.equal(await env.cache.request('scene', candidate('a')), null)
}

// Recently viewed resources remain available within a bounded LRU. Byte limits
// are respected even when a renderer returns an oversized or missing preview.
{
  const env = make({ maxEntries: 2 })
  const get = async (id: string) => { const result = env.cache.request('scene', candidate(id)); env.tick(); return result }
  await get('a'); await get('b')
  await env.cache.request('scene', candidate('a')) // Touch a; b should be evicted.
  await get('c')
  assert.equal(env.cache.stats().entries, 2)
  await env.cache.request('scene', candidate('a'))
  assert.equal(env.calls(), 3)
  await get('b')
  assert.equal(env.calls(), 4)
  const limited = make({ maxBytes: 4 })
  const tooLarge = limited.cache.request('scene', candidate('long'))
  limited.tick()
  assert.equal((await tooLarge)?.url, 'long:image')
  assert.equal(limited.cache.stats().bytes, 0)
  assert.equal(limited.cache.stats().entries, 0)
  limited.handle.thumbnail = () => { throw new Error('source destroyed') }
  const absent = limited.cache.request('scene', candidate('absent'))
  limited.tick()
  assert.equal(await absent, null)
  assert.equal(await limited.cache.request('scene', candidate('absent')), null)
  limited.cache.invalidate()
  assert.deepEqual(limited.cache.stats(), { entries: 0, bytes: 0, pending: 0 })
}

console.log('Developer thumbnail cache checks passed: lazy scheduling, sharing, abort, scene disposal, metadata, and bounded LRU.')
