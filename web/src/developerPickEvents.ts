import type { DeveloperPickCandidate, DeveloperSceneHandle } from './developerControls'

export type DeveloperPickEventOptions = {
  findHandle: (event: Event) => DeveloperSceneHandle | undefined
  canPick: (handle: DeveloperSceneHandle) => boolean
  onPick: (handle: DeveloperSceneHandle, candidates: DeveloperPickCandidate[]) => void
  onError: (error: unknown) => void
  isPanelTarget: (event: Event) => boolean
  blurTarget?: EventTarget
  isHidden?: () => boolean
  now?: () => number
}

/** Install once on the document. Callbacks read current mode/scene refs, so
 * changing selection cannot reinstall the handlers between up and click.
 * A gesture captured at down stays captured through cancellation or completion,
 * even if its scene unloads or point mode is disabled in the meantime. */
export function installDeveloperPickEvents(target: EventTarget, options: DeveloperPickEventOptions): () => void {
  type Gesture = { handle: DeveloperSceneHandle; x: number; y: number; moved: boolean; primary: boolean }
  const gestures = new Map<number, Gesture>()
  let suppressedClick: { surface: HTMLElement | null; x: number; y: number; until: number } | null = null
  const now = options.now ?? Date.now
  const intercept = (event: Event) => { event.preventDefault(); event.stopImmediatePropagation() }
  const matched = (event: Event) => options.isPanelTarget(event) ? undefined : options.findHandle(event)
  const suppressNextClick = (event: PointerEvent, gesture: Gesture) => {
    let surface: HTMLElement | null = null
    try { surface = gesture.handle.surface?.() ?? null } catch { /* Unloading surfaces are allowed. */ }
    suppressedClick = { surface, x: event.clientX, y: event.clientY, until: now() + 900 }
  }
  const abortGestures = () => {
    const gesture = [...gestures.values()].at(-1)
    if (gesture) {
      let surface: HTMLElement | null = null
      try { surface = gesture.handle.surface?.() ?? null } catch { /* Scene already unloaded. */ }
      suppressedClick = { surface, x: gesture.x, y: gesture.y, until: now() + 900 }
    }
    gestures.clear()
  }
  const blurTarget = options.blurTarget ?? target
  const blur: EventListener = event => {
    // Input focus changes are not a loss of browser focus.
    if (event.target === blurTarget) abortGestures()
  }
  const visibility: EventListener = () => { if (options.isHidden?.()) abortGestures() }
  const down: EventListener = raw => {
    const event = raw as PointerEvent
    // A new physical gesture cannot be a delayed click of the previous one.
    suppressedClick = null
    const handle = matched(event)
    if (!handle) return
    intercept(event)
    gestures.set(event.pointerId, { handle, x: event.clientX, y: event.clientY, moved: false,
      primary: event.isPrimary && event.button === 0 })
  }
  const move: EventListener = raw => {
    const event = raw as PointerEvent
    const gesture = gestures.get(event.pointerId)
    if (gesture && Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) > 6) gesture.moved = true
    if (gesture || matched(event)) intercept(event)
  }
  const up: EventListener = raw => {
    const event = raw as PointerEvent
    const gesture = gestures.get(event.pointerId)
    if (!gesture) { if (matched(event)) intercept(event); return }
    intercept(event)
    gestures.delete(event.pointerId)
    suppressNextClick(event, gesture)
    if (!gesture.primary || gesture.moved || Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) > 6) return
    try {
      if (options.canPick(gesture.handle)) options.onPick(gesture.handle, gesture.handle.pick?.(event.clientX, event.clientY) ?? [])
    } catch (error) { options.onError(error) }
  }
  const cancel: EventListener = raw => {
    const event = raw as PointerEvent
    const gesture = gestures.get(event.pointerId)
    if (gesture || matched(event)) intercept(event)
    if (gesture) suppressNextClick(event, gesture)
    gestures.delete(event.pointerId)
  }
  const click: EventListener = raw => {
    const event = raw as MouseEvent
    if (options.isPanelTarget(event)) return
    const suppressed = suppressedClick
    let sameSurface = false
    try { sameSurface = !!suppressed?.surface?.contains(event.target as Node) } catch { /* Detached surface. */ }
    const followsGesture = suppressed && suppressed.until >= now()
      && (sameSurface || Math.hypot(event.clientX - suppressed.x, event.clientY - suppressed.y) <= 8)
    if (followsGesture || matched(event)) { intercept(event); suppressedClick = null }
  }
  const listeners: Array<[string, EventListener]> = [
    ['pointerdown', down], ['pointermove', move], ['pointerup', up], ['pointercancel', cancel], ['click', click],
  ]
  for (const [name, listener] of listeners) target.addEventListener(name, listener, { capture: true, passive: false })
  blurTarget.addEventListener('blur', blur)
  target.addEventListener('visibilitychange', visibility)
  return () => {
    for (const [name, listener] of listeners) target.removeEventListener(name, listener, { capture: true })
    gestures.clear()
    suppressedClick = null
    blurTarget.removeEventListener('blur', blur)
    target.removeEventListener('visibilitychange', visibility)
  }
}
