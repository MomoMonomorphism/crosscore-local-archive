import type { UiMaterial } from './SpineUiMaterial'
export type XY = { x: number; y: number }
type Group = {
  class: string; m_Spacing?: number | XY; m_CellSize?: XY;
  m_Padding?: { m_Left: number; m_Right: number; m_Top: number; m_Bottom: number };
  m_ChildAlignment?: number; m_Constraint?: number; m_ConstraintCount?: number;
  m_StartCorner?: number; m_StartAxis?: number; m_ReverseArrangement?: boolean;
  m_ChildForceExpandWidth?: number; m_ChildForceExpandHeight?: number;
  m_ChildControlWidth?: number; m_ChildControlHeight?: number;
  m_ChildScaleWidth?: number; m_ChildScaleHeight?: number;
}
export type UiNode = {
  id: string; parent?: string; name: string; active: boolean; x: number; y: number; sx: number; sy: number;
  rx?: number; ry?: number; rz?: number; alpha?: number;
  localX?: number; localY?: number; localZ?: number;
  rect?: { m_AnchorMin?: XY; m_AnchorMax?: XY; m_SizeDelta?: XY; m_Pivot?: XY;
    m_LocalRotation?: { x: number; y: number; z: number; w: number } };
  image?: string; imageMeta?: { width: number; height: number; border: number[]; ppu: number };
  imageType?: number; preserveAspect?: boolean; ppuMultiplier?: number; fillCenter?: boolean;
  material?: UiMaterial;
  text?: string; fontSize?: number; color?: { r: number; g: number; b: number; a: number };
  fill?: number; filled?: boolean; fillMethod?: number; fillOrigin?: number; fillClockwise?: boolean;
  mask?: { showGraphic: boolean }; rectMask?: boolean; fitter?: { x: number; y: number };
  click?: string; layout?: Group; anim?: string; animElapsed?: number;
}
type Size = { width: number; height: number }
type Box = Size & { left: number; top: number }
type Children = Map<string, UiNode[]>
const padding = (g?: Group) => g?.m_Padding ?? { m_Left: 0, m_Right: 0, m_Top: 0, m_Bottom: 0 }

function preferred(n: UiNode, axis: 'width' | 'height', children: Children): number {
  if (n.layout) return measure(n, children)[axis]
  if (n.imageMeta) return n.imageMeta[axis] / (n.imageMeta.ppu / 100)
  return n.rect?.m_SizeDelta?.[axis === 'width' ? 'x' : 'y'] ?? 0
}

export function measure(n: UiNode, children: Children): Size {
  const size = { width: n.rect?.m_SizeDelta?.x ?? 0, height: n.rect?.m_SizeDelta?.y ?? 0 }
  const g = n.layout, kids = (children.get(n.id) ?? []).filter(c => c.active), p = padding(g)
  if (g?.class === 'HorizontalLayoutGroup') {
    const spacing = typeof g.m_Spacing === 'number' ? g.m_Spacing : 0
    const width = kids.reduce((sum, c) => sum + (g.m_ChildControlWidth ? preferred(c, 'width', children) : measure(c, children).width)
      * (g.m_ChildScaleWidth ? c.sx : 1), 0) + Math.max(0, kids.length - 1) * spacing + p.m_Left + p.m_Right
    const height = Math.max(0, ...kids.map(c => (g.m_ChildControlHeight ? preferred(c, 'height', children) : measure(c, children).height)
      * (g.m_ChildScaleHeight ? c.sy : 1))) + p.m_Top + p.m_Bottom
    if (n.fitter?.x) size.width = Math.max(p.m_Left + p.m_Right, width)
    if (n.fitter?.y) size.height = height
  }
  return size
}

export function rectBox(n: UiNode, pw: number, ph: number, measured: Size, parentPivot: XY = { x: .5, y: .5 }): Box {
  const r = n.rect ?? {}, min = r.m_AnchorMin ?? { x: 0, y: 0 }, max = r.m_AnchorMax ?? { x: 1, y: 1 }
  const pivot = r.m_Pivot ?? { x: .5, y: .5 }
  const width = n.fitter?.x ? measured.width : measured.width + pw * (max.x - min.x)
  const height = n.fitter?.y ? measured.height : measured.height + ph * (max.y - min.y)
  return { width: Math.max(0, width), height: Math.max(0, height),
    left: (n.localX != null ? pw * parentPivot.x + n.localX
      : pw * (min.x + (max.x - min.x) * pivot.x) + n.x) - width * pivot.x,
    top: ph - (n.localY != null ? ph * parentPivot.y + n.localY
      : ph * (min.y + (max.y - min.y) * pivot.y) + n.y) - height * (1 - pivot.y) }
}

