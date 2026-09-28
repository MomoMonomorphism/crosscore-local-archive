import type { InteractionRow, InteractionState } from './interactionMachine'

export type PoseContract = { initialRole: number; poses: Record<string, { l2dName: string | null }> }
export type InteractionIssue = { row: number; code: string; level: 'error' | 'review'; message: string }

/** Structural evidence only; graph reachability does not prove gameplay reachability. */
export function inspectInteraction(rows: InteractionRow[], contract: PoseContract,
  animations?: Record<string, string[] | null>,
  emittedEvents?: Record<string, string[] | null>): InteractionIssue[] {
  const issues: InteractionIssue[] = []
  const add = (row: InteractionRow, code: string, level: InteractionIssue['level'], message: string) =>
    issues.push({ row: row.index, code, level, message })
  const indexes = new Set(rows.map(r => r.index))
  const reachable = new Set([contract.initialRole])
  for (let previous = -1; previous !== reachable.size;) {
    previous = reachable.size
    for (const row of rows) if (reachable.has(row.pose) && row.poseSwitch) reachable.add(row.poseSwitch.targetRole)
  }
  const external = rows.some(r => r.content.isSpineUI)
  for (const row of rows) {
    if (rows.filter(r => r.index === row.index).length > 1) add(row, 'duplicate-index', 'error', '触点编号重复')
    const pose = contract.poses[String(row.pose)]
    if (!pose?.l2dName) add(row, 'unmapped-pose', 'error', `姿态 ${row.pose} 没有骨骼映射`)
    if (!reachable.has(row.pose)) add(row, 'no-pose-path', 'review', `配置中未找到通往姿态 ${row.pose} 的切换路径`)
    const refs: Array<[string, number]> = [
      ...Object.keys(row.content.activation ?? {}).map(n => ['activation', Number(n)] as [string, number]),
      ...(row.content.needClicks ?? []).map(n => ['needClicks', n] as [string, number]),
      ...(row.content.noClick ?? []).map(n => ['noClick', n] as [string, number]),
      ...(row.content.reset7 ?? []).map(n => ['reset7', n] as [string, number]),
    ]
    if (row.content.nextClick != null) refs.push(['nextClick', row.content.nextClick])
    if (row.content.conditions?.length) refs.push(['conditions', row.content.conditions[0]])
    if (row.poseSwitch?.afterIndex != null) refs.push(['afterIndex', row.poseSwitch.afterIndex])
    for (const [field, target] of refs) if (!indexes.has(target))
      add(row, 'missing-row', 'error', `${field} 引用不存在的触点 #${target}`)
    if (row.poseSwitch && contract.poses[String(row.poseSwitch.targetRole)]?.l2dName !== row.poseSwitch.targetSpine)
      add(row, 'pose-target', 'error', `切换目标姿态 ${row.poseSwitch.targetRole} 与骨骼映射不一致`)
    if ('isHide' in row.content) {
      const incoming = rows.some(r => Object.hasOwn(r.content.activation ?? {}, String(row.index))
        || r.content.nextClick === row.index || r.poseSwitch?.afterIndex === row.index)
      if (!incoming) add(row, 'hidden-no-source', 'review', external
        ? '默认隐藏；配置中没有直接激活来源，需核查小游戏宿主回调'
        : '默认隐藏；尚未找到配置中的激活或回调来源')
    }
    if (!animations) continue
    const names = animations[String(row.pose)]
    if (names == null) { add(row, 'unverified-skeleton', 'review', '对应骨骼数据未就绪，未核对动作'); continue }
    // Pose-switch/ASMR/UI rows dispatch other hosts, not their sName on this skeleton.
    if (row.poseSwitch || row.content.asmr || row.content.isSpineUI) continue
    const wanted = row.content.orderActions?.length ? [...row.content.orderActions]
      : row.content.randomActions?.length ? row.content.randomActions.map(x => x[0]) : row.anim ? [row.anim] : []
    if (row.content.changeIdle) wanted.push(row.content.changeIdle[0])
    // Activation only enables a touch GameObject; it does not execute its action.
    // Keep missing names visible even when no currently known invocation exists.
    const eventsComplete = emittedEvents && Object.keys(contract.poses).every(role => emittedEvents[role] != null)
    const invoked = rows.some(r => r.content.nextClick === row.index || r.poseSwitch?.afterIndex === row.index)
      || Object.values(emittedEvents ?? {}).some(events => events?.includes(`TriggerIndex_${row.index}`))
    const noKnownInvocation = !row.hittable && !external && eventsComplete && !invoked
    for (const name of new Set(wanted)) if (!names.includes(name))
      add(row, 'missing-animation', row.dragHost || noKnownInvocation ? 'review' : 'error',
        `骨骼中未找到动作 ${name}${row.dragHost ? '，需核查拖动子骨骼' : noKnownInvocation
          ? '；此行无可点击面积，配置链和已读取的骨骼事件未发现调用，保留待核查' : ''}`)
  }
  return issues
}

/** Same eligibility as the debug overlay. Active does not mean input is unlocked. */
export const isCurrentHotspot = (row: InteractionRow, role: number) => Boolean(row.hittable && row.rects[0] && row.pose === role)

export function hotspotSummary(rows: InteractionRow[], state: InteractionState) {
  const total = rows.filter(r => r.hittable).length
  const current = rows.filter(r => isCurrentHotspot(r, state.role))
  return { total, current: current.length, enabled: current.filter(r => state.active[String(r.index)]).length }
}

export function hotspotExplanation(row: InteractionRow, state: InteractionState) {
  if (row.pose !== state.role) return `其他姿态 ${row.pose}`
  if (!state.active[String(row.index)]) return '当前隐藏／未激活；见前置条件与配置诊断'
  const conditions = [
    row.content.needClicks?.length ? `需先触发 ${row.content.needClicks.map(n => `#${n}`).join('、')}` : '',
    row.content.conditions?.length ? `受 #${row.content.conditions[0]} 的动作进度或记录限制` : '',
    row.content.noClick?.length ? `受 ${row.content.noClick.map(n => `#${n}`).join('、')} 的动作状态限制` : '',
    row.content.needIdle != null ? '有待机条件' : '',
  ].filter(Boolean)
  return `已启用${row.gesture ? ' · 手势触点' : ''}${conditions.length ? `；${conditions.join('；')}` : ''}`
}
