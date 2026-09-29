import { useEffect, useState } from 'react'
import type { VoiceBank, VoicePictureBank, VoiceStream } from './types'
import { pictureSpeakerName, pictureVoiceText } from './pictureVoiceBanks'
import { interactionGuides } from './interactionGuidance'
import type { InteractionRow, InteractionState } from './interactionMachine'
import { simplifyDisplay } from './simplifyDisplay'
import { hotspotSummary, hotspotExplanation, type InteractionIssue } from './interactionDiagnostics'
export { useGalleryLayout } from './useGalleryLayout'

export function GalleryHotspotDetails({ rows, state, issues, corrections = [] }: {
  rows: InteractionRow[]; state: InteractionState; issues: InteractionIssue[]; corrections?: string[]
}) {
  const count = hotspotSummary(rows, state)
  return <details className="gallery-hotspot-details"><summary>热区明细：已启用 {count.enabled} / 配置 {count.total}
    {issues.length ? ` · 异常 ${new Set(issues.filter(i => i.level === 'error').map(i => i.row)).size} · 待核查 ${new Set(issues.filter(i => i.level === 'review').map(i => i.row)).size}` : ''}
    {corrections.length ? ` · 已有来源更正 ${corrections.length}` : ''}</summary>
    <p>当前姿态 {count.current} 个触点（含隐藏），全配置 {count.total} 个。启用不代表此刻满足点击条件；动作忙碌不会改变计数。这里显示配置结构诊断，骨骼动作完整性另见离线扫描报告。</p>
    {corrections.map(text => <p key={text}>{text}</p>)}
    {rows.map(row => <div key={row.index}><strong>#{row.index} → {row.anim || row.kind}</strong> · {row.hittable ? hotspotExplanation(row, state) : '无可点击面积；内部调用项'}
      {issues.filter(issue => issue.row === row.index).map(issue => <p key={`${issue.code}:${issue.message}`}>{issue.level === 'error' ? '异常' : '待核查'}：{issue.message}</p>)}</div>)}
  </details>
}

