import type { InteractionRow } from './interactionMachine'

export type AnimationTrigger = { row: InteractionRow; uses: string[]; callbacks: { row: InteractionRow; kind: 'chain' | 'pose' }[] }

/** Enumerate source references without claiming that every reference is a directly clickable action. */
export function animationTriggers(rows: InteractionRow[], animation: string): AnimationTrigger[] {
  return rows.flatMap(row => {
    const uses: string[] = []
    if (row.anim === animation) uses.push(row.content.orderActions?.length || row.content.randomActions?.length
      ? '配置主动作名；实际播放会由顺序／随机动作组选择。' : '该配置的主动作。')
    const positions = row.content.orderActions?.flatMap((name, i) => name === animation ? [i + 1] : []) ?? []
    if (positions.length) uses.push(`顺序动作组第 ${positions.join('、')} 项；重复操作按原配置推进。`)
    if (row.content.randomActions?.some(([name]) => name === animation)) uses.push('随机动作组候选；操作成功也不保证选中此动作。')
    for (const target of row.dragHost?.targets ?? []) if (target.animation === animation)
      uses.push(`拖动物件，放到落点 ${target.name} 后触发；拖起本身不会播放此动作。`)
    if (row.content.changeIdle?.[0] === animation) uses.push(`该配置触发后 ${row.content.changeIdle[1]}ms 切换为此待机。`)
    if (!uses.length) return []
    const callbacks: AnimationTrigger['callbacks'] = rows.flatMap(source => [
      ...(source.content.nextClick === row.index ? [{ row: source, kind: 'chain' as const }] : []),
      ...(source.poseSwitch?.afterIndex === row.index ? [{ row: source, kind: 'pose' as const }] : []),
    ])
    return [{ row, uses, callbacks }]
  })
}
