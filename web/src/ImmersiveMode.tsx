import { createContext, useContext, useEffect, useId, useRef, useState, type ReactNode, type RefObject, type PointerEvent as ReactPointerEvent } from 'react'
import './immersiveMode.css'
import { ViewportPinch } from './viewportPinch'

export const ImmersiveContext = createContext({ active: false, adjustable: false, resetSerial: 0, controls: false })

export function ImmersiveEntry({ onEnter, disabled = false }: { onEnter: () => void; disabled?: boolean }) {
  return <button className="gallery-action-entry immersive-entry" onClick={onEnter} disabled={disabled}>
    <span className="immersive-entry-icon" aria-hidden="true">
      <svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="square">
        <path d="M7 3H3v4M13 3h4v4M17 13v4h-4M7 17H3v-4" />
      </svg>
    </span>
    <span>进入沉浸</span>
  </button>
}

export function useViewAdjustment() {
  const mode = useContext(ImmersiveContext)
  const allowed = !mode.active || mode.adjustable
  const allowedRef = useRef(allowed)
  allowedRef.current = allowed
  return { ...mode, allowed, allowedRef }
}

export function useViewReset(reset: () => void) {
  const { resetSerial } = useContext(ImmersiveContext)
  const last = useRef(resetSerial)
  useEffect(() => {
    if (last.current === resetSerial) return
    last.current = resetSerial
    reset()
  }, [resetSerial])
}

/** A game drag owns its pointer; only otherwise may two fingers adjust the view. */
export function usePinchZoom(zoomBy: (ratio: number) => void, canStart: () => boolean = () => true) {
  const { allowedRef, active } = useViewAdjustment()
  const gesture = useRef(new ViewportPinch())
  useEffect(() => { gesture.current.reset() }, [active])
  return {
    down: (e: ReactPointerEvent<HTMLDivElement>) => {
      const consumed = gesture.current.down(e.pointerId, e.pointerType, e.clientX, e.clientY, allowedRef.current, !canStart())
      if (consumed) e.currentTarget.setPointerCapture(e.pointerId)
      return consumed
    },
    move: (e: ReactPointerEvent<HTMLDivElement>) => {
      const result = gesture.current.move(e.pointerId, e.clientX, e.clientY, allowedRef.current)
      if (result.ratio != null) zoomBy(result.ratio)
      return result.consumed
    },
    up: (e: ReactPointerEvent<HTMLDivElement>) => {
      return gesture.current.up(e.pointerId)
    },
  }
}

export function useImmersiveMode(root: RefObject<HTMLDivElement>, enabled: boolean) {
  const [active, setActive] = useState(false)
  const [adjustable, setAdjustable] = useState(false)
  const [controls, setControls] = useState(false)
  const [resetSerial, setResetSerial] = useState(0)
  const generation = useRef(0)
  const activeRef = useRef(false)
  const layoutUntilRef = useRef(0)
  const scrollBefore = useRef<Array<{ node: HTMLElement; top: number; left: number }>>([])
  const focusBefore = useRef<HTMLElement | null>(null)
  const exit = () => {
    generation.current++
    activeRef.current = false
    layoutUntilRef.current = Date.now() + 1000
    setActive(false); setAdjustable(false); setControls(false)
    if (document.fullscreenElement === root.current) void document.exitFullscreen().catch(() => undefined)
    requestAnimationFrame(() => {
      if (activeRef.current) return
      focusBefore.current?.focus({ preventScroll: true })
      for (const item of scrollBefore.current) if (item.node.isConnected) item.node.scrollTo(item.left, item.top)
    })
  }
  const enter = () => {
    focusBefore.current = document.activeElement as HTMLElement | null
    scrollBefore.current = [...(root.current?.querySelectorAll<HTMLElement>('.viewer-panel,.entry-list,.gallery-tools,.gallery-voice-list') ?? [])]
      .map(node => ({ node, top: node.scrollTop, left: node.scrollLeft }))
    const ticket = ++generation.current
    activeRef.current = true
    setAdjustable(false); setControls(false); setActive(true)
    const element = root.current
    // Keep viewport immersion usable in embedded browsers without Fullscreen API.
    if (element?.requestFullscreen && !document.fullscreenElement) void element.requestFullscreen()
      .then(() => { if (generation.current !== ticket && document.fullscreenElement === element) void document.exitFullscreen().catch(() => undefined) })
      .catch(() => undefined)
  }
  useEffect(() => {
    if (!enabled && activeRef.current) exit()
  }, [enabled])
  useEffect(() => {
    if (!active) return
    const oldOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); exit() }
    }
    const fullscreen = () => { if (!document.fullscreenElement) exit() }
    document.addEventListener('keydown', key)
    document.addEventListener('fullscreenchange', fullscreen)
    return () => {
      document.body.style.overflow = oldOverflow
      document.removeEventListener('keydown', key)
      document.removeEventListener('fullscreenchange', fullscreen)
    }
  }, [active])
  useEffect(() => () => { generation.current++; activeRef.current = false }, [])
  return { active, adjustable, resetSerial, controls, enter, exit, setAdjustable, setControls,
    reset: () => setResetSerial(n => n + 1), activeRef, layoutUntilRef }
}

