type VisibilityCallback = (visible: boolean) => void
type IntersectionObserverLike = Pick<IntersectionObserver, 'observe' | 'unobserve' | 'disconnect'>
type ObserverFactory = (callback: IntersectionObserverCallback, options: IntersectionObserverInit) => IntersectionObserverLike

/** One observer per browser grid, so hundreds of unvisited tiles do not each
 * allocate an observer or request images. Hidden ancestors have no layout. */
export function createDeveloperThumbnailVisibility(root: HTMLElement, factory: ObserverFactory | null =
  typeof IntersectionObserver === 'undefined' ? null : (callback, options) => new IntersectionObserver(callback, options)) {
  const callbacks = new Map<Element, VisibilityCallback>()
  const visibleStates = new Map<Element, boolean>()
  let disposed = false
  const observer = factory?.(entries => {
    if (disposed) return
    for (const entry of entries) {
      const visible = entry.isIntersecting && root.getClientRects().length > 0 && entry.target.getClientRects().length > 0
      if (!callbacks.has(entry.target) || visibleStates.get(entry.target) === visible) continue
      visibleStates.set(entry.target, visible)
      callbacks.get(entry.target)?.(visible)
    }
  }, { root, rootMargin: '80px', threshold: 0 })
  return {
    root,
    observe(element: HTMLElement, callback: VisibilityCallback) {
      if (disposed) return () => {}
      callbacks.set(element, callback)
      visibleStates.delete(element)
      if (observer) observer.observe(element)
      // Unsupported browsers retain an explicit placeholder rather than eagerly
      // generating thumbnails for every tile in the scene.
      else callback(false)
      return () => { if (callbacks.get(element) === callback) { callbacks.delete(element); visibleStates.delete(element); observer?.unobserve(element) } }
    },
    dispose() { disposed = true; callbacks.clear(); visibleStates.clear(); observer?.disconnect() },
  }
}

export type DeveloperThumbnailVisibility = ReturnType<typeof createDeveloperThumbnailVisibility>

/** Async image results must still belong to the same visible tile generation. */
export function createDeveloperThumbnailResultGate() {
  let generation = 0
  let visible = false
  return {
    updateVisible(value: boolean) { visible = value; generation++; return generation },
    current() { return generation },
    accepts(value: number) { return visible && value === generation },
    invalidate() { visible = false; generation++ },
  }
}
