import { useEffect, useState } from 'react'
import type { InteractionRow, InteractionState } from './interactionMachine'
import { hotspotSummary, isCurrentHotspot } from './interactionDiagnostics'
import { operationHelp, operationLabel } from './interactionPresentation'
import { GalleryGuides } from './GalleryLayout'

export function InteractionHelp({ rows, state, showAll, onShowAll, onLocate, active, onShowActions }: {
  rows: InteractionRow[]; state: InteractionState; showAll: boolean
  active: boolean; onShowActions: () => void
  onShowAll: (value: boolean) => void; onLocate: (index: number | null) => void
}) {
  const [selected, setSelected] = useState<number | null>(null)
  const [operationsOpen, setOperationsOpen] = useState(true)
  useEffect(() => { if (!active) setSelected(null) }, [active])
  const count = hotspotSummary(rows, state)
  const available = rows.filter(r => isCurrentHotspot(r, state.role) && state.active[String(r.index)])
  const selectedRow = available.find(r => r.index === selected)
  const suspended = Boolean(state.hallEntry || state.spineUi.open || state.pendingPoseLoad)
  const focus = (index: number | null) => onLocate(suspended || !active ? null : index)
  return <div className="interaction-help">
    <div className="interaction-operations-heading"><button aria-expanded={operationsOpen} onClick={() => { setOperationsOpen(!operationsOpen); focus(null) }}>{operationsOpen ? '▾' : '▸'} 当前启用 {count.enabled} / 全部 {count.total}</button>
      <label><input type="checkbox" checked={showAll} onChange={e => onShowAll(e.target.checked)}/>显示全部热区</label></div>
    {suspended ? <p className="interaction-help-note">{state.hallEntry ? '大厅入场中，结束后恢复操作指引。' : state.spineUi.open ? '专用互动界面已打开，请使用画面内的控件。' : '姿态切换中，请等待画面就绪。'}</p> : operationsOpen && <>
      <p className="interaction-help-note">定位会高亮画面热区，请在画面中操作。已启用的热区仍可能受动作进度或前置条件限制。</p>
      <div className="interaction-operation-cards">{available.map(row => {
        const help = operationHelp(row, state)
        return <article key={row.index} className={selected === row.index ? 'located' : ''}>
          <header><strong><small>#{row.index}</small> {operationLabel(row)}</strong><button aria-label={`定位热区 #${row.index}`} aria-pressed={selected === row.index}
            onMouseEnter={() => focus(row.index)} onMouseLeave={() => focus(selectedRow?.index ?? null)}
            onFocus={() => focus(row.index)} onBlur={() => focus(selectedRow?.index ?? null)}
            onClick={() => { const next = selected === row.index ? null : row.index; setSelected(next); focus(next) }}>{selected === row.index ? '取消定位' : '定位'}</button></header>
          <p>{row.content.clicks?.length ? help.split('。').slice(0, 2).join('。') + '。'
            : row.poseSwitch ? `点击后切换到姿态 ${row.poseSwitch.targetRole}。`
            : row.content.changeIdle ? `点击后切换待机姿态；详细动作见下方。`
            : row.content.drag || row.gesture || row.content.actions || row.content.asmr ? help.split('。')[0] + '。'
            : '点击该区域触发互动。'}</p>
          <details><summary>条件与动作详情</summary><p>{help}</p><small>配置动作：{row.anim || '内部交互'} · 轨道 {row.track}</small></details>
        </article>
      })}{!available.length && <p className="interaction-help-note">当前没有启用的画面热区。</p>}</div>
    </>}
    <button className="interaction-action-link" onClick={onShowActions}>按动作查找触发步骤 →</button>
    <details className="interaction-paths"><summary>自动动作链状态</summary><GalleryGuides rows={rows} state={state}/></details>
  </div>
}
