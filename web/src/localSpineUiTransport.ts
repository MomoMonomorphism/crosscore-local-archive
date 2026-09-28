import { lua, lauxlib, lualib, to_luastring, to_jsstring } from 'fengari'
import type { UiNode } from './spineUiLayout'
import type { SpineUiCommand } from './SpineUiHost'
import { applyUiNodeDelta } from './spineUiDelta'

type Snapshot = { session?: string; nodes: UiNode[]; removed?: string[]; partial?: boolean;
  commands: SpineUiCommand[]; time: number; runtimeTiming?: { advanceMs: number; snapshotMs: number } }
type Message = Record<string, unknown>

const literal = (value: unknown): string => {
  if (value == null) return 'nil'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Invalid browser Lua number')
    return String(value)
  }
  if (typeof value === 'string') return JSON.stringify(value)
  if (Array.isArray(value)) return `{${value.map(literal).join(',')}}`
  if (typeof value === 'object') return `{${Object.entries(value).map(([key, item]) => `[${literal(key)}]=${literal(item)}`).join(',')}}`
  throw new Error('Unsupported browser Lua value')
}

const MODELS = new Set(['7003005', '7501003', '2008006', '7040003', '3018005'])

export function createLocalSpineUiTransport({ compactSteps = false } = {}) {
  let state: ReturnType<typeof lauxlib.luaL_newstate> | null = null
  let timeline = 0
  let session = ''
  let sequence = 0
  let lastWall = 0
  let nodes: UiNode[] = []
  const resourceUrls: string[] = []
  const audioUrls = new Map<string, string>()
  const assetUrl = (path: string) => `${import.meta.env.BASE_URL}${path.replace(/^\//, '')}`
  const release = () => {
    if (state) { lua.lua_close(state); state = null }
    for (const url of resourceUrls) URL.revokeObjectURL(url)
    resourceUrls.length = 0
    audioUrls.clear()
  }
  const run = (code: string, output = false): string | undefined => {
    if (!state) throw new Error('Browser Spine UI session is closed')
    const loaded = lauxlib.luaL_loadstring(state, to_luastring(code))
    if (loaded !== lua.LUA_OK) throw new Error(to_jsstring(lua.lua_tostring(state, -1)))
    const executed = lua.lua_pcall(state, 0, output ? 1 : 0, 0)
    if (executed !== lua.LUA_OK) throw new Error(to_jsstring(lua.lua_tostring(state, -1)))
    if (output) {
      const value = to_jsstring(lua.lua_tostring(state, -1))
      lua.lua_pop(state, 1)
      return value
    }
  }
  const snapshot = (full: boolean): Snapshot => {
    const data = JSON.parse(run(`return ${full ? 'snapshot' : 'snapshotDelta'}()`, true)!) as Snapshot
    data.commands = Array.isArray(data.commands) ? data.commands : []
    const updates = Array.isArray(data.nodes) ? data.nodes : []
    if (full) nodes = updates
    else if (compactSteps) return { ...data, session, nodes: updates, partial: true }
    else nodes = applyUiNodeDelta(nodes, updates, Array.isArray(data.removed) ? data.removed : [])
    return { ...data, session, nodes }
  }
  const send = async (message: Message): Promise<Snapshot> => {
    const op = message.op
    if (op === 'open') {
      const model = String(message.model)
      if (!MODELS.has(model)) throw new Error(`Unsupported browser Spine UI model: ${model}`)
      try {
        const [response, listResponse] = await Promise.all([
          fetch(assetUrl(`/offline/ui/${model}.lua`)), fetch(assetUrl(`/offline/ui/${model}.assets.json`)),
        ])
        if (!response.ok || !listResponse.ok) throw new Error('离线小游戏素材未准备好；运行 tools/prepare_offline_ui.py 并重新构建')
        let program = await response.text()
        const assetList = await listResponse.json() as { images: string[]; audio: string[] }
        const imageResults = await Promise.allSettled(assetList.images.map(async path => {
          const file = await fetch(assetUrl(path))
          if (!file.ok) throw new Error(`离线射击图片缺失：${path}`)
          const url = URL.createObjectURL(await file.blob())
          resourceUrls.push(url)
          return [path, url] as const
        }))
        const imageError = imageResults.find(result => result.status === 'rejected')
        if (imageError?.status === 'rejected') throw imageError.reason
        const imageUrls = imageResults.map(result => (result as PromiseFulfilledResult<readonly [string, string]>).value)
        for (const [path, url] of imageUrls) program = program.replaceAll(path, url)
        const audioResults = await Promise.allSettled(assetList.audio.map(async name => {
          const file = await fetch(assetUrl(`/offline/audio/${encodeURIComponent(name)}.wav`))
          if (!file.ok) throw new Error(`离线射击音效缺失：${name}`)
          const url = URL.createObjectURL(await file.blob())
          resourceUrls.push(url)
          audioUrls.set(name, url)
        }))
        const audioError = audioResults.find(result => result.status === 'rejected')
        if (audioError?.status === 'rejected') throw audioError.reason
        state = lauxlib.luaL_newstate()
        lualib.luaL_openlibs(state)
        timeline = 0; sequence = 0; lastWall = 0
        session = `browser:${Date.now()}`
        run(program)
        // Match the native session's per-round seed; tests can request a fixed seed.
        const seed = message.seed == null
          ? crypto.getRandomValues(new Uint32Array(1))[0] >>> 2
          : Number(message.seed)
        if (!Number.isInteger(seed) || seed < 0 || seed >= 2 ** 30)
          throw new Error('Invalid browser UI random seed')
        run(`boot(${seed})`)
        const first = snapshot(true)
        snapshot(false) // initialize delta state before the round starts
        return first
      } catch (error) { release(); throw error }
    }
    if (op === 'close') {
      if (state) { try { run('shutdown()') } finally { release() } }
      else release()
      return { nodes: [], commands: [], time: timeline }
    }
    if (op !== 'step' || !state || message.session !== session) throw new Error('Browser Spine UI session expired')
    const end = Number(message.endTime)
    const nextSequence = Number(message.sequence)
    if (nextSequence !== sequence + 1 || !Number.isFinite(end) || end < timeline || end - timeline > .100001)
      throw new Error('Invalid browser UI timeline')
    const events = message.timedInputs as { node: string; time: number; wall: number }[]
    const tracks = message.multiTracks ?? {}
    const advanceStarted = performance.now()
    run(`setMultiTracks(${literal(tracks)})`)
    run(`advance(0,${literal(Boolean(message.idle))},${literal(message.done ?? [])},{})`)
    let cursor = timeline
    for (const event of events) {
      if (!Number.isFinite(event.time) || !Number.isFinite(event.wall) ||
          event.time < cursor - 1e-9 || event.time > end + 1e-9 || event.wall < lastWall)
        throw new Error('Late or unordered browser input')
      run(`advance(${Math.max(0, event.time - cursor)},nil,{},{})`)
      run(`setUnscaledTime(${event.wall});advance(0,nil,{},${literal([event.node])})`)
      cursor = event.time
      lastWall = event.wall
    }
    run(`advance(${Math.max(0, end - cursor)},nil,{},{})`)
    timeline = end; sequence = nextSequence
    const snapshotStarted = performance.now()
    const data = snapshot(false)
    data.runtimeTiming = { advanceMs: snapshotStarted - advanceStarted,
      snapshotMs: performance.now() - snapshotStarted }
    return data
  }
  return Object.assign(send, { audioUrl: (name: string) => audioUrls.get(name) })
}
