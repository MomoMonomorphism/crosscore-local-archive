import type { DeveloperPickCandidate } from './developerControls'

export type DeveloperDomPickEntry = { element: HTMLElement; candidate: DeveloperPickCandidate }

function contains(box: DOMRect, x: number, y: number) {
  return box.width > 0 && box.height > 0 && x >= box.left && x <= box.right && y >= box.top && y <= box.bottom
}

/** DOM artwork is selected by its displayed box, including transparent pixels.
 * Hit buttons and layout-only wrappers are deliberately not pick entries. */
export function createDeveloperDomPicker(surface: () => HTMLElement | null,
  entries: () => readonly DeveloperDomPickEntry[]) {
  let highlighted: { element: HTMLElement; outline: string; offset: string } | null = null
  const clear = () => {
    if (!highlighted) return
    highlighted.element.style.outline = highlighted.outline
    highlighted.element.style.outlineOffset = highlighted.offset
    highlighted = null
  }
  return {
    surface,
    pick(clientX: number, clientY: number): DeveloperPickCandidate[] {
      const root = surface()
      if (!root || !contains(root.getBoundingClientRect(), clientX, clientY)) return []
      const getStyle = root.ownerDocument.defaultView?.getComputedStyle.bind(root.ownerDocument.defaultView)
      // UI roots use distinct z-index values; DOM source order alone is not
      // their paint order. Keep descendants grouped under their ancestor stack.
      const paintPath = (element: HTMLElement) => {
        const path: Array<{ z: number; order: number }> = []
        for (let node: HTMLElement | null = element; node && node !== root; node = node.parentElement) {
          const z = Number(getStyle?.(node).zIndex)
          const siblings = node.parentElement?.children
          path.unshift({ z: Number.isFinite(z) ? z : 0,
            order: siblings ? Array.prototype.indexOf.call(siblings, node) : 0 })
        }
        return path
      }
      const sorted = entries().map((entry, order) => ({ ...entry, order, path: paintPath(entry.element) }))
      sorted.sort((a, b) => {
        for (let i = 0; i < Math.min(a.path.length, b.path.length); i++) {
          const delta = a.path[i].z - b.path[i].z || a.path[i].order - b.path[i].order
          if (delta) return -delta
        }
        return b.path.length - a.path.length || b.order - a.order
      })
      return sorted.flatMap(({ element, candidate }) => {
        if (!element.isConnected || !root.contains(element) || !contains(element.getBoundingClientRect(), clientX, clientY)) return []
        let opacity = 1
        for (let node: HTMLElement | null = element; node; node = node.parentElement) {
          if (!node.getClientRects().length) return []
          const style = getStyle?.(node)
          if (style) {
            if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return []
            const alpha = Number(style.opacity)
            if (Number.isFinite(alpha)) opacity *= alpha
            const box = node.getBoundingClientRect()
            if (/(hidden|clip|scroll|auto)/.test(style.overflowX) && (clientX < box.left || clientX > box.right)) return []
            if (/(hidden|clip|scroll|auto)/.test(style.overflowY) && (clientY < box.top || clientY > box.bottom)) return []
          }
        }
        return opacity > .001 ? [{ ...candidate, opacity }] : []
      })
    },
    highlight(candidate: DeveloperPickCandidate | null) {
      clear()
      if (!candidate) return
      const element = entries().find(entry => entry.candidate.id === candidate.id)?.element
      if (!element?.isConnected) return
      highlighted = { element, outline: element.style.outline, offset: element.style.outlineOffset }
      element.style.outline = '2px solid #56d8f0'
      element.style.outlineOffset = '-2px'
    },
    dispose: clear,
  }
}
