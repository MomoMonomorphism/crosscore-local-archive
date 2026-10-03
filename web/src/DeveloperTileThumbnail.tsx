import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { DeveloperPickCandidate, DeveloperThumbnail } from './developerControls'
import { createDeveloperThumbnailResultGate } from './developerThumbnailVisibility'

type ThumbnailProps = {
  candidate: DeveloperPickCandidate
  requestKey: string
  requestThumbnail: (candidate: DeveloperPickCandidate, signal?: AbortSignal) => Promise<DeveloperThumbnail | null>
  observe: (element: HTMLElement, callback: (visible: boolean) => void) => () => void
  fallback: ReactNode
}
type ThumbnailState = { key: string; status: 'idle' | 'loading' | 'ready' | 'empty' | 'error'; thumbnail?: DeveloperThumbnail }

export default function DeveloperTileThumbnail({ candidate, requestKey, requestThumbnail, observe, fallback }: ThumbnailProps) {
  const elementRef = useRef<HTMLSpanElement>(null)
  const candidateRef = useRef(candidate); candidateRef.current = candidate
  const emptySlot = candidate.kind === 'slot' && (candidate.type === 'empty' || candidate.attachment === null)
  const [state, setState] = useState<ThumbnailState>({ key: requestKey, status: emptySlot ? 'empty' : 'idle' })
  useEffect(() => {
    const element = elementRef.current
    if (!element) return
    const gate = createDeveloperThumbnailResultGate()
    let request: AbortController | null = null
    setState({ key: requestKey, status: emptySlot ? 'empty' : 'idle' })
    const stop = observe(element, visible => {
      const generation = gate.updateVisible(visible)
      request?.abort(); request = null
      if (!visible) { setState({ key: requestKey, status: emptySlot ? 'empty' : 'idle' }); return }
      if (emptySlot) return
      // IO may have queued a notification immediately before the window was
      // collapsed. Recheck layout before passing work into the shared queue.
      if (!element.getClientRects().length) return
      const controller = new AbortController(); request = controller
      setState({ key: requestKey, status: 'loading' })
      void Promise.resolve().then(() => {
        if (!gate.accepts(generation) || controller.signal.aborted || !element.getClientRects().length) return undefined
        return requestThumbnail(candidateRef.current, controller.signal)
      }).then(thumbnail => {
        if (!gate.accepts(generation) || !element.getClientRects().length || thumbnail === undefined) return
        setState(thumbnail ? { key: requestKey, status: 'ready', thumbnail } : { key: requestKey, status: 'empty' })
      }).catch(() => { if (gate.accepts(generation)) setState({ key: requestKey, status: 'error' }) })
    })
    return () => { gate.invalidate(); request?.abort(); stop() }
  }, [requestKey, requestThumbnail, observe, emptySlot])

  const status = state.key === requestKey ? state.status : emptySlot ? 'empty' : 'idle'
  const image = status === 'ready' ? state.thumbnail : undefined
  const message = status === 'loading' ? '加载缩略图…' : status === 'error' ? '缩略图暂不可用'
    : status === 'empty' ? '无图像' : '滚动到此处加载'
  return <span ref={elementRef} className={`developer-tile-thumbnail${image ? ' developer-tile-thumbnail-ready' : ''}`}>
    {image ? <>
      <img src={image.url} alt={`${candidate.label} · ${image.kind === 'geometry' ? '裁切轮廓' : '资源缩略图'}`}
        width={image.width} height={image.height} draggable={false} onError={() => setState(current => current.key === requestKey
          && current.thumbnail?.url === image.url ? { key: requestKey, status: 'error' } : current)}/>
      <small className="developer-thumbnail-caption">{image.kind === 'geometry' ? '裁切轮廓' : image.kind === 'layer' ? '图层资源' : '资源贴图'}</small>
    </> : <span className="developer-thumbnail-placeholder">{fallback}<small>{message}</small></span>}
  </span>
}
