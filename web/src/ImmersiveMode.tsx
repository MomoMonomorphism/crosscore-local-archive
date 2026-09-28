import { createContext, useContext, useEffect, useRef, useState, type ReactNode, type RefObject, type PointerEvent as ReactPointerEvent } from 'react'
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
export function ImmersiveTools({ mode, playing, onPlay, debug, onDebug, canAdjust = true, subtitles, onSubtitles, subtitlesPassthrough, onSubtitlesPassthrough, onResetSubtitles,
  primaryControls, moreControls, panels = [], onPanelChange }: {
  mode: ImmersiveMode; playing?: boolean; onPlay?: () => void; debug?: boolean; onDebug?: () => void; canAdjust?: boolean
  subtitles?: boolean; onSubtitles?: () => void
  subtitlesPassthrough?: boolean; onSubtitlesPassthrough?: () => void; onResetSubtitles?: () => void
  primaryControls?: ReactNode; moreControls?: ReactNode
  panels?: { id: string; title: string; content: ReactNode }[]; onPanelChange?: () => void
}) {
  const toggle = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLElement>(null)
  const [panel, setPanel] = useState<string | null>(null)
  const closePanel = () => { setPanel(null); onPanelChange?.() }
  useEffect(() => {
    if (mode.active) toggle.current?.focus({ preventScroll: true })
    setPanel(null)
    onPanelChange?.()
  }, [mode.active])
  useEffect(() => {
    if (panel && mode.controls) panelRef.current?.focus({ preventScroll: true })
  }, [panel, mode.controls])
  if (!mode.active) return null
  const panelContent = panel === 'more' ? <>
    {moreControls}
    <div className="immersive-more-buttons">
      {onSubtitlesPassthrough && <button aria-pressed={subtitlesPassthrough} onClick={onSubtitlesPassthrough}>字幕穿透 {subtitlesPassthrough ? '开' : '关'}</button>}
      {onResetSubtitles && <button onClick={onResetSubtitles}>字幕复位</button>}
    </div>
  </> : panels.find(item => item.id === panel)?.content
  return <div className="immersive-tools" onKeyDown={e => { if (e.key !== 'Escape') e.stopPropagation() }} onPointerDown={e => e.stopPropagation()} onPointerUp={e => e.stopPropagation()}
    onPointerMove={e => e.stopPropagation()} onClick={e => e.stopPropagation()} onWheel={e => e.stopPropagation()}>
    <button ref={toggle} className="immersive-wake" aria-expanded={mode.controls} aria-controls="immersive-controls"
      onClick={() => { closePanel(); mode.setControls(!mode.controls) }}>{mode.controls ? '收起控制' : '☰ 控制'}{mode.adjustable ? ' · 调整中' : ''}</button>
    {mode.controls && <>
      <div id="immersive-controls" className="immersive-controls" role="group" aria-label="沉浸模式控制">
        <span>{mode.adjustable ? '拖动画面 · 滚轮缩放' : '画面已锁定 · 开启“调整画面”可移动缩放'}</span>
        {onPlay && <button onClick={onPlay}>{playing ? 'Ⅱ 暂停' : '▶ 播放'}</button>}
        {primaryControls}
        {onDebug && <button aria-pressed={debug} onClick={onDebug}>热区提示 {debug ? '开' : '关'}</button>}
        {onSubtitles && <button aria-pressed={subtitles} onClick={onSubtitles}>台词 {subtitles ? '开' : '关'}</button>}
        <button disabled={!canAdjust} aria-pressed={mode.adjustable} onClick={() => mode.setAdjustable(!mode.adjustable)}>调整画面</button>
        {mode.adjustable && <button disabled={!canAdjust} onClick={mode.reset}>复位画面</button>}
        <button onClick={mode.exit}>退出沉浸 · Esc</button>
        <nav className="immersive-panel-buttons" aria-label="沉浸功能面板">
          {[...panels, { id: 'more', title: '更多' }].map(item => <button key={item.id} aria-expanded={panel === item.id} aria-controls="immersive-panel"
            onClick={() => { setPanel(panel === item.id ? null : item.id); onPanelChange?.() }}>{item.title}</button>)}
        </nav>
      </div>
      {panel && <section ref={panelRef} tabIndex={-1} id="immersive-panel" className="immersive-panel" aria-label={panel === 'more' ? '更多设置' : panels.find(item => item.id === panel)?.title}>
        <header><strong>{panel === 'more' ? '更多设置' : panels.find(item => item.id === panel)?.title}</strong><button aria-label="关闭沉浸面板" onClick={() => { closePanel(); toggle.current?.focus({ preventScroll: true }) }}>关闭 ×</button></header>
        <div className="immersive-panel-body" key={panel}>{panelContent}</div>
      </section>}
    </>}
  </div>
}
