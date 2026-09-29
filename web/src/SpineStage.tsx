import { Component, useCallback, useLayoutEffect, useRef, useState } from 'react'
import type { ComponentProps, ErrorInfo, ReactNode } from 'react'
import SpineStageRenderer from './SpineStageRenderer'
import { ResourceLoadingNotice } from './ResourceLoadingNotice'

// Keep the public import path and all existing types/callbacks compatible.
// The renderer is moved verbatim; loading UI must not change its timing,
// transforms, asset cache, animation state, or interaction command ordering.
export type { SpineMetadata, SpineAuditMeasurement } from './SpineStageRenderer'
type Props = ComponentProps<typeof SpineStageRenderer>

class RendererBoundary extends Component<{ children: ReactNode; onError: (message: string) => void }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  componentDidCatch(error: Error, _info: ErrorInfo) {
    this.props.onError(`画面初始化失败：${error.message}`)
  }
  render() { return this.state.failed ? null : this.props.children }
}

export default function SpineStage(props: Props) {
  const [pending, setPending] = useState(true)
  const frames = useRef<number[]>([])
  const active = useRef(false)
  const failed = useRef(false)
  const cancelFrames = useCallback(() => {
    frames.current.forEach(cancelAnimationFrame)
    frames.current = []
  }, [])

  // Match the renderer's load-effect dependencies. A retry or new resource
  // starts a new loading state; playing/pausing and ordinary rerenders do not.
  useLayoutEffect(() => {
    active.current = true
    failed.current = false
    cancelFrames()
    setPending(true)
    return () => { active.current = false; cancelFrames() }
  }, [props.asset, props.effects, props.onAudit, props.onError, props.onMetadata,
    props.onStatus, props.interaction?.space?.scale, props.loopAnimation, props.probeKey, cancelFrames])

  const onMetadata = useCallback<Props['onMetadata']>(metadata => {
    props.onMetadata(metadata)
    // Metadata follows all required downloads and scene construction. Leave
    // the original runtime-ready commands in the same turn and allow a paint
    // before dismissing the overlay (also when playback is paused).
    cancelFrames()
    frames.current.push(requestAnimationFrame(() => {
      if (!active.current || failed.current) return
      frames.current.push(requestAnimationFrame(() => {
        if (active.current && !failed.current) setPending(false)
      }))
    }))
  }, [props.onMetadata, cancelFrames])
  const onError = useCallback<Props['onError']>(message => {
    failed.current = true
    cancelFrames()
    if (active.current) setPending(false)
    // The owning view already supplies its error panel and retry control.
    props.onError(message)
  }, [props.onError, cancelFrames])

  const resourceKey = [props.asset.id, props.asset.jsonPath, props.asset.atlasPath,
    ...props.effects.map(effect => effect.asset.id)].join('|')
  return <>
    <RendererBoundary key={resourceKey} onError={onError}>
      <SpineStageRenderer {...props} onMetadata={onMetadata} onError={onError}/>
    </RendererBoundary>
    {pending && !props.onAudit && <ResourceLoadingNotice title="正在加载画面资源"/>}
  </>
}
