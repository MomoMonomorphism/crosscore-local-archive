import { useLayoutEffect } from 'react'

type TrackedImage = {
  source: string
  cleanup: () => void
}

/**
 * Progressive enhancement for existing directory images across gallery routes.
 * Own only data attributes on the existing image/thumbnail, never React's
 * children, layout, click selection, or lazy-loading policy. This avoids
 * rewriting the large gallery views just to add the same image lifecycle UI.
 */
export function installThumbnailLoadingFeedback(root: HTMLElement) {
  const tracked = new Map<HTMLImageElement, TrackedImage>()
  let disposed = false

  const watch = (image: HTMLImageElement) => {
    const thumbnail = image.closest<HTMLElement>('.entry-monogram')
    if (!thumbnail || !root.contains(thumbnail)) return
    const source = image.getAttribute('src') ?? ''
    if (tracked.get(image)?.source === source) return
    tracked.get(image)?.cleanup()
    const originalAlt = image.alt
    const originalTitle = thumbnail.getAttribute('title')
    const originalBusy = thumbnail.getAttribute('aria-busy')
    let current = true
    const update = (state: 'loading' | 'ready' | 'error') => {
      if (!current || disposed || image.getAttribute('src') !== source) return
      thumbnail.dataset.thumbnailState = state
      image.dataset.thumbnailState = state
      thumbnail.setAttribute('aria-busy', String(state === 'loading'))
      if (state === 'error') {
        thumbnail.title = '缩略图加载失败；选择此条目可重试，不影响查看其他角色。'
        image.alt = '缩略图加载失败，选择此条目重试'
      } else {
        if (originalTitle === null) thumbnail.removeAttribute('title')
        else thumbnail.setAttribute('title', originalTitle)
        image.alt = originalAlt
      }
    }
    const loaded = () => update(image.naturalWidth > 0 ? 'ready' : 'error')
    const failed = () => update('error')
    image.addEventListener('load', loaded)
    image.addEventListener('error', failed)
    tracked.set(image, { source, cleanup: () => {
      current = false
      image.removeEventListener('load', loaded)
      image.removeEventListener('error', failed)
      delete thumbnail.dataset.thumbnailState
      delete image.dataset.thumbnailState
      image.alt = originalAlt
      if (originalTitle === null) thumbnail.removeAttribute('title')
      else thumbnail.setAttribute('title', originalTitle)
      if (originalBusy === null) thumbnail.removeAttribute('aria-busy')
      else thumbnail.setAttribute('aria-busy', originalBusy)
    } })
    update('loading')
    // Cached images can have completed before listeners were attached.
    if (!source) update('error')
    else if (image.complete) loaded()
  }
  const scan = (node: Node) => {
    if (!(node instanceof Element)) return
    if (node instanceof HTMLImageElement) watch(node)
    node.querySelectorAll<HTMLImageElement>('.entry-monogram img').forEach(watch)
    if (node.matches('.entry-monogram')) node.querySelectorAll('img').forEach(watch)
  }
  scan(root)
  const observer = new MutationObserver(records => {
    for (const [image, entry] of tracked) {
      if (!root.contains(image)) { entry.cleanup(); tracked.delete(image) }
    }
    for (const record of records) {
      if (record.type === 'attributes' && record.target instanceof HTMLImageElement) watch(record.target)
      else record.addedNodes.forEach(scan)
    }
  })
  observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] })
  const retry = (event: MouseEvent) => {
    const target = event.target instanceof Element ? event.target : null
    const card = target?.closest('.entry-card')
    const image = card?.querySelector<HTMLImageElement>('img[data-thumbnail-state="error"]')
    if (!image || !root.contains(image)) return
    const source = tracked.get(image)?.source
    if (!source) return
    // Same-origin public assets only; preserve base path and thumbnail query.
    const url = new URL(source, document.baseURI)
    if (url.origin !== location.origin || !/^https?:$/.test(url.protocol)) return
    url.searchParams.set('thumbnailRetry', String(Date.now()))
    image.src = url.href
    watch(image)
    // Do not cancel selection. Enter/Space on the existing card also retries,
    // without adding a nested button or a new keyboard stop for every image.
  }
  root.addEventListener('click', retry, true)
  return () => {
    disposed = true
    observer.disconnect()
    root.removeEventListener('click', retry, true)
    tracked.forEach(entry => entry.cleanup())
    tracked.clear()
  }
}

export function ThumbnailLoadingFeedback() {
  useLayoutEffect(() => {
    const root = document.getElementById('root')
    return root ? installThumbnailLoadingFeedback(root) : undefined
  }, [])
  return null
}
