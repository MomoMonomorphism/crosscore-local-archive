import type { InteractionRow, InteractionState } from './interactionMachine'
import { animationTriggers } from './animationTriggers'
import { activationPath, operationHelp, operationLabel } from './interactionPresentation'

export function ActionTriggerGuide({ animation, rows, state, canLocate, onLocate, hallEntry }: {
  animation: string; rows: InteractionRow[]; state: InteractionState | null
  canLocate: boolean; onLocate: (index: number | null) => void; hallEntry: boolean
}) {
  const matches = animationTriggers(rows, animation)
  return <div className="action-trigger-guide">
    {animation === 'in' && hallEntry && <p>大厅入场由“重播入场”启动，结束后恢复游戏交互。直接预览仅播放素材片段。</p>}
    {state?.idle === animation && <p>这是当前交互待机，交互空闲时由运行时持续播放。</p>}
    {!matches.length && <p>{rows.length ? '未在当前交互配置中找到此动作的直接或间接引用。它可能是待机、过场或辅助素材，暂不提供未经确认的点击步骤。' : '此资源没有可用的游戏交互配置；可直接预览素材。'}</p>}
    {matches.length > 0 && <p className="action-guide-note">原配置入口：{matches.length} 个 · 按当前交互状态推导</p>}
    {matches.map(({ row, uses, callbacks }) => {
      const otherPose = state && row.pose !== state.role
      const path = state && !otherPose ? activationPath(rows, state, row) : null
      return <section key={row.index} className="action-trigger-source">
        <h4>#{row.index} · {operationLabel(row)} <small>姿态 {row.pose}{otherPose ? ' · 其他姿态' : ''}</small></h4>
        {uses.map(use => <p key={use}>{use}</p>)}
        {callbacks.map(({ row: source, kind }) => <p key={`${kind}:${source.index}`}>自动入口：姿态 {source.pose} 的 #{source.index}{kind === 'pose' ? ' 完成姿态切换后回调此配置。' : ' 动作回调后自动触发此配置。'}</p>)}
        {otherPose ? <p>先通过游戏交互切到姿态 {row.pose}，再查看该姿态下的操作步骤。</p> : path && state ? <>
          <button disabled={!canLocate} onClick={() => onLocate(path[0].row.index)}>定位入口热区 #{path[0].row.index}</button>
          {!canLocate && <p className="action-guide-note">返回游戏交互并等待画面就绪后可定位。</p>}
          <ol>{path.map((step, i) => <li key={step.row.index}>
            <strong>{step.via === 'automatic' ? '自动回调' : step.via === 'activation' ? '开放后操作' : '当前入口'} #{step.row.index} · {operationLabel(step.row)}</strong>
            <p>{step.via === 'automatic' ? '由前一步回调触发，无需点击此项。' : operationHelp(step.row, state)}</p>
            {step.row.content.clicks?.length && path[i + 1]?.via === 'activation' ? <p>下一热区开放后即可操作；继续推进当前分段可能再次关闭它。</p> : null}
          </li>)}</ol>
        </> : <p>{row.hittable ? '尚未找到从当前状态出发的热区依赖路径。' : '此配置没有直接可点击面积。'}{callbacks.length ? '可参考上述自动入口。' : '触发途径仍需核实。'}</p>}
      </section>
    })}
    {matches.length > 0 && <details className="action-guide-note"><summary>指引依据与限制</summary><p>列出匹配的配置入口，每个入口给出一条可找到的依赖路径，不代表所有玩法路径。路径未逐条实机验证；动作进度、前置条件和分段显隐反转仍可能影响结果。</p></details>}
  </div>
}
