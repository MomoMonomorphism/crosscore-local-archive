import { ClippingAttachment } from '@esotericsoftware/spine-core'
import { CAPRICCIO_MASK_ASSET, CAPRICCIO_MASK_SLOTS } from './developerMask'

export type DeveloperRule = { hidden?: boolean; opacity?: number; disableClipping?: boolean }
export type DeveloperOverrides = {
  layers: Record<string, DeveloperRule>
  slots: Record<string, DeveloperRule>
  solo?: { kind: 'layer' | 'slot'; id: string }
}
export type DeveloperLayer = {
  id: string; label: string; assetId: string; kind: string; visible: boolean; opacity: number
}
export type DeveloperSlot = {
  id: string; layerId: string; name: string; type: string; attachment: string | null
  attachments: string[]; alpha: number; maskCandidate: boolean; order: number
}
export type DeveloperScene = {
  id: string; label: string; layers: DeveloperLayer[]; slots: DeveloperSlot[]
  tracks?: Array<{ layerId: string; track: number; animation: string; time: number; duration: number }>
}
export type DeveloperPickCandidate = {
  id: string; kind: 'layer' | 'slot'; layerId: string; label: string
  attachment?: string | null; type?: string; order?: number; opacity?: number
  relatedClipping?: string[]
}
export type DeveloperThumbnail = {
  url: string; width: number; height: number; kind: 'texture' | 'geometry' | 'layer'
}
export type DeveloperSceneHandle = {
  id: string; label: string; snapshot: () => DeveloperScene; active?: () => boolean
  surface?: () => HTMLElement | null
  pick?: (clientX: number, clientY: number) => DeveloperPickCandidate[]
  highlight?: (candidate: DeveloperPickCandidate | null) => void
  thumbnail?: (candidate: DeveloperPickCandidate) => DeveloperThumbnail | null
}
/** Use the owning page's playback state so timers, Lua and rendering pause together. */
export type DeveloperPlaybackHandle = {
  id: string
  surface: () => HTMLElement | null
  getState: () => { playing: boolean; available: boolean }
  setPlaying: (playing: boolean) => void
}

export function emptyDeveloperOverrides(): DeveloperOverrides { return { layers: {}, slots: {} } }
export function developerSlotId(layerId: string, name: string): string { return `${layerId}::${name}` }

function factor(value: number | undefined): number {
  return value === undefined || !Number.isFinite(value) ? 1 : Math.max(0, Math.min(1, value))
}

/** Solo is a temporary inspection view: its target remains visible even if an
 * eye toggle was off. Clearing solo brings the saved eye toggles back. */
export function developerLayerPresentation(layerId: string, baseVisible: boolean, baseOpacity: number,
  overrides: DeveloperOverrides | null): { visible: boolean; opacity: number } {
  if (!overrides) return { visible: baseVisible, opacity: baseOpacity }
  const rule = overrides.layers[layerId]
  const solo = overrides.solo
  const selected = solo && (solo.kind === 'layer'
    ? solo.id === layerId : solo.id.startsWith(`${layerId}::`))
  return { visible: solo ? Boolean(selected) : rule?.hidden === undefined ? baseVisible : !rule.hidden,
    opacity: baseOpacity * factor(rule?.opacity) }
}

type RenderSlot<T> = { data: { name: string }; attachment: T | null; color: { a: number } }

/** Override only the instance values consumed by one draw. Calling
 * setAttachment would clear mesh deforms, so attachments are assigned directly.
 * Clipping geometry is kept when isolating/hiding slots: users must explicitly
 * disable it to expose geometry outside the original clip region. */
export function createDeveloperSlotFilter<T>(slots: readonly RenderSlot<T>[], layerId: string) {
  const entries = slots.map(slot => ({ slot, id: developerSlotId(layerId, slot.data.name) }))
  return (overrides: DeveloperOverrides | null, render: () => void) => {
    if (!overrides) { render(); return }
    const saved: Array<{ slot: RenderSlot<T>; attachment: T | null; alpha: number }> = []
    const solo = overrides.solo?.kind === 'slot' ? overrides.solo : null
    for (const { slot, id } of entries) {
      const rule = overrides.slots[id]
      const clipping = slot.attachment instanceof ClippingAttachment
      const hidden = clipping ? Boolean(rule?.disableClipping)
        : solo ? solo.id !== id : Boolean(rule?.hidden)
      const opacity = clipping ? 1 : factor(rule?.opacity)
      if ((!hidden || slot.attachment === null) && opacity === 1) continue
      saved.push({ slot, attachment: slot.attachment, alpha: slot.color.a })
      if (hidden) slot.attachment = null
      slot.color.a *= opacity
    }
    try { render() }
    finally {
      for (const { slot, attachment, alpha } of saved) {
        slot.attachment = attachment
        slot.color.a = alpha
      }
    }
  }
}

/** Convert the original experiment into a scene-scoped preset. It has no effect
 * on another asset, and only references slots that actually exist in this scene. */
export function capriccioMaskOverrides(scene: DeveloperScene): DeveloperOverrides | null {
  const layers = new Set(scene.layers.filter(layer => layer.assetId === CAPRICCIO_MASK_ASSET).map(layer => layer.id))
  const result = emptyDeveloperOverrides()
  for (const slot of scene.slots) {
    if (layers.has(slot.layerId) && CAPRICCIO_MASK_SLOTS.some(name => name === slot.name)) {
      result.slots[slot.id] = { hidden: true }
    }
  }
  return Object.keys(result.slots).length ? result : null
}
