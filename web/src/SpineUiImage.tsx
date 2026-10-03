import { memo, useId } from 'react'
import type { CSSProperties } from 'react'
import type { UiNode } from './spineUiLayout'
import { UiMaterialImage } from './SpineUiMaterial'

export function fillStyle(node: UiNode): CSSProperties {
  if (!node.filled) return {}
  const f = Math.max(0, Math.min(1, node.fill ?? 1)), origin = node.fillOrigin ?? 0
  if (f >= 1) return {}
  if (f <= 0) return { visibility: 'hidden' }
  if (node.fillMethod === 4) {
    const start = [180, 90, 0, 270][origin] ?? 0
    const from = node.fillClockwise === false ? start - f * 360 : start
    return { maskImage: `conic-gradient(from ${from}deg, #000 0deg ${f * 360}deg, transparent ${f * 360}deg 360deg)` }
  }
  return { clipPath: node.fillMethod === 1
    ? `inset(${origin ? 0 : (1 - f) * 100}% 0 ${origin ? (1 - f) * 100 : 0}% 0)`
    : `inset(0 ${origin ? 0 : (1 - f) * 100}% 0 ${origin ? (1 - f) * 100 : 0}%)` }
}

export const UiImage = memo(function UiImage({ node, width, height, time = 0, disableClipping = false }: {
  node: UiNode; width: number; height: number; time?: number; disableClipping?: boolean
}) {
  const id = `tint-${useId().replace(/:/g, '')}`, c = node.color ?? { r: 1, g: 1, b: 1, a: 1 }
  if (width <= 0 || height <= 0) return null
  if (node.material) return <UiMaterialImage node={node} width={width} height={height} time={time} disableClipping={disableClipping} />
  if (!node.image) return node.color ? <div style={{ position: 'absolute', inset: 0,
    background: `rgba(${c.r * 255},${c.g * 255},${c.b * 255},${c.a})` }} /> : null
  const meta = node.imageMeta, sw = meta?.width ?? width, sh = meta?.height ?? height
  let dw = width, dh = height, dx = 0, dy = 0
  if (node.preserveAspect && node.imageType !== 1) {
    const scale = Math.min(width / sw, height / sh);dw = sw * scale;dh = sh * scale
    dx = (width - dw) * (node.rect?.m_Pivot?.x ?? .5)
    dy = (height - dh) * (1 - (node.rect?.m_Pivot?.y ?? .5))
  }
  const borders = meta?.border ?? [0, 0, 0, 0]
  const sliced = node.imageType === 1 && borders.some(v => v > 0)
  if (!sliced && !node.filled && c.r === 1 && c.g === 1 && c.b === 1 && c.a === 1) {
    return <img src={node.image} alt="" draggable={false}
      style={{ position: 'absolute', left: dx, top: dy, width: dw, height: dh }} />
  }
  const patches = []
  if (sliced) {
    const [left, bottom, right, top] = borders, ppu = (meta?.ppu ?? 100) / 100 * (node.ppuMultiplier ?? 1)
    const fx = Math.min(1, width * ppu / Math.max(1, left + right)), fy = Math.min(1, height * ppu / Math.max(1, top + bottom))
    const sx = [0, left, sw - right, sw], sy = [0, top, sh - bottom, sh]
    const tx = [0, left / ppu * fx, width - right / ppu * fx, width], ty = [0, top / ppu * fy, height - bottom / ppu * fy, height]
    for (let y = 0; y < 3; y++) for (let x = 0; x < 3; x++) {
      if (x === 1 && y === 1 && node.fillCenter === false) continue
      if (sx[x + 1] <= sx[x] || sy[y + 1] <= sy[y]) continue
      patches.push(<svg key={`${x}-${y}`} x={tx[x]} y={ty[y]} width={tx[x + 1] - tx[x]} height={ty[y + 1] - ty[y]}
        viewBox={`${sx[x]} ${sy[y]} ${sx[x + 1] - sx[x]} ${sy[y + 1] - sy[y]}`} preserveAspectRatio="none" overflow="hidden">
        <image href={node.image} width={sw} height={sh} preserveAspectRatio="none" />
      </svg>)
    }
  }
  return <svg width={dw} height={dh} viewBox={`0 0 ${dw} ${dh}`} style={{ position: 'absolute', left: dx, top: dy, overflow: 'hidden', ...(!disableClipping ? fillStyle(node) : {}) }}>
    <defs><filter id={id} x="0" y="0" width="100%" height="100%" colorInterpolationFilters="sRGB">
      <feComponentTransfer><feFuncR type="linear" slope={c.r} /><feFuncG type="linear" slope={c.g} />
        <feFuncB type="linear" slope={c.b} /><feFuncA type="linear" slope={c.a} /></feComponentTransfer>
    </filter></defs>
    <g filter={`url(#${id})`}>{sliced ? patches : <image href={node.image} width={dw} height={dh} preserveAspectRatio="none" />}</g>
  </svg>
})
