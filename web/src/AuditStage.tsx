import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import SpineStage, { type SpineAuditMeasurement } from './SpineStage'
import type { Manifest, Variant } from './types'

type AuditRecord = SpineAuditMeasurement & {
  variantId: string
  entryId: string
  entryTitle: string
  variantLabel: string
  category: string
  folder: string
  sourceName: string
  flags: string[]
  error?: string
  auditedAt: string
}

type AuditManifest = {
  manifestRevision: string
  generatedAt: string
  results: Record<string, AuditRecord>
}

type QueueItem = { entryId: string; entryTitle: string; category: string; variant: Variant }
const INFORMATIONAL_FLAGS = new Set(['inflated-metadata-bounds'])
const FLAG_LABELS: Record<string, string> = {
  'no-visible-bounds': '没有可见骨骼边界',
  'blank-render': '画面为空',
  'tiny-on-screen': '画面过小',
  'screen-clipped': '画面超出取景框',
  'extreme-aspect': '画面比例异常',
  'inflated-metadata-bounds': '原始包围盒偏大',
  'effect-load-failure': '特效加载失败',
  'no-animation': '缺少动作',
  'load-error': '资源加载失败',
  'load-timeout': '资源加载超时',
}
type AuditOptions = { autorun: boolean; shards: number; shard: number; retry: 'blank' | null }

const classify = (measurement: SpineAuditMeasurement) => {
  const flags: string[] = []
  const visible = measurement.mainVisibleBounds
  const declared = measurement.declaredBounds
  if (!visible || !visible.width || !visible.height) flags.push('no-visible-bounds')
  if (!measurement.screenAlphaBounds || measurement.alphaPixelRatio <= 0.00005) flags.push('blank-render')
  if (measurement.alphaBoundsRatio > 0 && measurement.alphaBoundsRatio < 0.08) flags.push('tiny-on-screen')
  if (measurement.alphaBoundsRatio > 0.98) flags.push('screen-clipped')
  if (visible) {
    const aspect = visible.width / visible.height
    if (aspect < 0.06 || aspect > 16) flags.push('extreme-aspect')
    const visibleArea = visible.width * visible.height
    const declaredArea = declared.width * declared.height
    if (visibleArea > 0 && declaredArea / visibleArea > 20) flags.push('inflated-metadata-bounds')
  }
  if (measurement.loadedEffects !== measurement.totalEffects) flags.push('effect-load-failure')
  if (!measurement.animationCount) flags.push('no-animation')
  return flags
}

const formatPercent = (value: number) => `${(value * 100).toFixed(2)}%`

const emptyMeasurement = (totalEffects: number): SpineAuditMeasurement => ({
  visibleBounds: null,
  mainVisibleBounds: null,
  declaredBounds: { x: 0, y: 0, width: 0, height: 0 },
  localBounds: { x: 0, y: 0, width: 0, height: 0 },
  screenAlphaBounds: null,
  alphaPixelRatio: 0,
  alphaBoundsRatio: 0,
  sampledAnimationTime: null,
  sampledAnimationName: null,
  animationCount: 0,
  loadedEffects: 0,
  totalEffects,
  failedEffects: [],
})