export type ImmersiveMode = ReturnType<typeof useImmersiveMode>
export function ImmersiveTools({ mode, title, playing, onPlay, debug, onDebug, canAdjust = true, onZoom, subtitles, onSubtitles, subtitlesPassthrough, onSubtitlesPassthrough, onResetSubtitles,
  primaryControls, playbackControls, moreControls, panels = [], onPanelChange }: {
  mode: ImmersiveMode; playing?: boolean; onPlay?: () => void; debug?: boolean; onDebug?: () => void; canAdjust?: boolean
  title?: string; onZoom?: (action: 'in' | 'out') => void
  subtitles?: boolean; onSubtitles?: () => void
  subtitlesPassthrough?: boolean; onSubtitlesPassthrough?: () => void; onResetSubtitles?: () => void
  primaryControls?: ReactNode; playbackControls?: ReactNode; moreControls?: ReactNode
  panels?: { id: string; title: string; content: ReactNode }[]; onPanelChange?: () => void
}) {
  const toggle = useRef<HTMLButtonElement>(null)
  const tabsRef = useRef<HTMLElement>(null)
  const id = useId()
  const [panel, setPanel] = useState<string | null>(null)
  const hasSettings = Boolean(moreControls || onSubtitlesPassthrough || onResetSubtitles)
  const tabs = [{ id: 'main', title: '常用' }, ...panels, ...(hasSettings ? [{ id: 'more', title: '设置' }] : [])]
  const selected = tabs.some(item => item.id === panel) ? panel : 'main'
  const selectPanel = (next: string) => { setPanel(next); onPanelChange?.() }
  const hide = () => { mode.setControls(false); toggle.current?.focus({ preventScroll: true }); onPanelChange?.() }
  useEffect(() => {
    if (mode.active) toggle.current?.focus({ preventScroll: true })
    setPanel(null)
    onPanelChange?.()
  }, [mode.active])
  useEffect(() => {
    if (!canAdjust && mode.adjustable) mode.setAdjustable(false)
  }, [canAdjust, mode.adjustable])
  if (!mode.active) return null
  const panelContent = selected === 'main' ? <>
    {(onPlay || primaryControls || playbackControls) && <section className="immersive-control-section" aria-label="播放控制">
      <h3>播放</h3><div className="immersive-button-row">
        {onPlay && <button className="immersive-play" onClick={onPlay} aria-label={playing ? '暂停播放' : '开始播放'}>{playing ? 'Ⅱ 暂停' : '▶ 播放'}</button>}
        {primaryControls}
      </div>{playbackControls}
    </section>}
    {(onDebug || onSubtitles) && <section className="immersive-control-section" aria-label="显示控制">
      <h3>显示</h3><div className="immersive-button-row">
        {onDebug && <button aria-pressed={debug} onClick={onDebug}>热区提示 <small>{debug ? '开' : '关'}</small></button>}
        {onSubtitles && <button aria-pressed={subtitles} onClick={onSubtitles}>台词 <small>{subtitles ? '开' : '关'}</small></button>}
      </div>
    </section>}
    <section className="immersive-control-section" aria-label="画面调整">
      <h3>画面</h3><div className="immersive-button-row">
        <button disabled={!canAdjust} aria-pressed={mode.adjustable} onClick={() => mode.setAdjustable(!mode.adjustable)}>{mode.adjustable ? '锁定画面' : '调整画面'}</button>
        {onZoom && <button aria-label="缩小画面" disabled={!canAdjust || !mode.adjustable} onClick={() => onZoom('out')}>− 缩小</button>}
        {onZoom && <button aria-label="放大画面" disabled={!canAdjust || !mode.adjustable} onClick={() => onZoom('in')}>＋ 放大</button>}
        <button disabled={!canAdjust} onClick={mode.reset}>复位画面</button>
      </div><p className="immersive-hint">{!canAdjust ? '当前画面不支持移动与缩放' : mode.adjustable ? '拖动移动 · 滚轮或双指缩放' : '画面已锁定 · 开启调整后可移动与缩放'}</p>
    </section>
  </> : selected === 'more' ? <div className="immersive-settings">
    {moreControls}
    {(onSubtitlesPassthrough || onResetSubtitles) && <section className="immersive-control-section" aria-label="台词设置"><h3>台词</h3><div className="immersive-button-row">
      {onSubtitlesPassthrough && <button aria-pressed={subtitlesPassthrough} onClick={onSubtitlesPassthrough}>字幕穿透 <small>{subtitlesPassthrough ? '开' : '关'}</small></button>}
      {onResetSubtitles && <button onClick={onResetSubtitles}>复位台词位置</button>}
    </div>{onSubtitlesPassthrough && <p className="immersive-hint">开启穿透后，点击与拖动会交给画面。</p>}</section>}
  </div> : panels.find(item => item.id === selected)?.content
  return <div className="immersive-tools" onKeyDown={e => { if (e.key !== 'Escape') e.stopPropagation() }} onPointerDown={e => e.stopPropagation()} onPointerUp={e => e.stopPropagation()}
    onPointerMove={e => e.stopPropagation()} onClick={e => e.stopPropagation()} onWheel={e => e.stopPropagation()}>
    <button ref={toggle} className="immersive-wake" aria-label={mode.controls ? '收起沉浸菜单' : '打开沉浸菜单'} aria-expanded={mode.controls} aria-controls={`${id}-controls`}
      onClick={() => mode.controls ? hide() : mode.setControls(true)}><span aria-hidden="true">{mode.controls ? '×' : '☰'}</span> 控制{mode.adjustable && <small>调整中</small>}</button>
    {mode.controls && <section id={`${id}-controls`} className="immersive-controls" aria-label="沉浸模式控制">
      <header className="immersive-heading"><div><span>沉浸控制</span>{title && <strong title={title}>{title}</strong>}</div><button aria-label="收起沉浸菜单" onClick={hide}>收起</button></header>
      <nav ref={tabsRef} className="immersive-panel-buttons" role="tablist" aria-label="沉浸功能" onKeyDown={e => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return
        const buttons = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('button')]
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
        if (index < 0) return
        e.preventDefault()
        const next = e.key === 'Home' ? 0 : e.key === 'End' ? buttons.length - 1 : (index + (e.key === 'ArrowLeft' ? -1 : 1) + buttons.length) % buttons.length
        selectPanel(tabs[next].id); buttons[next].focus()
      }}>
        {tabs.map(item => <button key={item.id} id={`${id}-tab-${item.id}`} role="tab" aria-selected={selected === item.id} tabIndex={selected === item.id ? 0 : -1}
          aria-controls={`${id}-panel`} onClick={() => selectPanel(item.id)}>{item.title}</button>)}
      </nav>
      <div id={`${id}-panel`} className={`immersive-panel-body immersive-page-${selected}`} key={selected} role="tabpanel" tabIndex={0} aria-labelledby={`${id}-tab-${selected}`}>{panelContent}</div>
      <footer className="immersive-footer"><span>{mode.adjustable ? '画面调整中' : '沉浸浏览'}</span><button onClick={mode.exit}>退出沉浸 <span aria-hidden="true">↗</span></button></footer>
    </section>}
  </div>
}
