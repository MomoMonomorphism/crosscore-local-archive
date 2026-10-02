import { useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import './spineUi.css'

export type SpineUiCommand = { type: string; index?: number; force?: boolean; token?: string; indexes?: number[]; cue?: number; name?: string; clip?: unknown; node?: string; outcome?: string }
import { layoutChildren, measure, rectBox, rotationCss } from './spineUiLayout'
import type { UiNode as Node } from './spineUiLayout'
import { UiImage } from './SpineUiImage'
import type { TrackState } from './interactionMachine'
import { UiClock } from './uiClock'
import { sitePath } from './sitePaths'
import { applyUiNodeDelta } from './spineUiDelta'
import { simplifyDisplay } from './simplifyDisplay'
type Snapshot = { session?: string; nodes: Node[]; removed?: string[]; partial?: boolean; commands: SpineUiCommand[];
  time: number; detail?: string; workerTiming?: { queueMs: number; runMs: number };
  runtimeTiming?: { advanceMs: number; snapshotMs: number } }
export const supportsSpineUi = (model: string) => ['7003005', '7501003', '2008006', '7040003', '3018005'].includes(model)
const rhythmPerfRequested = typeof window !== 'undefined'
  && new URLSearchParams(window.location.search).get('rhythmPerf') === '1'

async function request(body: object): Promise<Snapshot> {
  const response = await fetch('/api/spine-ui', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const data = await response.json()
  if (!response.ok) throw new Error(data.detail ?? `互动服务错误 ${response.status}`)
  return data
}

export function SpineUiHost({ model, idle, playing, speed, multiTracks, rolePosition, onCommand, onError }: {
  speed: number;
  multiTracks: Record<string, TrackState>;
  model: string; idle: boolean; playing: boolean; rolePosition: [number, number, number]; onCommand: (command: SpineUiCommand) => void; onError: (message: string) => void
}) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [error, setError] = useState('')
  const [size, setSize] = useState({ width: 1920, height: 1080 })
  const host = useRef<HTMLDivElement>(null)
  const clock = useRef(new UiClock(performance.now()))
  useEffect(() => {
    const sync = () => clock.current.configure(performance.now(), playing && !document.hidden, speed)
    sync(); document.addEventListener('visibilitychange', sync)
    return () => document.removeEventListener('visibilitychange', sync)
  }, [playing, speed])
  const latest = useRef({ idle, playing, speed, multiTracks, onCommand, onError });latest.current = { idle, playing, speed, multiTracks, onCommand, onError }
  const inputs = useRef<{ node: string; at: number; time: number; wall: number }[]>([])
  const epoch = useRef(performance.now())
  const wake = useRef<() => void>(() => {})
  const inputLog = useRef<object[]>([])
  const record = (entry: object) => { inputLog.current.push(entry);if (inputLog.current.length > 200) inputLog.current.shift() }
  const rhythmPerf = model === '7040003' && rhythmPerfRequested
  const perfHits = useRef<{ at: number; mode: string; maxFrameMs: number; callbackMs?: number;
    waitMs?: number; workerQueueMs?: number; advanceMs?: number; snapshotMs?: number }[]>([])
  const [perfReadout, setPerfReadout] = useState<{ mode: string; maxFrameMs: number; callbackMs?: number;
    waitMs?: number; workerQueueMs?: number; advanceMs?: number; snapshotMs?: number } | null>(null)
  useEffect(() => {
    if (!rhythmPerf) return
    let frame = 0, previous = performance.now()
    const tick = (now: number) => {
      for (const hit of perfHits.current) {
        if (now - hit.at <= 450) hit.maxFrameMs = Math.max(hit.maxFrameMs, now - previous)
        else setPerfReadout({ mode: hit.mode, maxFrameMs: hit.maxFrameMs,
          callbackMs: hit.callbackMs, waitMs: hit.waitMs, workerQueueMs: hit.workerQueueMs,
          advanceMs: hit.advanceMs, snapshotMs: hit.snapshotMs })
      }
      perfHits.current = perfHits.current.filter(hit => now - hit.at <= 450)
      previous = now
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => { cancelAnimationFrame(frame);perfHits.current = [] }
  }, [rhythmPerf])
  useEffect(() => {
    const target = window as Window & { __spineUiInputLog?: () => object[] }
    const reader = () => [...inputLog.current]
    target.__spineUiInputLog = reader
    return () => { if (target.__spineUiInputLog === reader) delete target.__spineUiInputLog }
  }, [])
  const soundPool = useRef(new Set<HTMLAudioElement>())
  const pausedSounds = useRef(new Set<HTMLAudioElement>())
  const rhythmAudioRef = useRef<AudioContext | null>(null)
  useEffect(() => {
    const syncAudio = () => {
      if (!playing || document.hidden) {
        if (rhythmAudioRef.current?.state === 'running') void rhythmAudioRef.current.suspend().catch(() => {})
        if (inputs.current.length) record({ phase: 'discard-on-pause', inputs: inputs.current, at: performance.now() })
        inputs.current = []
        for (const audio of soundPool.current) if (!audio.paused && !audio.ended) {
          pausedSounds.current.add(audio);audio.pause()
        }
      } else {
        if (rhythmAudioRef.current?.state === 'suspended') void rhythmAudioRef.current.resume().catch(() => {})
        for (const audio of pausedSounds.current) void audio.play().catch(() => {})
        pausedSounds.current.clear()
      }
    }
    syncAudio()
    document.addEventListener('visibilitychange', syncAudio)
    return () => document.removeEventListener('visibilitychange', syncAudio)
  }, [playing])
  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => setSize({ width: entry.contentRect.width, height: entry.contentRect.height }))
    if (host.current) observer.observe(host.current)
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    let disposed = false, failed = false, session = '', timer = 0, inFlight = false, requested = false
    const params = new URLSearchParams(window.location.search)
    const browserPrototype = import.meta.env.VITE_STATIC_DEMO === '1' || params.get('offlineUi') === '1'
      || (model === '3018005' && params.get('offlineShooting') === '1')
    const uiFrameMs = window.matchMedia('(hover: hover) and (pointer: fine)').matches ? 16 : 33
    let uiWorker: Worker | null = null
    let nextWorkerId = 0
    const pendingWorker = new Map<number, { resolve: (data: Snapshot) => void; reject: (error: Error) => void }>()
    const failWorker = (error: Error) => {
      for (const pending of pendingWorker.values()) pending.reject(error)
      pendingWorker.clear()
      uiWorker?.terminate()
      uiWorker = null
    }
    const send = async (body: Record<string, unknown>): Promise<Snapshot> => {
      if (!browserPrototype) return request(body)
      // Keep all browser-side Lua simulation away from touch input and Pixi drawing.
      if (!uiWorker) {
        uiWorker = new Worker(new URL('./spineUiWorker.ts', import.meta.url), { type: 'module' })
        uiWorker.onmessage = (event: MessageEvent<{ id: number; data?: Snapshot; error?: string }>) => {
          const { id, data, error } = event.data
          const pending = pendingWorker.get(id)
          if (!pending) return
          pendingWorker.delete(id)
          if (error) pending.reject(new Error(error))
          else if (data) pending.resolve(data)
          else pending.reject(new Error('Empty mini-game response'))
        }
        uiWorker.onerror = () => failWorker(new Error('Mini-game worker failed'))
      }
      return new Promise<Snapshot>((resolve, reject) => {
        const id = ++nextWorkerId
        pendingWorker.set(id, { resolve, reject })
        uiWorker!.postMessage({ id, body })
      })
    }
    let sequence = 0
    const done: string[] = []
    const sounds = soundPool.current
    const effectPool = new Map<string, HTMLAudioElement[]>()
    const audioUrl = (name: string) => sitePath(browserPrototype
      ? `offline/audio/${encodeURIComponent(name)}.wav`
      : `assets/spine-ui-audio/${encodeURIComponent(name)}.wav`)
    let rhythmAudio: AudioContext | null = null
    const rhythmBuffers = new Map<string, AudioBuffer>()
    const rhythmSources = new Set<AudioBufferSourceNode>()
    if (browserPrototype && model === '7040003') {
      // Decode the short rhythm effects before the first falling note. A normal
      // hit plays two of them together; media-element startup can block a phone's
      // main thread at exactly the moment the next frame is due.
      try { rhythmAudio = new AudioContext();rhythmAudioRef.current = rhythmAudio } catch { /* media element fallback below */ }
      for (let index = 1; index <= 4; index++) {
        const name = `LycorisRadiata_effects_0${index}`
        if (rhythmAudio) {
          const context = rhythmAudio
          void fetch(audioUrl(name)).then(response => {
            if (!response.ok) throw new Error(`Audio ${response.status}`)
            return response.arrayBuffer()
          }).then(bytes => context.decodeAudioData(bytes)).then(buffer => {
            if (!disposed) rhythmBuffers.set(name, buffer)
          }).catch(() => {})
        } else {
          const audio = new Audio(audioUrl(name))
          audio.preload = 'auto'
          audio.load()
          effectPool.set(name, [audio])
        }
      }
    }
    let bgm: HTMLAudioElement | null = null
    const completed = (event: Event) => done.push((event as CustomEvent<string>).detail)
    window.addEventListener('source-ui-complete', completed)
    const publish = (data: Snapshot) => {
      if (disposed) return
      setSnapshot(previous => data.partial && previous
        ? { ...data, partial: false, nodes: applyUiNodeDelta(previous.nodes, data.nodes,
          Array.isArray(data.removed) ? data.removed : []) }
        : data)
      for (const command of data.commands ?? []) {
        if (command.type === 'input-trace') { record({ phase: 'host', command, receivedAt: performance.now() });continue }
        if ((command.type === 'sound' || command.type === 'bgm') && command.name) {
          const isBgm = command.type === 'bgm'
          const decoded = !isBgm && rhythmBuffers.get(command.name)
          if (decoded && rhythmAudio) {
            const source = rhythmAudio.createBufferSource()
            source.buffer = decoded
            source.connect(rhythmAudio.destination)
            source.onended = () => { source.disconnect();rhythmSources.delete(source) }
            rhythmSources.add(source)
            if (latest.current.playing && !document.hidden) {
              void rhythmAudio.resume().catch(() => {})
              source.start()
            } else { source.disconnect();rhythmSources.delete(source) }
            continue
          }
          const pool = effectPool.get(command.name) ?? []
          const audio = !isBgm && pool.find(candidate => !sounds.has(candidate)) || new Audio(audioUrl(command.name))
          if (!isBgm && !pool.includes(audio)) { pool.push(audio);effectPool.set(command.name, pool) }
          if (!isBgm && audio.currentTime) audio.currentTime = 0
          audio.loop = isBgm
          if (audio.loop) { if (bgm) { bgm.pause();sounds.delete(bgm);pausedSounds.current.delete(bgm) };bgm = audio }
          sounds.add(audio);audio.onended = () => sounds.delete(audio)
          if (latest.current.playing && !document.hidden) void audio.play().catch(() => sounds.delete(audio))
          else pausedSounds.current.add(audio)
        } else if (command.type === 'stop-bgm') { if (bgm) { bgm.pause();pausedSounds.current.delete(bgm) } }
        else if (command.type === 'camera') window.dispatchEvent(new CustomEvent('source-ui-camera', { detail: command.clip }))
        else latest.current.onCommand(command)
      }
    }
    const step = async () => {
      if (disposed || failed || !session || inFlight) return
      inFlight = true; requested = false
      const dt = clock.current.take(performance.now())
      try {
        const running = !document.hidden && latest.current.playing
        const endTime = clock.current.frontier
        // Keep inputs beyond the bounded catch-up frontier queued until their actual time.
        const count = running ? inputs.current.findIndex(v => v.time > endTime + 1e-9) : 0
        const batch = running ? inputs.current.splice(0, count < 0 ? inputs.current.length : count) : []
        const sentAt = performance.now()
        if (batch.length) record({ phase: 'send', inputs: batch, sentAt, waitingMs: batch.map(v => sentAt - v.at) })
        if (rhythmPerf) for (const input of batch) {
          const hit = perfHits.current.find(item => item.at === input.at)
          if (hit) hit.waitMs = sentAt - input.at
        }
        const data = await send({ op: 'step', session, dt: running ? dt : 0,
          sequence: ++sequence, endTime,
          multiTracks: latest.current.multiTracks,
          idle: latest.current.idle, done: running ? done.splice(0) : [],
          timedInputs: batch.map(v => ({ node: v.node, time: v.time, wall: v.wall })) })
        if (rhythmPerf && batch.length) for (const input of batch) {
          const hit = perfHits.current.find(item => item.at === input.at)
          if (hit) {
            hit.callbackMs = performance.now() - input.at
            hit.workerQueueMs = data.workerTiming?.queueMs
            hit.advanceMs = data.runtimeTiming?.advanceMs
            hit.snapshotMs = data.runtimeTiming?.snapshotMs
          }
        }
        if (batch.length) record({ phase: 'response', sentAt, receivedAt: performance.now(), roundTripMs: performance.now() - sentAt })
        publish(data)
        inFlight = false
        // Keep the original update rate for moving desktop notes. Phones use a
        // lower rate to leave rendering time for touch input and Spine.
        if (!disposed) timer = window.setTimeout(step, requested || clock.current.catchingUp ? 0
          : browserPrototype ? Math.max(0, uiFrameMs - (performance.now() - sentAt)) : 33)
      } catch (err) {
        inFlight = false
        // A request can fail after its UI has been closed or replaced. Its error
        // belongs to the old session and must not reach the new interaction.
        if (disposed) return
        failed = true // A lost response may already have executed inputs; never retry it blindly.
        const message = String(err);setError(message);latest.current.onError(message)
      }
    }
    wake.current = () => {
      if (disposed || failed) return
      requested = true
      if (!inFlight && session) { clearTimeout(timer);void step() }
    }
    send({ op: 'open', model }).then(data => {
      session = data.session!
      if (disposed) { void send({ op: 'close', session }).catch(() => {});return }
      // Loading the prefab is outside its Lua lifecycle: don't charge that wait to the round.
      clock.current = new UiClock(performance.now())
      epoch.current = performance.now();inputs.current = []
      clock.current.configure(performance.now(), latest.current.playing && !document.hidden, latest.current.speed)
      publish(data);void step()
    }).catch(err => { if (!disposed) { setError(String(err));latest.current.onError(String(err)) } })
    return () => {
      disposed = true;clearTimeout(timer);window.removeEventListener('source-ui-complete', completed)
      wake.current = () => {}
      inputs.current = []
      for (const audio of sounds) audio.pause()
      sounds.clear();pausedSounds.current.clear()
      effectPool.clear()
      for (const source of rhythmSources) { source.onended = null;source.stop();source.disconnect() }
      rhythmSources.clear();rhythmBuffers.clear()
      if (rhythmAudio) void rhythmAudio.close().catch(() => {})
      if (rhythmAudioRef.current === rhythmAudio) rhythmAudioRef.current = null
      window.dispatchEvent(new CustomEvent('source-ui-camera', { detail: null }))
      if (uiWorker) {
        const worker = uiWorker
        if (session) void send({ op: 'close', session }).catch(() => {}).finally(() => worker.terminate())
        else worker.terminate()
      } else if (session) void send({ op: 'close', session }).catch(() => {})
    }
  }, [model])
  const nodes = snapshot?.nodes ?? []
  const queueInput = (node: string, callback?: string) => {
    if (!latest.current.playing || document.hidden) return
    const at = performance.now()
    if (rhythmPerf) perfHits.current.push({ at, mode: callback === 'OnClickTopMask' ? 'FEVER' : '普通阶段', maxFrameMs: 0 })
    // Resume during the trusted pointer gesture so decoded effects are ready
    // when the worker returns this hit's Lua commands.
    if (model === '7040003' && rhythmAudioRef.current?.state === 'suspended')
      void rhythmAudioRef.current.resume().catch(() => {})
    inputs.current.push({ node, at, time: clock.current.stamp(at), wall: (at - epoch.current) / 1000 })
    wake.current()
  }
  const children = new Map<string, Node[]>()
  for (const node of nodes) { const key = node.parent ?? '';children.set(key, [...(children.get(key) ?? []), node]) }
  const render = (node: Node, pw: number, ph: number, override?: CSSProperties, parentPivot = { x: .5, y: .5 }): React.ReactNode => {
    if (!node.active) return null
    const kids = (children.get(node.id) ?? []).filter(child => child.active)
    const dimensions = measure(node, children)
    const box = rectBox(node, pw, ph, dimensions, parentPivot)
    const w = typeof override?.width === 'number' ? override.width : box.width
    const h = typeof override?.height === 'number' ? override.height : box.height
    const pivot = node.rect?.m_Pivot ?? { x: 0.5, y: 0.5 }
    const style: CSSProperties = { position: 'absolute', ...box, width: w, height: h, opacity: node.alpha,
      transformOrigin: `${pivot.x * 100}% ${(1 - pivot.y) * 100}%`,
      transform: `translateZ(${node.localZ ?? 0}px) ${rotationCss(node)} scale(${node.sx},${node.sy})`, ...override }
    const positions = layoutChildren(node, kids, w, h, children)
    const childNodes = kids.map(child => render(child, w, h, positions.get(child.id), pivot))
    const maskStyle: CSSProperties = node.mask && node.image
      ? { maskImage: `url("${node.image}")`, maskSize: '100% 100%', maskRepeat: 'no-repeat' }
      : node.rectMask ? { overflow: 'hidden' } : {}
    return <div key={node.id} style={style} data-ui-node={node.name}>
      {(!node.mask || node.mask.showGraphic) && <UiImage node={node} width={w} height={h}
        time={node.material ? snapshot?.time ?? 0 : undefined} />}
      {node.text && <span style={{ position: 'absolute', inset: 0, color: 'white', fontSize: node.fontSize ?? 24, textAlign: 'center', whiteSpace: 'pre-wrap' }}>{simplifyDisplay(node.text)}</span>}
      {node.click && <button type="button" className="source-ui-hit" aria-label={labels[node.click] ?? node.click}
        disabled={!playing} title={labels[node.click] ?? node.click}
        onPointerDown={event => { if (event.button === 0) { event.preventDefault();queueInput(node.id, node.click) } }}
        onClick={event => { if (event.detail === 0) queueInput(node.id, node.click) }} />}
      {(node.mask || node.rectMask) ? <div style={{ position: 'absolute', inset: 0, ...maskStyle }}>{childNodes}</div> : childNodes}
    </div>
  }
  const unit = Math.min(size.width / 1920, size.height / 1080)
  const side = Math.max(0, (size.width - 1920 * unit) / 2)
  const top = Math.max(0, (size.height - 1080 * unit) / 2)
  // Melody's result gradient and effect roots use stretch anchors in the game
  // prefab. Extend that root canvas to the actual viewport while keeping its
  // centered ornaments at the original UI scale.
  const uiWidth = model === '2008006' && unit > 0 ? size.width / unit : 1920
  const uiHeight = model === '2008006' && unit > 0 ? size.height / unit : 1080
  return <div className="source-spine-ui" ref={host} data-runtime={import.meta.env.VITE_STATIC_DEMO === '1'
    || new URLSearchParams(window.location.search).get('offlineUi') === '1'
    || (model === '3018005' && new URLSearchParams(window.location.search).get('offlineShooting') === '1')
    ? 'browser-lua' : 'local-server'} onPointerDown={e => e.stopPropagation()} onPointerUp={e => e.stopPropagation()}>
    {!snapshot && !error && <div className="source-ui-message">正在载入互动界面…</div>}
    {error && <div className="source-ui-message">互动界面加载失败：{error}</div>}
    {rhythmPerf && <div style={{ position: 'absolute', zIndex: 20, top: 58, left: 12, padding: '7px 9px',
      background: '#101016e8', color: '#fff', font: '12px/1.5 monospace', pointerEvents: 'none' }}>
      节奏诊断 · {perfReadout?.mode ?? '等待点击'}<br />
      点击至回执：{perfReadout?.callbackMs == null ? '—' : `${Math.round(perfReadout.callbackMs)} ms`}<br />
      送入前等待：{perfReadout?.waitMs == null ? '—' : `${Math.round(perfReadout.waitMs)} ms`}<br />
      Worker 排队：{perfReadout?.workerQueueMs == null ? '—' : `${Math.round(perfReadout.workerQueueMs)} ms`}<br />
      Lua 推进：{perfReadout?.advanceMs == null ? '—' : `${Math.round(perfReadout.advanceMs)} ms`}<br />
      状态快照：{perfReadout?.snapshotMs == null ? '—' : `${Math.round(perfReadout.snapshotMs)} ms`}<br />
      点击后最大帧间隔：{perfReadout ? `${Math.round(perfReadout.maxFrameMs)} ms` : '—'}
    </div>}
    {model === '7040003' && <>
      {side > 0 && <><div className="source-ui-letterbox" style={{ inset: '0 auto 0 0', width: side }} />
        <div className="source-ui-letterbox" style={{ inset: '0 0 0 auto', width: side }} /></>}
      {top > 0 && <><div className="source-ui-letterbox" style={{ inset: '0 0 auto', height: top }} />
        <div className="source-ui-letterbox" style={{ inset: 'auto 0 0', height: top }} /></>}
    </>}
    {(children.get('') ?? []).map(n => <div key={n.id} style={{ position: 'absolute', zIndex: n.name === 'role' ? 2 : 8,
      width: uiWidth, height: uiHeight, left: (size.width - uiWidth * unit) / 2, top: (size.height - uiHeight * unit) / 2,
      transformOrigin: '0 0', transform: `scale(${unit})`, overflow: model === '7040003' ? 'hidden' : undefined }}>
      {render(n, uiWidth, uiHeight, n.name === 'role'
        ? { transformOrigin: '50% 50%', transform: `translate(${rolePosition[0]}px,${-rolePosition[1]}px) scale(${rolePosition[2]})` } : undefined)}
    </div>)}
  </div>
}
const labels: Record<string, string> = { OnClick1: '石头', OnClick2: '剪刀', OnClick3: '布', OnClickBack: '返回', OnClickOK: '确定',
  OnClickL: '左侧', OnClickR: '右侧', OnClickMask: '点击', OnClickTopMask: '互动', OnClickHead: '射击头部', OnClickBody: '射击身体' }
