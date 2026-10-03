import type { DeveloperOverrides, DeveloperPickCandidate, DeveloperPlaybackHandle, DeveloperRule } from './developerControls'

export function patchDeveloperObject(overrides: DeveloperOverrides, kind: 'layer' | 'slot', id: string,
  patch: DeveloperRule): DeveloperOverrides {
  const key = kind === 'layer' ? 'layers' : 'slots'
  const result: DeveloperOverrides = { layers: overrides.layers, slots: overrides.slots,
    [key]: { ...overrides[key], [id]: { ...overrides[key][id], ...patch } } }
  const solo = overrides.solo
  const forcedVisible = solo && (solo.kind === kind && solo.id === id
    || kind === 'layer' && solo.kind === 'slot' && solo.id.startsWith(`${id}::`))
  if (solo && !(patch.hidden === true && forcedVisible)) result.solo = solo
  return result
}

/** Restore exactly one object. Restoring a layer must not erase independently
 * adjusted child slots, and restoring a slot must not affect other slots. */
export function restoreDeveloperObject(overrides: DeveloperOverrides, kind: 'layer' | 'slot', id: string): DeveloperOverrides {
  const key = kind === 'layer' ? 'layers' : 'slots'
  const rules = { ...overrides[key] }
  delete rules[id]
  const result: DeveloperOverrides = { layers: overrides.layers, slots: overrides.slots, [key]: rules }
  if (overrides.solo && (overrides.solo.kind !== kind || overrides.solo.id !== id)) result.solo = overrides.solo
  return result
}

export function developerCandidateIndex(candidates: readonly DeveloperPickCandidate[], selected: DeveloperPickCandidate | null): number {
  return selected ? candidates.findIndex(candidate => candidate.kind === selected.kind && candidate.id === selected.id) : -1
}

export function stepDeveloperCandidate(candidates: readonly DeveloperPickCandidate[], selected: DeveloperPickCandidate | null,
  delta: -1 | 1): DeveloperPickCandidate | null {
  if (!candidates.length) return null
  const index = developerCandidateIndex(candidates, selected)
  const next = index < 0 ? delta < 0 ? candidates.length - 1 : 0 : (index + delta + candidates.length) % candidates.length
  return candidates[next]
}

/** Prefer the nearest owning page. An illustration/ASMR controller may live
 * inside the main app, and the outer app must not control that nested page. */
export function findDeveloperPlayback(surface: HTMLElement | null, handles: Iterable<DeveloperPlaybackHandle>): DeveloperPlaybackHandle | null {
  if (!surface) return null
  let selected: { handle: DeveloperPlaybackHandle; surface: HTMLElement } | null = null
  for (const handle of handles) {
    try {
      const owner = handle.surface()
      if (owner?.contains(surface) && (!selected || selected.surface.contains(owner))) selected = { handle, surface: owner }
    } catch { /* An owning page can unmount while the inspector is open. */ }
  }
  return selected?.handle ?? null
}