export default function AuditStage({
  navigate,
  options,
}: {
  navigate: (view: 'gallery' | 'asmr' | 'picture' | 'audit') => void
  options: AuditOptions
}) {
  const shardCount = options.shards
  const shardIndex = Math.max(0, Math.min(shardCount - 1, options.shard))
  const retryBlank = options.retry === 'blank'
  const [manifest, setManifest] = useState<Manifest | null>(null)
  const [saved, setSaved] = useState<AuditManifest | null>(null)
  const [running, setRunning] = useState(options.autorun)
  const [activeIndex, setActiveIndex] = useState(0)
  const [runtimeError, setRuntimeError] = useState('')
  const [status, setStatus] = useState('正在读取资源清单…')
  const [findingFilter, setFindingFilter] = useState<'failures' | 'info'>('failures')
  const handledRef = useRef('')

  useEffect(() => {
    Promise.all([
      fetch('/api/manifest').then((response) => response.ok
        ? response.json() as Promise<Manifest> : Promise.reject(new Error(`资源清单读取失败：HTTP ${response.status}`))),
      fetch('/api/spine-audit').then((response) => response.ok ? response.json() as Promise<AuditManifest> : null),
    ]).then(([nextManifest, nextSaved]) => {
      setManifest(nextManifest)
      setSaved(nextSaved?.manifestRevision === nextManifest.revision ? nextSaved : {
        manifestRevision: nextManifest.revision,
        generatedAt: new Date().toISOString(),
        results: {},
      })
      setStatus('巡检器已就绪')
    }).catch((reason) => setRuntimeError(reason instanceof Error ? reason.message : String(reason)))
  }, [])

  const allQueue = useMemo<QueueItem[]>(() => manifest?.entries.flatMap((entry) => entry.variants.map((variant) => ({
    entryId: entry.id,
    entryTitle: entry.title,
    category: entry.category,
    variant,
  }))) ?? [], [manifest])
  const queue = useMemo(() => allQueue.filter((_, index) => index % shardCount === shardIndex), [allQueue])
  const completed = saved ? Object.keys(saved.results).length : 0
  const current = queue[activeIndex]
  const needsAudit = useCallback((item: QueueItem, state: AuditManifest) => {
    const prior = state.results[item.variant.id]
    return !prior || (retryBlank && prior.flags.includes('blank-render'))
  }, [])

  useEffect(() => {
    if (!queue.length || !saved) return
    const firstPending = queue.findIndex((item) => needsAudit(item, saved))
    setActiveIndex(firstPending >= 0 ? firstPending : queue.length)
  }, [needsAudit, queue, saved?.manifestRevision])

  const persist = useCallback(async (record: AuditRecord) => {
    if (!manifest) return
    const response = await fetch('/api/spine-audit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ manifestRevision: manifest.revision, record }),
    })
    if (!response.ok) throw new Error(`巡检结果保存失败：HTTP ${response.status}`)
    const next = await response.json() as AuditManifest
    setSaved(next)
    const nextPending = queue.findIndex((item, index) => index > activeIndex && needsAudit(item, next))
    if (nextPending >= 0) setActiveIndex(nextPending)
    else {
      const anyPending = queue.findIndex((item) => needsAudit(item, next))
      setActiveIndex(anyPending >= 0 ? anyPending : queue.length)
      if (anyPending < 0) setRunning(false)
    }
  }, [activeIndex, manifest, needsAudit, queue])

  const finish = useCallback((measurement: SpineAuditMeasurement) => {
    if (!current || handledRef.current === current.variant.id) return
    handledRef.current = current.variant.id
    const record: AuditRecord = {
      ...measurement,
      variantId: current.variant.id,
      entryId: current.entryId,
      entryTitle: current.entryTitle,
      variantLabel: current.variant.label,
      category: current.category,
      folder: current.variant.main.folder,
      sourceName: current.variant.main.sourceName,
      flags: classify(measurement),
      auditedAt: new Date().toISOString(),
    }
    void persist(record).catch((reason) => {
      setRuntimeError(reason instanceof Error ? reason.message : String(reason))
      setRunning(false)
    })
  }, [current, persist])

  const fail = useCallback((message: string) => {
    setRuntimeError(message)
    if (!current || handledRef.current === current.variant.id) return
    handledRef.current = current.variant.id
    void persist({
      ...emptyMeasurement(current.variant.effects.length),
      variantId: current.variant.id,
      entryId: current.entryId,
      entryTitle: current.entryTitle,
      variantLabel: current.variant.label,
      category: current.category,
      folder: current.variant.main.folder,
      sourceName: current.variant.main.sourceName,
      flags: ['load-error'],
      error: message,
      auditedAt: new Date().toISOString(),
    }).catch((reason) => {
      setRuntimeError(reason instanceof Error ? reason.message : String(reason))
      setRunning(false)
    })
  }, [current, persist])

  useEffect(() => {
    handledRef.current = ''
    setRuntimeError('')
    if (!running || !current) return
    const timer = window.setTimeout(() => {
      if (handledRef.current === current.variant.id) return
      handledRef.current = current.variant.id
      const empty = emptyMeasurement(current.variant.effects.length)
      void persist({
        ...empty,
        variantId: current.variant.id,
        entryId: current.entryId,
        entryTitle: current.entryTitle,
        variantLabel: current.variant.label,
        category: current.category,
        folder: current.variant.main.folder,
        sourceName: current.variant.main.sourceName,
        flags: ['load-timeout'],
        auditedAt: new Date().toISOString(),
      })
    }, 45000)
    return () => window.clearTimeout(timer)
  }, [current, persist, running])

  const flagged = useMemo(() => Object.values(saved?.results ?? {}).filter((item) => item.flags.length), [saved])
  const functionalFailures = useMemo(
    () => flagged.filter((item) => item.flags.some((flag) => !INFORMATIONAL_FLAGS.has(flag))),
    [flagged],
  )
  const informational = useMemo(
    () => flagged.filter((item) => item.flags.every((flag) => INFORMATIONAL_FLAGS.has(flag))),
    [flagged],
  )
  const pendingCount = saved ? queue.filter((item) => needsAudit(item, saved)).length : queue.length
  const visibleFindings = findingFilter === 'failures' ? functionalFailures : informational
  const progress = allQueue.length ? completed / allQueue.length : 0

  return (
    <main className="audit-shell">
      <header className="audit-header">
        <div><span className="eyebrow">CROSSCORE // DIAGNOSTICS</span><h1>Spine 资源巡检</h1>
          <p>逐个加载并渲染骨骼资源，检查空画面、异常取景与特效加载。结果保存在本机。</p></div>
        <nav className="tabs">
          <button onClick={() => navigate('gallery')}>角色立绘</button>
          <button onClick={() => navigate('asmr')}>ASMR</button>
          <button onClick={() => navigate('picture')}>插画档案</button>
          <button className="active">诊断工具</button>
        </nav>
      </header>
      <section className="audit-summary">
        <div><strong>{completed}</strong><span>/ {allQueue.length} 已完成</span></div>
        <div><strong>{functionalFailures.length}</strong><span>功能异常</span></div>
        <div><strong>{informational.length}</strong><span>元数据提示</span></div>
        <div><strong>{pendingCount}</strong><span>本次待检查</span></div>
        <button onClick={() => setRunning((value) => !value)} disabled={!manifest || (!running && pendingCount === 0)}>
          {running ? '暂停巡检' : pendingCount === 0 && manifest ? '巡检完成' : completed ? '继续巡检' : '开始巡检'}</button>
      </section>
      <p className="audit-run-note">打开页面只读取上次结果；全量检查需手动开始。{shardCount > 1
        ? `当前为分片 ${shardIndex + 1}/${shardCount}，待检查数仅统计此分片。` : ''}
        {completed > 0 && saved ? ` 最近结果：${new Date(saved.generatedAt).toLocaleString('zh-CN')}。` : ''}</p>
      <div className="audit-progress"><i style={{ width: `${progress * 100}%` }} /></div>
      <section className="audit-body">
        <div className="audit-preview">
          {running && current ? <>
            <div className="audit-current"><strong>{current.entryTitle}</strong><span>{current.variant.label} · 分片 {shardIndex + 1}/{shardCount} · {activeIndex + 1}/{queue.length}</span></div>
            <SpineStage
              key={current.variant.id}
              asset={current.variant.main}
              effects={current.variant.effects}
              animation={null}
              playing={false}
              speed={1}
              effectsVisible
              flipped={false}
              zoom={1}
              pan={{ x: 0, y: 0 }}
              persistentStates={[]}
              hiddenLayerIds={[]}
              onZoomChange={() => undefined}
              onPanChange={() => undefined}
              onMetadata={() => undefined}
              onStatus={setStatus}
              onError={fail}
              onAudit={finish}
            />
          </> : <div className="audit-idle"><strong>{completed >= allQueue.length && allQueue.length ? '全量巡检完成'
            : completed ? '等待继续巡检' : '尚未运行巡检'}</strong><span>{status}</span></div>}
          {runtimeError && <div className="audit-error">{runtimeError}</div>}
        </div>
        <div className="audit-findings">
          <div className="audit-findings-header"><div><span className="eyebrow">SAVED RESULTS</span><h2>巡检结果</h2></div>
            <small>{completed} / {allQueue.length} 已检查</small></div>
          <div className="audit-finding-tabs" aria-label="结果分类">
            <button className={findingFilter === 'failures' ? 'active' : ''} onClick={() => setFindingFilter('failures')}>
              需要处理 · {functionalFailures.length}</button>
            <button className={findingFilter === 'info' ? 'active' : ''} onClick={() => setFindingFilter('info')}>
              仅供参考 · {informational.length}</button>
          </div>
          {!completed && <p>还没有巡检记录。点击“开始巡检”后，异常会显示在这里。</p>}
          {completed > 0 && !visibleFindings.length && <p>{findingFilter === 'failures'
            ? '已检查的资源没有发现需要处理的异常。' : '已检查的资源没有元数据提示。'}</p>}
          {visibleFindings.map((item) => <a
            className={item.flags.every((flag) => INFORMATIONAL_FLAGS.has(flag)) ? 'informational' : ''}
            key={item.variantId}
            href={`/?entry=${encodeURIComponent(item.entryId)}&variant=${encodeURIComponent(item.variantId)}`}
          >
            <strong>{item.entryTitle} · {item.variantLabel}</strong>
            <span>{item.flags.map((flag) => FLAG_LABELS[flag] || flag).join(' · ')}</span>
            <small>像素 {formatPercent(item.alphaPixelRatio)} · 包围盒 {formatPercent(item.alphaBoundsRatio)}</small>
          </a>)}
        </div>
      </section>
    </main>
  )
}
