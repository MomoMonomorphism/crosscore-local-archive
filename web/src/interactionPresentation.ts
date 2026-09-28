import type { InteractionEvent, InteractionRow, InteractionState, Transition } from './interactionMachine'

export function operationLabel(row: InteractionRow) {
  if (row.content.asmr) return '打开 ASMR'
  if (row.poseSwitch || row.content.changeIdle) return '切换姿态'
  if (row.gesture === 6) return '长按拖动'
  if (row.gesture || row.content.drag) return '拖动交互'
  if (row.content.clicks?.length) return '分段点击'
  if (row.content.actions) return '停点交互'
  if (row.content.isSpineUI) return '专用互动'
  return '点击'
}

export function operationHelp(row: InteractionRow, state: InteractionState) {
  const track = state.tracks[String(row.track)]
  const current = track?.animation === row.anim ? track : null
  const parts: string[] = []
  if (row.content.clicks?.length) {
    const step = state.records[String(row.realIndex)] ?? 0
    parts.push(`共 ${row.content.clicks.length} 段${step ? `，已发起第 ${step} 段` : ''}。${current?.playing ? '当前段播放中，请等到停点或结束。' : current && step && step < row.content.clicks.length ? '已到停点，再点击同一区域继续。' : '点击开始；每到停点再点一次。'}`)
    if (row.content.activation) parts.push('分段推进会改变其他热区的显隐，以当前可用操作为准。')
  } else if (row.content.drag) {
    parts.push(row.gesture === 6 ? '长按该区域后拖动物件。' : '在该区域按住并拖动物件。')
    if (row.dragHost?.targets.length) parts.push(`拖动时对照落点提示，移到目标附近再松开；可触发 ${row.dragHost.targets.map(t => t.animation).join(' / ')}。`)
  } else if (row.gesture) {
    parts.push('在热区内按住拖动，动作随拖动变化；松开后的处理由原配置决定。')
  } else if (row.content.actions) {
    parts.push('点击开始，动作包含配置停点；停点后的继续方式取决于交互状态。')
  } else if (row.content.asmr) parts.push('点击画面热区会打开对应 ASMR 专辑。')
  else parts.push(`点击画面热区${row.anim ? `播放 ${row.anim}` : '执行配置交互'}。`)
  if (row.content.changeIdle) parts.push(`随后按配置切换到 ${row.content.changeIdle[0]}。`)
  if (row.poseSwitch) parts.push(`切换到姿态 ${row.poseSwitch.targetRole}。`)
  if (row.content.needClicks?.length) parts.push(`前置记录：${row.content.needClicks.map(n => `#${n}`).join('、')}。`)
  if (row.content.conditions?.length || row.content.noClick?.length || row.content.needIdle != null)
    parts.push('还受动作进度或待机条件限制，启用不代表此刻能触发。')
  return parts.join(' ')
}

export type GuideStep = { row: InteractionRow; via: 'input' | 'activation' | 'automatic' }
/** Dependency paths, not a simulated solution: activation may toggle on a later
 * multi-click. Explicitly retain that uncertainty; never execute a guide. */
export function activationPath(rows: InteractionRow[], state: InteractionState, target: InteractionRow): GuideStep[] | null {
  if (target.pose !== state.role) return null
  const current = rows.filter(r => r.pose === state.role)
  const queue: GuideStep[][] = [[{ row: target, via: 'input' }]]
  const visited = new Set<number>()
  while (queue.length) {
    const path = queue.shift()!, head = path[0].row
    if (visited.has(head.index)) continue
    visited.add(head.index)
    if (head.hittable && head.rects.length && state.active[String(head.index)]) return path
    for (const parent of current) {
      if (parent.poseSwitch || parent.index === head.index) continue
      const automatic = parent.content.nextClick === head.index
      if (!automatic && parent.content.activation?.[String(head.index)] !== 1) continue
      queue.push([{ row: parent, via: 'input' }, { row: head, via: automatic ? 'automatic' : 'activation' }, ...path.slice(1)])
    }
  }
  return null
}

export type InteractionFeedback = { title: string; index?: number; rejected?: boolean }
export function inputFeedback(rows: InteractionRow[], event: InteractionEvent, transition: Transition): InteractionFeedback | null {
  if (event.type !== 'press' && event.type !== 'drag-begin' && event.type !== 'object-drop' && event.type !== 'drag-end') return null
  if (event.type === 'press' && event.internal) return null
  const index = 'index' in event ? event.index : undefined
  if (!transition.accepted) return { index, rejected: true, title: `本次未触发：${transition.reason || '当前条件不满足'}` }
  if (event.type === 'drag-begin') return { index, title: '已开始拖动，请在画面中继续操作。' }
  if (event.type === 'drag-end' || event.type === 'object-drop') {
    const play = transition.effects.find(e => e.type === 'play')
    return { index, title: event.cancelled ? '拖动已取消。' : play?.type === 'play' ? `已触发 ${play.animation}`
      : event.type === 'object-drop' ? '未命中落点，物件按配置恢复。' : '已松开，动作按配置继续或恢复。' }
  }
  const play = transition.effects.find(e => e.type === 'play')
  const row = rows.find(r => r.index === index)
  return { index, title: play?.type === 'play' ? `已触发 ${play.animation}`
    : row?.content.asmr ? '正在打开 ASMR 专辑。'
    : row?.poseSwitch ? '已开始切换姿态。' : `已接受热区 #${index} 的操作。` }
}
