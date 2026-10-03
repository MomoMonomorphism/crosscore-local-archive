import type { DeveloperLayer, DeveloperOverrides, DeveloperPickCandidate, DeveloperScene, DeveloperSlot } from './developerControls'

export type DeveloperTileTab = 'layers' | 'slots' | 'masks'
export type DeveloperLayerTile =
  | { kind: 'layer'; layer: DeveloperLayer; candidate: DeveloperPickCandidate; mask: boolean; searchText: string }
  | { kind: 'slot'; slot: DeveloperSlot; layer: DeveloperLayer | undefined; candidate: DeveloperPickCandidate; mask: boolean; searchText: string }

const maskPattern = /clipping|mask|matte|裁切|遮罩|溶解|黑幕|黑影|black|shadow|hei(?:ying|dian|ping)/i

export function isDeveloperMaskLayer(layer: DeveloperLayer): boolean {
  return maskPattern.test(`${layer.kind} ${layer.label}`)
}

/** A matte graphic is ordinary artwork. Only a layer that advertises a real
 * clipping/material feature gets the bypass control; matte graphics use hide. */
export function canDisableDeveloperLayerClipping(layer: DeveloperLayer): boolean {
  return /裁切|clipping|材质遮罩|溶解|(?:^|[\s·])mask(?:$|[\s·])/i.test(layer.kind)
}

export function createDeveloperLayerTiles(scene: DeveloperScene | null): DeveloperLayerTile[] {
  if (!scene) return []
  const layerById = new Map(scene.layers.map(layer => [layer.id, layer]))
  return [
    ...scene.layers.map((layer): DeveloperLayerTile => ({ kind: 'layer', layer,
      candidate: { id: layer.id, kind: 'layer', layerId: layer.id, label: layer.label, type: layer.kind, opacity: layer.opacity },
      mask: isDeveloperMaskLayer(layer), searchText: `${layer.id} ${layer.label} ${layer.assetId} ${layer.kind}`.toLocaleLowerCase(),
    })),
    ...scene.slots.map((slot): DeveloperLayerTile => {
      const layer = layerById.get(slot.layerId)
      return { kind: 'slot', slot, layer,
        candidate: { id: slot.id, kind: 'slot', layerId: slot.layerId, label: slot.name, type: slot.type,
          attachment: slot.attachment, order: slot.order, opacity: slot.alpha },
        mask: slot.maskCandidate || slot.type === 'clipping',
        searchText: `${slot.id} ${slot.name} ${slot.type} ${slot.attachment ?? ''} ${slot.attachments.join(' ')} ${layer?.label ?? ''} ${layer?.assetId ?? ''}`.toLocaleLowerCase(),
      }
    }),
  ]
}

/** Visibility is deliberately not a filter: a hidden object still needs to be
 * selectable so its rule can be restored without picking it in the canvas. */
export function filterDeveloperLayerTiles(tiles: readonly DeveloperLayerTile[], tab: DeveloperTileTab,
  layerId: string, search: string): DeveloperLayerTile[] {
  const words = search.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean)
  return tiles.filter(tile => (tab === 'masks' ? tile.mask : tile.kind === (tab === 'layers' ? 'layer' : 'slot'))
    && (!layerId || tile.candidate.layerId === layerId)
    && words.every(word => tile.searchText.includes(word)))
}

export function isSelectedDeveloperTile(tile: DeveloperLayerTile, selected: DeveloperPickCandidate | null): boolean {
  return selected?.kind === tile.kind && selected.id === tile.candidate.id
}

/** Keep manual controls distinct from why artwork is currently absent. Solo
 * permits drawing its target but does not supply an attachment or force alpha. */
export function developerTileState(tile: DeveloperLayerTile, overrides: DeveloperOverrides) {
  const candidate = tile.candidate
  const ruleKey: 'layers' | 'slots' = tile.kind === 'layer' ? 'layers' : 'slots'
  const rule = overrides[ruleKey][candidate.id] ?? {}
  const clipping = tile.kind === 'slot' && tile.slot.type === 'clipping'
  const solo = overrides.solo
  const isSolo = !!solo && solo.kind === tile.kind && solo.id === candidate.id
  const ownerSolo = tile.kind === 'layer' && solo?.kind === 'slot' && solo.id.startsWith(`${candidate.id}::`)
  const forcedVisible = Boolean(isSolo || ownerSolo)
  const allowed = clipping ? !rule.disableClipping : tile.kind === 'layer'
    ? rule.hidden === undefined ? tile.layer.visible : !rule.hidden : !rule.hidden
  const excluded = !!solo && (tile.kind === 'layer' ? !forcedVisible : solo.kind === 'layer'
    ? solo.id !== candidate.layerId : clipping ? !solo.id.startsWith(`${candidate.layerId}::`) : solo.id !== candidate.id)
  const layer = tile.layer
  const ownerRule = layer ? overrides.layers[layer.id] : undefined
  const ownerVisible = !layer || (solo ? solo.kind === 'layer' ? solo.id === layer.id : solo.id.startsWith(`${layer.id}::`)
    : ownerRule?.hidden === undefined ? layer.visible : !ownerRule.hidden)
  const ownerTransparent = !!layer && (layer.opacity === 0 || ownerRule?.opacity === 0)
  const unavailable = tile.kind === 'slot'
    ? !ownerVisible ? '所属层隐藏' : ownerTransparent ? '所属层透明' : !tile.slot.attachment ? '当前无附件'
      : !clipping && (tile.slot.alpha === 0 || rule.opacity === 0) ? '当前透明' : ''
    : tile.layer.opacity === 0 || rule.opacity === 0 ? '当前透明' : ''
  const status = clipping ? allowed ? '裁切启用' : '裁切禁用'
    : excluded ? '独显排除' : !allowed && !forcedVisible ? '已隐藏' : unavailable || '显示'
  return { rule, ruleKey, clipping, allowed, isSolo, forcedVisible, excluded, status,
    note: clipping ? unavailable : status === unavailable ? '' : unavailable,
    modified: !!Object.keys(rule).length || isSolo }
}
