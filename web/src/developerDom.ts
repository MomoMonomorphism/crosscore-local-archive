import { useEffect, useRef, type CSSProperties, type RefObject } from 'react'
import { useDeveloperMode } from './DeveloperMode'
import { developerLayerPresentation, type DeveloperOverrides, type DeveloperScene } from './developerControls'
import type { UiNode } from './spineUiLayout'
import { createDeveloperDomPicker } from './developerDomPicking'
import { loadedDeveloperDomThumbnailSource } from './developerDomThumbnail'
import { createDeveloperImageThumbnail } from './developerThumbnailSource'

type ImageLayer = {
  sceneId: string; sceneLabel: string; layerId: string; label: string; assetId: string
  kind?: string; visible?: boolean; opacity?: number
}

/** Static images register the same read-only scene interface as canvas scenes.
 * Overriding visibility leaves the image and its authored event tree mounted. */
export function useDeveloperImageLayer(config: ImageLayer, registered = true,
  elementRef?: RefObject<HTMLElement>): CSSProperties {
  const developer = useDeveloperMode()
  const current = useRef(config); current.current = config
  useEffect(() => {
    if (!registered) return
    let disposed = false
    const picker = createDeveloperDomPicker(() => elementRef?.current?.parentElement ?? null, () => {
      const element = elementRef?.current, value = current.current
      return element ? [{ element, candidate: { id: value.layerId, layerId: value.layerId,
        kind: 'layer' as const, label: value.label, type: value.kind ?? '静态图片' } }] : []
    })
    const unregister = developer.registerScene({ id: config.sceneId, label: config.sceneLabel,
      ...(elementRef ? { surface: picker.surface, pick: picker.pick, highlight: picker.highlight } : {}),
      thumbnail: candidate => {
        const value = current.current
        if (disposed || value.sceneId !== config.sceneId || candidate.kind !== 'layer'
          || candidate.id !== value.layerId || candidate.layerId !== value.layerId) return null
        const image = loadedDeveloperDomThumbnailSource(elementRef?.current ?? null)
        return image ? createDeveloperImageThumbnail(image.source, image.width, image.height) : null
      },
      snapshot: () => {
      const value = current.current
      return { id: value.sceneId, label: value.sceneLabel,
        layers: [{ id: value.layerId, label: value.label, assetId: value.assetId,
          kind: value.kind ?? '静态图片', visible: value.visible ?? true, opacity: value.opacity ?? 1 }], slots: [] }
    } })
    return () => { disposed = true; picker.dispose(); unregister() }
  }, [developer.registerScene, config.sceneId, registered, elementRef])
  const presentation = developerLayerPresentation(config.layerId, config.visible ?? true, config.opacity ?? 1,
    developer.getOverrides(config.sceneId))
  return { visibility: presentation.visible ? undefined : 'hidden', opacity: presentation.opacity }
}

export const developerUiLayerId = (nodeId: string): string => `ui:${nodeId}`

export function developerUiScene(sceneId: string, label: string, nodes: readonly UiNode[]): DeveloperScene {
  return { id: sceneId, label, slots: [], layers: nodes.map(node => {
    const features = [node.image || node.material ? '互动图片' : node.text ? '互动文字' : node.color ? '互动色块' : '互动容器']
    if (node.mask) features.push('图片裁切')
    if (node.rectMask) features.push('矩形裁切')
    if (node.filled) features.push('填充裁切')
    if (node.material?.keywords.some(keyword => keyword === '_USEMASK_ON' || keyword === '_USEDISSOLVE_ON'))
      features.push('材质遮罩/溶解')
    return { id: developerUiLayerId(node.id), label: `${node.name} · ${node.id}`,
      assetId: node.image ?? node.material?.name ?? node.id, kind: features.join(' · '),
      visible: node.active, opacity: node.alpha ?? 1 }
  }) }
}

/** Showing an inactive node needs its ancestor layout wrappers, and solo needs
 * those same wrappers. They remain structural only: other artwork is not shown. */
export function developerUiRequiredNodes(nodes: readonly UiNode[], overrides: DeveloperOverrides | null): Set<string> {
  const required = new Set<string>()
  if (!overrides) return required
  const byId = new Map(nodes.map(node => [node.id, node]))
  const include = (node: UiNode) => {
    let current: UiNode | undefined = node
    const visited = new Set<string>()
    while (current && !visited.has(current.id)) {
      visited.add(current.id); required.add(current.id)
      current = current.parent ? byId.get(current.parent) : undefined
    }
  }
  for (const node of nodes) {
    const id = developerUiLayerId(node.id)
    if (overrides.solo?.kind === 'layer' ? overrides.solo.id === id : overrides.layers[id]?.hidden === false)
      include(node)
  }
  return required
}
