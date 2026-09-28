import type { InteractionRow } from './interactionMachine'

export type InteractionAnimationInfo = {
  indexes: number[]
  segments: number
  automatic: boolean
  noDirectHit: boolean
  gated: boolean
  otherPose: boolean
  ordered: boolean
  random: boolean
}

/** Source-backed labels for raw Spine clips. These describe how the game uses
 * a clip; preview playback itself intentionally bypasses those rules. */
export function interactionAnimationCatalog(rows: InteractionRow[], role: number) {
  const catalog = new Map<string, InteractionAnimationInfo>()
  const automaticTargets = new Set(rows.flatMap((row) => [
    ...(row.content.nextClick != null ? [row.content.nextClick] : []),
    ...(row.poseSwitch?.afterIndex != null ? [row.poseSwitch.afterIndex] : []),
  ]))
  const add = (name: string, row: InteractionRow, mode: 'direct' | 'ordered' | 'random') => {
    const info = catalog.get(name) ?? {
      indexes: [], segments: 0, automatic: false, noDirectHit: false, gated: false,
      otherPose: false, ordered: false, random: false,
    }
    if (!info.indexes.includes(row.index)) info.indexes.push(row.index)
    info.segments = Math.max(info.segments, row.content.clicks?.length ?? 0)
    info.automatic ||= automaticTargets.has(row.index)
    info.noDirectHit ||= !row.hittable
    info.gated ||= !row.initialActive || Boolean(row.content.conditions?.length)
      || Boolean(row.content.needClicks?.length) || Boolean(row.content.needIdle)
    info.otherPose ||= row.pose !== role
    info.ordered ||= mode === 'ordered'
    info.random ||= mode === 'random'
    catalog.set(name, info)
  }
  for (const row of rows) {
    if (row.anim) add(row.anim, row, 'direct')
    for (const name of row.content.orderActions ?? []) add(name, row, 'ordered')
    for (const [name] of row.content.randomActions ?? []) add(name, row, 'random')
  }
  return catalog
}

export function interactionAnimationLabel(info: InteractionAnimationInfo | undefined) {
  if (!info) return ''
  const tags: string[] = []
  if (info.segments) tags.push(`分${info.segments}段`)
  if (info.automatic) tags.push('自动连锁')
  else if (info.noDirectHit) tags.push('无直接热区')
  else if (info.gated) tags.push('需条件')
  else if (info.otherPose) tags.push('其他姿态')
  if (info.ordered) tags.push('顺序动作')
  if (info.random) tags.push('随机动作')
  return tags.length ? ` · ${tags.join(' · ')}` : ' · 游戏触点'
}

export function interactionAnimationExplanation(info: InteractionAnimationInfo | undefined) {
  if (!info) return '原始骨骼片段预览；不执行游戏交互、前置动作或语音。'
  const rules: string[] = []
  if (info.segments) rules.push(`游戏中分 ${info.segments} 次点击推进`)
  if (info.automatic) rules.push('由游戏配置的后续回调触发')
  else if (info.noDirectHit) rules.push('没有直接可点击热区，触发途径尚未核实')
  else if (info.gated) rules.push('需要先满足触点条件')
  if (info.otherPose) rules.push('属于其他姿态')
  if (info.ordered) rules.push('属于顺序动作组')
  if (info.random) rules.push('属于随机动作组')
  return `${rules.length ? `${rules.join('，')}；` : ''}这里仅预览骨骼片段，不执行前置动作或语音。`
}
