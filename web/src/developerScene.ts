import type { Application, DisplayObject } from 'pixi.js'
import { ClippingAttachment, MeshAttachment, RegionAttachment, type Spine } from '@esotericsoftware/spine-pixi-v7'
import { createDeveloperSlotFilter, developerLayerPresentation, developerSlotId,
  type DeveloperOverrides, type DeveloperScene, type DeveloperSceneHandle } from './developerControls'
import { suppressedCameraMatteAttachments } from './spineCameraMatte'
import { createDeveloperPicking, developerSurfaceVisible } from './developerPicking'
import { createDeveloperThumbnailSource } from './developerThumbnailSource'

type SceneApi = {
  getOverrides: (sceneId: string) => DeveloperOverrides | null
  registerScene: (handle: DeveloperSceneHandle) => () => void
}
type Layer = { id: string; label: string; assetId: string; kind: string; object: DisplayObject; spine?: Spine }

/** All overrides exist only for the draw call; gameplay and bounds retain their authored state. */
export function createDeveloperScene(app: Application, id: string, label: string, api: SceneApi) {
  const layers: Layer[] = []
  const detachSlots: Array<() => void> = []
  let unregister: (() => void) | null = null
  let disposed = false
  let drawOverridesApplied = false
  const thumbnail = createDeveloperThumbnailSource(layers, () => disposed)
  const picking = createDeveloperPicking(app, layers, () => api.getOverrides(id), () => disposed,
    () => drawOverridesApplied)
  const renderer = app.renderer
  const priorRender = renderer.render
  const baseRender = priorRender.bind(renderer)
  const wrappedRender: typeof priorRender = (...args) => {
    if (disposed) { baseRender(...args); return }
    const overrides = api.getOverrides(id)
    if (!overrides) { baseRender(...args); return }
    const saved = layers.map(layer => ({ layer, visible: layer.object.visible,
      alpha: layer.object.alpha, mask: layer.object.mask }))
    const ancestorVisibility: Array<{ object: DisplayObject; visible: boolean }> = []
    const priorDrawOverridesApplied = drawOverridesApplied
    try {
      for (const value of saved) {
        const { visible, opacity } = developerLayerPresentation(value.layer.id, value.visible, value.alpha, overrides)
        value.layer.object.visible = visible
        value.layer.object.alpha = opacity
        if (overrides.layers[value.layer.id]?.disableClipping) value.layer.object.mask = null
      }
      // Soloing a nested drag image must not hide its containing object.
      const solo = overrides.solo
      const selected = layers.filter(layer => solo ? solo.kind === 'layer' ? layer.id === solo.id
        : solo.id.startsWith(`${layer.id}::`) : overrides.layers[layer.id]?.hidden === false)
      for (const layer of selected) {
        for (let parent = layer.object.parent; parent && parent !== app.stage.parent; parent = parent.parent) {
          if (!parent.visible) {
            if (!layers.some(item => item.object === parent)) ancestorVisibility.push({ object: parent, visible: false })
            parent.visible = true
          }
        }
      }
      drawOverridesApplied = true
      baseRender(...args)
    } finally {
      for (const value of saved) {
        value.layer.object.visible = value.visible
        value.layer.object.alpha = value.alpha
        if (value.layer.object.mask !== value.mask) value.layer.object.mask = value.mask
      }
      for (const value of ancestorVisibility) value.object.visible = value.visible
      drawOverridesApplied = priorDrawOverridesApplied
    }
  }
  renderer.render = wrappedRender
  const snapshot = (): DeveloperScene => ({
    id, label,
    layers: layers.map(layer => ({ id: layer.id, label: layer.label, assetId: layer.assetId,
      kind: layer.kind + (layer.object.mask ? ' · 外部裁切' : ''), visible: layer.object.visible, opacity: layer.object.alpha })),
    slots: layers.flatMap(layer => layer.spine?.skeleton.slots.map((slot, index) => {
      const attachment = slot.attachment ?? suppressedCameraMatteAttachments(layer.spine!)?.get(slot.data.name)
      const attachments = new Set<string>()
      for (const skin of layer.spine!.skeleton.data.skins) {
        const entries: Array<{ name: string }> = []
        skin.getAttachmentsForSlot(index, entries as Parameters<typeof skin.getAttachmentsForSlot>[1])
        for (const entry of entries) attachments.add(entry.name)
      }
      const type = attachment instanceof ClippingAttachment ? 'clipping'
        : attachment instanceof MeshAttachment ? 'mesh' : attachment instanceof RegionAttachment ? 'region' : 'empty'
      return { id: developerSlotId(layer.id, slot.data.name), layerId: layer.id, name: slot.data.name,
        type, attachment: attachment?.name ?? null, attachments: [...attachments], alpha: slot.color.a,
        maskCandidate: type === 'clipping' || /mask|matte|black|shadow|hei(?:ying|dian|ping)|遮罩|黑幕/i.test(slot.data.name + ' ' + [...attachments].join(' ')),
        order: layer.spine!.skeleton.drawOrder.indexOf(slot) }
    }) ?? []),
    tracks: layers.flatMap(layer => layer.spine?.state.tracks.flatMap((entry, track) => entry?.animation
      ? [{ layerId: layer.id, track, animation: entry.animation.name, time: entry.trackTime, duration: entry.animation.duration }] : []) ?? []),
  })
  return {
    addLayer(object: DisplayObject, key: string, name: string, kind = 'image', assetId = key) {
      const existing = layers.find(layer => layer.object === object)
      if (existing) return existing.id
      let unique = key, occurrence = 1
      while (layers.some(layer => layer.id === unique)) unique = `${key}#${++occurrence}`
      layers.push({ id: unique, label: name, assetId, kind, object })
      return unique
    },
    addSpine(spine: Spine, assetId: string, name: string, kind = 'spine') {
      const existing = layers.find(layer => layer.object === spine && layer.spine)
      if (existing) return existing.id
      const key = this.addLayer(spine, assetId, name, kind, assetId)
      const layer = layers.find(item => item.object === spine)!
      layer.spine = spine
      const filter = createDeveloperSlotFilter(spine.skeleton.slots, key)
      const original = spine.updateTransform
      const draw = original.bind(spine)
      const wrapped = () => {
        const overrides = api.getOverrides(id)
        const restored = []
        for (const slot of spine.skeleton.slots) {
          if (slot.attachment !== null || overrides?.slots[developerSlotId(key, slot.data.name)]?.hidden !== false) continue
          const matte = suppressedCameraMatteAttachments(spine)?.get(slot.data.name)
          if (matte) { restored.push(slot); slot.attachment = matte }
        }
        try { filter(overrides, draw) }
        finally { for (const slot of restored) slot.attachment = null }
      }
      spine.updateTransform = wrapped
      detachSlots.push(() => { if (spine.updateTransform === wrapped) spine.updateTransform = original })
      return key
    },
    publish() {
      if (disposed) return
      unregister?.()
      unregister = api.registerScene({ id, label, snapshot, surface: picking.surface, thumbnail,
        pick: picking.pick, highlight: picking.highlight, active: () => {
        const canvas = picking.surface()
        return canvas ? developerSurfaceVisible(canvas) : typeof document === 'undefined'
      } })
    },
    dispose() {
      disposed = true
      picking.dispose()
      unregister?.(); unregister = null
      if (renderer.render === wrappedRender) renderer.render = priorRender
      for (const detach of detachSlots) detach()
      layers.length = 0
    },
  }
}
