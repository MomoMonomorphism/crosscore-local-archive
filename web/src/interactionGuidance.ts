import type { InteractionRow, InteractionState } from './interactionMachine'

export type InteractionGuide = {
  source: InteractionRow
  target: InteractionRow
  path: InteractionRow[] | null
  next: InteractionRow | null
  waiting: boolean
  pending: boolean
  complete: boolean
}

/** Explain source-backed nextClick chains without guessing from animation names.
 *
 * A row with a zero-area rect is reached by the game's callback, so the guide
 * searches backwards through activation=1 edges for a visible clickable row.
 * Complex activation (multi-click inversion, conditions, pose changes) is left
 * unresolved rather than presented as a guaranteed click sequence.
 */
export function interactionGuides(rows: InteractionRow[], state: InteractionState, nowMs: number): InteractionGuide[] {
  const current = rows.filter((row) => row.pose === state.role)
  const byIndex = new Map(current.map((row) => [row.index, row]))
  const simple = (row: InteractionRow) => row.hittable && !row.gesture && !row.poseSwitch
    && !row.content.clicks?.length && !row.content.conditions?.length
    && !row.content.needClicks?.length && !row.content.noClick?.length
    && !row.content.orderActions?.length && !row.content.randomActions?.length
  const pathTo = (
    target: InteractionRow,
    active: (row: InteractionRow) => boolean,
    seen = new Set<number>(),
  ): InteractionRow[] | null => {
    if (!simple(target) || seen.has(target.index)) return null
    if (active(target)) return [target]
    const visited = new Set(seen).add(target.index)
    const paths = current
      .filter((row) => row.index !== target.index && row.content.activation?.[String(target.index)] === 1)
      .map((row) => pathTo(row, active, visited))
      .filter((path): path is InteractionRow[] => path != null)
      .map((path) => [...path, target])
    paths.sort((a, b) => a.length - b.length || a[0].index - b[0].index)
    return paths[0] ?? null
  }

  return current.flatMap((source) => {
    const target = byIndex.get(source.content.nextClick ?? -1)
    if (!target) return []
    const path = pathTo(source, (row) => !('isHide' in row.content))
    const remaining = pathTo(source, (row) => Boolean(state.active[String(row.index)]))
    const pending = Object.values(state.pendingChains).includes(target.index)
    const complete = Boolean(state.clickCounts[String(target.index)])
    return [{
      source, target, path,
      next: complete || pending ? null : remaining?.[0] ?? null,
      waiting: Boolean(state.tracks['1']) || nowMs < state.interludeUntilMs,
      pending, complete,
    }]
  })
}
