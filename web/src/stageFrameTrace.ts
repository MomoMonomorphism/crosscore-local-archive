/** Opt-in DOM-readable measurements. No sampling or layout reads in normal use. */
const enabled = typeof location !== 'undefined' && new URLSearchParams(location.search).get('frameTrace') === '1'
const histories = new WeakMap<HTMLElement, { last: Map<string, string>; entries: unknown[] }>()
export function traceStageFrame(host: HTMLElement | null, source: string, frame: unknown) {
  if (!enabled || !host) return
  const stage = host.closest<HTMLElement>('.stage-wrap')
  if (!stage) return
  const rect = (element: Element | null) => {
    const r = element?.getBoundingClientRect()
    return r ? { x: r.x, y: r.y, width: r.width, height: r.height } : null
  }
  const data = { source, frame, stage: rect(stage),
    controls: rect(stage.parentElement?.querySelector('.control-deck') ?? null),
    playback: rect(stage.parentElement?.querySelector('.playback-row') ?? null) }
  const history = histories.get(stage) ?? { last: new Map<string, string>(), entries: [] }
  const key = JSON.stringify(data)
  if (history.last.get(source) === key) return
  history.last.set(source, key)
  history.entries.push({ atMs: performance.now(), ...data })
  if (history.entries.length > 120) history.entries.shift()
  histories.set(stage, history)
  stage.dataset.frameTrace = JSON.stringify(history.entries)
}