export function GalleryGuides({ rows, state }: { rows: InteractionRow[]; state: InteractionState | null }) {
  if (state?.hallEntry) return <div className="gallery-chains" aria-label="热区顺序提示"><p>{state.hallEntry.phase === 'in'
    ? '正在播放大厅入场，可点击画面或“跳过入场”结束；入场结束后恢复热区与动作链提示。'
    : '正在恢复游戏交互，稍后恢复热区与动作链提示。'}</p></div>
  const guides = state ? interactionGuides(rows, state, performance.now()) : []
  return <div className="gallery-chains" aria-label="热区顺序提示">{guides.map(guide => <div key={guide.source.index}>
    <strong>{guide.path ? `${guide.path.map(row => `#${row.index} ${row.anim || '切换'}`).join(' → ')} → 自动 #${guide.target.index} ${guide.target.anim || '动作'}` : `#${guide.source.index} ${guide.source.anim || '动作'} → 自动 #${guide.target.index} ${guide.target.anim || '动作'}`}</strong>
    <span>{guide.complete ? '本轮已触发' : guide.pending ? `等待 #${guide.source.index} 动作结束，随后自动播放` : guide.next ? `${guide.waiting ? '等待当前动作结束；' : ''}下一步点击 #${guide.next.index} ${guide.next.anim || ''}` : '尚未找到可确认的点击顺序，可能需要其他姿态或条件'}</span>
  </div>)}{!guides.length && <p>当前姿态没有可确认的自动动作链；触点条件与拒绝原因会随操作显示。</p>}</div>
}

export function GalleryVoiceTools({ bank, streams, categories, category, onCategory, count, query, onQuery, active, canStop, onPlay, onStop, language, hasChinese, onLanguage, sourceNote, volume, onVolume, picture }: {
  bank: VoiceBank | null | undefined; streams: VoiceStream[]; categories: Array<readonly [string, string]>; category: string
  onCategory: (v: string) => void; count: (id: string) => number; query: string; onQuery: (v: string) => void
  active: number; canStop: boolean; onPlay: (s: VoiceStream) => void; onStop: () => void; language: 'ja' | 'zh'; hasChinese: boolean
  onLanguage: (v: 'ja' | 'zh') => void; sourceNote: string; volume: number; onVolume: (n: number) => void
  picture?: { banks: VoicePictureBank[]; onBank: (id: string) => void; speaker: string; onSpeaker: (id: string) => void
    speakers: { id: string; name: string }[]; roleNames: Record<string, string> }
}) {
  const [selected, setSelected] = useState<number | null>(null)
  useEffect(() => setSelected(null), [bank?.id, picture?.speaker])
  const playing = bank?.streams.find(s => s.index === active)
  const current = bank?.streams.find(s => s.index === selected) ?? playing ?? streams[0]
  const displayText = picture ? pictureVoiceText : simplifyDisplay
  const label = (s: VoiceStream) => displayText(s.semantic?.labelSimplified || s.semantic?.label || `未识别音轨 ${s.index}`)
  return <>
    {picture && picture.banks.length > 0 && <label className="gallery-picture-bank">关联声库<select aria-label="CG 关联声库" value={bank?.id ?? ''} onChange={e => picture.onBank(e.target.value)}>{picture.banks.map(item => <option key={item.id} value={item.id}>{displayText(item.titleSimplified || item.title)} · {item.streamCount} 条</option>)}</select></label>}
    <div className="gallery-voice-search"><input aria-label="搜索台词" value={query} onChange={e => onQuery(e.target.value)} placeholder={picture ? '搜索台词、人物或音轨名' : '搜索台词、标签或音轨名'}/>{!picture && <select aria-label="配音语言" value={language} onChange={e => onLanguage(e.target.value as 'ja' | 'zh')}><option value="ja">CV 日配</option><option value="zh" disabled={!hasChinese}>{hasChinese ? 'CV 中配' : '暂无中配'}</option></select>}</div>
    {picture ? <nav className="gallery-voice-categories gallery-picture-speakers" aria-label="CG 人物筛选"><button aria-pressed={picture.speaker === 'all'} onClick={() => picture.onSpeaker('all')}>全部人物</button>{picture.speakers.map(item => <button key={item.id} aria-pressed={picture.speaker === item.id} onClick={() => picture.onSpeaker(item.id)}>{item.name}</button>)}</nav>
      : <nav className="gallery-voice-categories" aria-label="语音分类">{categories.map(([id, name]) => <button key={id} aria-pressed={id === category} onClick={() => onCategory(id)}>{name} <small>{count(id)}</small></button>)}</nav>}
    <div className="gallery-result-count">{streams.length} 条台词 · 选择看全文，▷ 试听</div>
    <div className="gallery-voice-list">{streams.map(s => <div key={s.index} className={`gallery-voice-card ${current?.index === s.index ? 'selected' : ''}`}><button className="gallery-voice-select" onClick={() => setSelected(s.index)}><strong>{picture ? `${displayText(pictureSpeakerName(s, picture.roleNames))} · ${label(s)}` : label(s)}</strong><span>{displayText(s.semantic?.script || (picture ? '有语音，暂无台词文本' : s.name))}</span></button><button className="gallery-voice-play" aria-label={`试听 ${label(s)}`} onClick={() => { setSelected(s.index); onPlay(s) }}>{active === s.index ? '♪' : '▷'}<small>{s.duration.toFixed(1)}s</small></button></div>)}{!streams.length && <p className="gallery-empty">{bank ? '没有匹配的台词' : '当前资源暂无已映射语音'}</p>}</div>
    <div className="gallery-voice-detail">
      {playing && playing.index !== current?.index && <section className="gallery-voice-playing" aria-label="正在播放的台词"><small>正在播放 · {label(playing)}</small><p>{displayText(playing.semantic?.script || (picture ? '有语音，暂无台词文本' : playing.name))}</p></section>}
      <small>{playing?.index === current?.index && current ? '正在播放' : '选中台词'}</small><strong>{current ? label(current) : '暂无台词'}</strong><p>{current ? displayText(current.semantic?.script || (picture ? '有语音，暂无台词文本' : current.name)) : '画面和动作仍可独立查看。'}</p><div><button className="gallery-action-entry" disabled={!current} onClick={() => current && onPlay(current)}><span className="gallery-action-icon" aria-hidden="true">▷</span>{current && playing?.index === current.index ? '重新播放' : '试听这句'}</button><button disabled={!canStop} onClick={onStop}>停止</button></div><label>音量<input aria-label="语音音量" type="range" min="0" max="1" step=".01" value={volume} onChange={e => onVolume(Number(e.target.value))}/><small>{Math.round(volume * 100)}%</small></label><details><summary>语音来源</summary><small>{sourceNote || '没有本地声库'}{current && <><br/>音轨：{current.name}</>}{current?.semantic?.textProvenance && <><br/>台词来源：{current.semantic.textProvenance.platform === 'android' ? '安卓配置补充' : 'PC 配置'} · {current.semantic.textProvenance.asset}</>}</small></details></div>
  </>
}