export function layoutChildren(n: UiNode, kids: UiNode[], w: number, h: number, children: Children): Map<string, Partial<Box>> {
  const out = new Map<string, Partial<Box>>(), g = n.layout
  if (!g) return out
  const p = padding(g), ax = ((g.m_ChildAlignment ?? 0) % 3) / 2, ay = Math.floor((g.m_ChildAlignment ?? 0) / 3) / 2
  if (g.class === 'GridLayoutGroup' && g.m_CellSize) {
    const cell = g.m_CellSize, gap = typeof g.m_Spacing === 'object' ? g.m_Spacing : { x: 0, y: 0 }
    const count = kids.length, constraint = Math.max(1, g.m_ConstraintCount ?? 1)
    let cols: number, rows: number
    if (g.m_Constraint === 1) { cols = constraint; rows = Math.ceil(count / cols) }
    else if (g.m_Constraint === 2) { rows = constraint; cols = Math.ceil(count / rows) }
    else {
      cols = Math.max(1, Math.floor((w - p.m_Left - p.m_Right + gap.x + .001) / (cell.x + gap.x)))
      rows = Math.max(1, Math.floor((h - p.m_Top - p.m_Bottom + gap.y + .001) / (cell.y + gap.y)))
    }
    const perMain = Math.max(1, g.m_StartAxis === 1 ? rows : cols)
    cols = Math.max(1, Math.min(cols, g.m_StartAxis === 1 ? Math.ceil(count / perMain) : count))
    rows = Math.max(1, Math.min(rows, g.m_StartAxis === 1 ? count : Math.ceil(count / perMain)))
    const startX = p.m_Left + (w - p.m_Left - p.m_Right - cols * cell.x - (cols - 1) * gap.x) * ax
    const startY = p.m_Top + (h - p.m_Top - p.m_Bottom - rows * cell.y - (rows - 1) * gap.y) * ay
    kids.forEach((c, i) => {
      let x = g.m_StartAxis === 1 ? Math.floor(i / perMain) : i % perMain
      let y = g.m_StartAxis === 1 ? i % perMain : Math.floor(i / perMain)
      if ((g.m_StartCorner ?? 0) % 2) x = cols - 1 - x
      if ((g.m_StartCorner ?? 0) >= 2) y = rows - 1 - y
      out.set(c.id, { left: startX + x * (cell.x + gap.x), top: startY + y * (cell.y + gap.y), width: cell.x, height: cell.y })
    })
  } else if (g.class === 'HorizontalLayoutGroup') {
    const gap = typeof g.m_Spacing === 'number' ? g.m_Spacing : 0
    const ordered = g.m_ReverseArrangement ? [...kids].reverse() : kids
    const sizes = ordered.map(c => ({ width: g.m_ChildControlWidth ? preferred(c, 'width', children) : measure(c, children).width,
      height: g.m_ChildControlHeight ? preferred(c, 'height', children) : measure(c, children).height }))
    const used = sizes.reduce((sum, s, i) => sum + s.width * (g.m_ChildScaleWidth ? ordered[i].sx : 1), 0) + Math.max(0, kids.length - 1) * gap
    const surplus = w - p.m_Left - p.m_Right - used
    const extra = g.m_ChildForceExpandWidth ? Math.max(0, surplus) / Math.max(1, kids.length) : 0
    let x = p.m_Left + (g.m_ChildForceExpandWidth && surplus > 0 ? 0 : surplus * ax)
    ordered.forEach((c, i) => {
      const size = sizes[i], scaleX = g.m_ChildScaleWidth ? c.sx : 1, scaleY = g.m_ChildScaleHeight ? c.sy : 1
      const width = size.width + (g.m_ChildControlWidth ? extra / scaleX : 0)
      const height = g.m_ChildControlHeight && g.m_ChildForceExpandHeight ? Math.max(size.height, (h - p.m_Top - p.m_Bottom) / scaleY) : size.height
      out.set(c.id, { left: x + (g.m_ChildControlWidth ? 0 : extra * ax),
        top: p.m_Top + (h - p.m_Top - p.m_Bottom - height * scaleY) * ay, width, height })
      x += size.width * scaleX + extra + gap
    })
  }
  return out
}

export function rotationCss(n: UiNode): string {
  // Unity Euler order is Z-X-Y; reflection of the Y axis maps to CSS angles (-X,+Y,-Z).
  if (n.rx != null || n.ry != null || n.rz != null) return `rotateY(${n.ry ?? 0}deg) rotateX(${- (n.rx ?? 0)}deg) rotateZ(${- (n.rz ?? 0)}deg)`
  const q = n.rect?.m_LocalRotation
  if (!q) return ''
  const norm = Math.hypot(q.x, q.y, q.z, q.w) || 1, w = Math.max(-1, Math.min(1, q.w / norm))
  return `rotate3d(${-q.x},${q.y},${-q.z},${2 * Math.acos(w)}rad)`
}
