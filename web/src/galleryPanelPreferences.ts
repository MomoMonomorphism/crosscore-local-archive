/** Desktop chrome only. Kept separate from saved character/game state. */
export const GALLERY_LAYOUT_KEY = 'crosscore-local-viewer.layout.v1'
export type GalleryPanelPreferences = { libraryOpen: boolean; toolsOpen: boolean }
type Reader = Pick<Storage, 'getItem'>
type Writer = Pick<Storage, 'setItem'>

export function readGalleryPanelPreferences(storage?: Reader): GalleryPanelPreferences {
  const defaults = { libraryOpen: true, toolsOpen: true }
  try {
    const source = storage ?? (typeof window !== 'undefined' ? window.localStorage : undefined)
    const saved: unknown = JSON.parse(source?.getItem(GALLERY_LAYOUT_KEY) ?? 'null')
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return defaults
    const value = saved as Record<string, unknown>
    if (value.version !== 1) return defaults
    return {
      libraryOpen: typeof value.libraryOpen === 'boolean' ? value.libraryOpen : true,
      toolsOpen: typeof value.toolsOpen === 'boolean' ? value.toolsOpen : true,
    }
  } catch { return defaults }
}

export function writeGalleryPanelPreferences(value: GalleryPanelPreferences, storage?: Writer): void {
  try {
    const target = storage ?? (typeof window !== 'undefined' ? window.localStorage : undefined)
    target?.setItem(GALLERY_LAYOUT_KEY, JSON.stringify({ version: 1, ...value }))
  } catch { /* Blocked storage must never prevent browsing or closing a panel. */ }
}
