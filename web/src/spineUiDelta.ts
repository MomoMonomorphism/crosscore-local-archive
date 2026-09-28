import type { UiNode } from './spineUiLayout'

// Preserve unchanged node objects while applying the Lua scene's sparse updates.
export function applyUiNodeDelta(nodes: UiNode[], updates: UiNode[], removed: string[] = []): UiNode[] {
  const byId = new Map(updates.map(node => [node.id, node]))
  const deleted = new Set(removed)
  const known = new Set(nodes.map(node => node.id))
  const next = nodes.filter(node => !deleted.has(node.id)).map(node => {
    const patch = byId.get(node.id)
    if (!patch) return node
    const merged = { ...node, ...patch }
    for (const key of ['parent', 'localX', 'localY', 'localZ', 'image', 'text', 'anim', 'animElapsed'] as const)
      if (key in patch && (patch as Record<string, unknown>)[key] === false)
        delete (merged as Record<string, unknown>)[key]
    return merged
  })
  next.push(...updates.filter(node => !known.has(node.id)))
  return next
}
