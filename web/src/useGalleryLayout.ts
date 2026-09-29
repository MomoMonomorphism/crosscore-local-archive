import { useEffect, useRef, useState } from 'react'
import { useImmersiveMode } from './ImmersiveMode'
import { readGalleryPanelPreferences, writeGalleryPanelPreferences } from './galleryPanelPreferences'

const compactQuery = '(max-width: 1100px)'
const landscapeQuery = '(max-width: 1100px) and (orientation: landscape)'

export function useGalleryLayout(enabled: boolean) {
  const root = useRef<HTMLDivElement>(null)
  const immersive = useImmersiveMode(root, enabled)
  const [compact, setCompact] = useState(() => matchMedia(compactQuery).matches)
  const [landscape, setLandscape] = useState(() => matchMedia(landscapeQuery).matches)
  const [libraryOpen, setLibraryOpen] = useState(() => !matchMedia(compactQuery).matches && readGalleryPanelPreferences().libraryOpen)
  const [toolsOpen, setToolsOpen] = useState(() => matchMedia(compactQuery).matches
    ? !matchMedia(landscapeQuery).matches : readGalleryPanelPreferences().toolsOpen)
  const [tab, setTab] = useState<'interaction' | 'actions' | 'voices'>('interaction')
  const previousPanels = useRef({ libraryOpen, toolsOpen })
  const drawer = enabled && !immersive.active && compact && (libraryOpen ? 'library' : landscape && toolsOpen ? 'tools' : null)

  useEffect(() => {
    const width = matchMedia(compactQuery), orientation = matchMedia(landscapeQuery)
    const change = () => {
      setCompact(width.matches); setLandscape(orientation.matches)
      if (!immersive.activeRef.current && Date.now() > immersive.layoutUntilRef.current) {
        const saved = readGalleryPanelPreferences()
        setLibraryOpen(width.matches ? false : saved.libraryOpen)
        setToolsOpen(width.matches ? !orientation.matches : saved.toolsOpen)
      }
    }
    width.addEventListener('change', change); orientation.addEventListener('change', change)
    return () => { width.removeEventListener('change', change); orientation.removeEventListener('change', change) }
  }, [])

  useEffect(() => {
    if (!enabled) return
    document.body.classList.add('gallery-layout-active')
    return () => document.body.classList.remove('gallery-layout-active')
  }, [enabled])

  // Mobile drawers and fullscreen/orientation transitions do not overwrite
  // desktop preferences. The existing Restore Layout button resets both values.
  useEffect(() => {
    if (enabled && !compact && !immersive.active) {
      writeGalleryPanelPreferences({ libraryOpen, toolsOpen })
    }
  }, [enabled, compact, immersive.active, libraryOpen, toolsOpen])

  // A hidden close/rail button must not strand keyboard focus. Do not steal
  // focus on initial load, from the stage, or from the global reset control.
  useEffect(() => {
    const previous = previousPanels.current
    previousPanels.current = { libraryOpen, toolsOpen }
    if (!enabled || compact || immersive.active || !root.current) return
    for (const [selector, open, wasOpen, destination] of [
      ['.library-panel', libraryOpen, previous.libraryOpen, '.search-box input'],
      ['.gallery-tools', toolsOpen, previous.toolsOpen, '[role="tab"][aria-selected="true"]'],
    ] as const) {
      if (open === wasOpen) continue
      const panel = root.current.querySelector<HTMLElement>(selector)
      const focused = document.activeElement
      if (panel && (panel.contains(focused) || focused === document.body)) {
        panel.querySelector<HTMLElement>(open ? destination : '.gallery-rail')?.focus({ preventScroll: true })
      }
    }
  }, [enabled, compact, immersive.active, libraryOpen, toolsOpen])

  useEffect(() => {
    if (!drawer || !root.current) return
    const panel = root.current.querySelector<HTMLElement>(drawer === 'library' ? '.library-panel' : '.gallery-tools')
    if (!panel) return
    const previous = document.activeElement as HTMLElement | null
    const previousOverflow = document.body.style.overflow
    const outside = [...root.current.children].filter(e => e !== panel && !e.classList.contains('gallery-scrim')) as HTMLElement[]
    document.body.style.overflow = 'hidden'; outside.forEach(e => e.inert = true)
    panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-modal', 'true')
    const items = () => [...panel.querySelectorAll<HTMLElement>('button:not(:disabled),input,select,a[href],summary')].filter(e => e.getClientRects().length)
    items()[0]?.focus()
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') drawer === 'library' ? setLibraryOpen(false) : setToolsOpen(false)
      if (e.key === 'Tab') {
        const all = items(), first = all[0], last = all.at(-1)
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus() }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus() }
      }
    }
    document.addEventListener('keydown', key)
    return () => {
      document.body.style.overflow = previousOverflow; outside.forEach(e => e.inert = false)
      panel.removeAttribute('role'); panel.removeAttribute('aria-modal'); document.removeEventListener('keydown', key)
      if (previous?.isConnected) previous.focus()
    }
  }, [drawer])

  const showTools = (next: 'interaction' | 'actions' | 'voices') => {
    setTab(next); setToolsOpen(true)
    if (compact) setLibraryOpen(false)
    if (compact && !landscape) requestAnimationFrame(() => root.current?.querySelector('.gallery-tools')?.scrollIntoView({ block: 'start', behavior: 'smooth' }))
  }
  return { root, compact, landscape, libraryOpen, setLibraryOpen, toolsOpen, setToolsOpen, tab, setTab, drawer, showTools, immersive }
}
