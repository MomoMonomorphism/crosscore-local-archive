import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { MouseEvent as ReactMouseEvent } from 'react'
import PictureFigure, { selectableAnimations } from './PictureFigure'
import PictureInteractiveFigure from './PictureInteractiveFigure'
import type { ContentSection } from './PrimaryNav'
import GalleryTopbar from './GalleryTopbar'
import type { Manifest, MultiPictureActionManifest, ThumbnailManifest, Variant, VoiceManifest, VoicePictureBank, VoiceStream } from './types'
import { hitStaticPicture } from './staticPictureTouch'
import { simplifyDisplay } from './simplifyDisplay'
import { useGalleryLayout } from './GalleryLayout'
import { GalleryToolbar } from './GalleryToolbar'
import { ImmersiveContext, ImmersiveTools, ImmersiveEntry } from './ImmersiveMode'
import { sitePath } from './sitePaths'

type View = 'gallery' | 'asmr' | 'picture' | 'audit'
type VoiceRow = { bankId: string; stream: VoiceStream; speaker: string; speakerId: string }

const SELECTION_KEY = 'crosscore-local-viewer.illustration'
const DEFAULT_L2D_POS = [0, 0, 1] as const
const archiveKey = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, '')
const lineTitle = (stream: VoiceStream) =>
  stream.semantic?.labelSimplified || stream.semantic?.label || stream.name || `音轨 ${stream.index}`

/** One archive ID is one illustration. CG skeletons and picture ACBs are its media. */
export default function IllustrationStage({ navigate, onSelectSection, gallery, roleNames }: {
  navigate: (view: View) => void
  onSelectSection: (section: ContentSection) => void
  gallery: Manifest | null
  roleNames: Record<string, string>
}) {
  const layout = useGalleryLayout(true)
  const [contract, setContract] = useState<MultiPictureActionManifest | null>(null)
  const [voices, setVoices] = useState<VoiceManifest | null>(null)
  const [thumbnails, setThumbnails] = useState<ThumbnailManifest | null>(null)
  const [archiveImages, setArchiveImages] = useState<string[]>([])
  const [error, setError] = useState('')
  const [selectedKey, setSelectedKey] = useState(() => {
    const params = new URLSearchParams(window.location.search)
    return params.get('illustration') || localStorage.getItem(SELECTION_KEY) || 'archive:1'
  })
  const [groupFilter, setGroupFilter] = useState('all')
  const [mediaFilter, setMediaFilter] = useState<'all' | 'dynamic' | 'voice' | 'static'>('all')
  const [query, setQuery] = useState('')
  const [mode, setMode] = useState<'dynamic' | 'static'>('dynamic')
  const [staticError, setStaticError] = useState(false)
  const [showFigure, setShowFigure] = useState(true)
  const [figurePlaying, setFigurePlaying] = useState(true)
  const [hotspotDebug, setHotspotDebug] = useState(false)
  const [hotspotCount, setHotspotCount] = useState(0)
  const [animation, setAnimation] = useState<string | null>(null)
  const [animations, setAnimations] = useState<string[]>([])
  const [previewResetSerial, setPreviewResetSerial] = useState(0)
  const [figureStatus, setFigureStatus] = useState('')
  const [figureError, setFigureError] = useState('')
  const [poseName, setPoseName] = useState('')
  const [activeBankId, setActiveBankId] = useState('')
  const [speaker, setSpeaker] = useState('all')
  const [transcriptQuery, setTranscriptQuery] = useState('')
  const [chain, setChain] = useState(false)
  const [playingKey, setPlayingKey] = useState('')
  const [selectedVoiceKey, setSelectedVoiceKey] = useState('')
  const [volume, setVolume] = useState(.65)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const linesRef = useRef<HTMLDivElement | null>(null)
  const choosePicture = (key: string) => {
    setSelectedKey(key)
    if (layout.compact) layout.setLibraryOpen(false)
  }
  const stopAudio = () => { audioRef.current?.pause(); setPlayingKey('') }
  useEffect(() => { if (audioRef.current) audioRef.current.volume = volume }, [volume])

  useEffect(() => {
    let cancelled = false
    const read = async <T,>(path: string): Promise<T> => {
      const response = await fetch(path)
      if (!response.ok) throw new Error(`${path}：HTTP ${response.status}`)
      return response.json() as Promise<T>
    }
    Promise.all([
      read<MultiPictureActionManifest>('/api/multi-interactions'),
      read<VoiceManifest>('/api/voices'),
      read<ThumbnailManifest>('/api/thumbnails'),
      read<{ names: string[] }>('/api/archive-images'),
    ]).then(([actions, voiceData, thumbData, images]) => {
      if (cancelled) return
      setContract(actions)
      setVoices(voiceData)
      setThumbnails(thumbData)
      setArchiveImages(images.names)
    }).catch((reason: Error) => { if (!cancelled) setError(reason.message) })
    return () => { cancelled = true }
  }, [])

  const pictures = useMemo(() => Object.values(contract?.archive ?? {})
    .sort((a, b) => Number(!a.groupIds.length) - Number(!b.groupIds.length)
      || (a.sort ?? 9999) - (b.sort ?? 9999) || a.id - b.id), [contract])
  const unmatchedIds = useMemo(() => (contract?.unresolvedPictures ?? [])
    .filter((id) => Boolean(voices?.pictureEntries?.[id])), [contract, voices])
  const picture = selectedKey.startsWith('archive:')
    ? contract?.archive[selectedKey.slice('archive:'.length)] ?? null : null
  const unmatchedBankId = selectedKey.startsWith('voice:') ? selectedKey.slice('voice:'.length) : ''

  useEffect(() => {
    if (!contract || !voices) return
    if (picture || unmatchedIds.includes(unmatchedBankId)) return
    setSelectedKey(pictures[0] ? `archive:${pictures[0].id}` : (unmatchedIds[0] ? `voice:${unmatchedIds[0]}` : ''))
  }, [contract, voices, picture, unmatchedBankId, unmatchedIds, pictures])

  useEffect(() => {
    if (!selectedKey) return
    localStorage.setItem(SELECTION_KEY, selectedKey)
    const params = new URLSearchParams(window.location.search)
    params.set('view', 'picture')
    params.set('illustration', selectedKey)
    window.history.replaceState(null, '', `${window.location.pathname}?${params}`)
  }, [selectedKey])

  const bankIds = picture?.pictureBankIds ?? (unmatchedBankId ? [unmatchedBankId] : [])
  const bankIdsKey = bankIds.join('|')
  useEffect(() => {
    setActiveBankId((current) => bankIds.includes(current) ? current : bankIds[0] || '')
  }, [selectedKey, bankIdsKey])
  const bank: VoicePictureBank | null = voices?.pictureEntries?.[activeBankId] ?? null

  const variant: Variant | null = useMemo(() => {
    if (!picture || !gallery || picture.entryMatches.length !== 1) return null
    const [entryId, variantId] = picture.entryMatches[0]
    const entry = gallery.entries.find((candidate) => candidate.id === entryId)
    return entry?.variants.find((candidate) => candidate.id === variantId) ?? null
  }, [picture, gallery])
  const staticName = useMemo(() => picture?.img
    ? archiveImages.find((name) => archiveKey(name) === archiveKey(picture.img || '')) || null
    : null, [picture?.img, archiveImages])
  const hasDynamic = Boolean(variant)
  const hasStatic = Boolean(staticName)
  const interactive = Boolean(picture && contract?.models[String(picture.id)]?.length)
  const hasStaticAudio = Boolean(picture && contract?.staticModels[String(picture.id)]
    ?.some((row) => row.audioId?.some((id) => contract.audioLookup[String(id)])))

  useEffect(() => {
    audioRef.current?.pause()
    setPlayingKey('')
    setSelectedVoiceKey('')
    setMode(hasDynamic ? 'dynamic' : 'static')
    setStaticError(false)
    setAnimation(null)
    setAnimations([])
    setFigureStatus('')
    setFigureError('')
    setPoseName('')
    setHotspotDebug(false)
    setSpeaker('all')
    setTranscriptQuery('')
  }, [selectedKey, hasDynamic])

  const groupNames = useMemo(() => new Map((contract?.groups ?? [])
    .map((group) => [group.id, simplifyDisplay(group.name)])), [contract])
  const filteredPictures = useMemo(() => {
    const term = query.trim().toLocaleLowerCase()
    return pictures.filter((item) => {
      if (groupFilter === 'unmatched') return false
      if (groupFilter === 'other' && item.groupIds.length) return false
      if (groupFilter !== 'all' && groupFilter !== 'other' && !item.groupIds.includes(Number(groupFilter))) return false
      if (mediaFilter === 'dynamic' && !item.entryMatches.length) return false
      if (mediaFilter === 'voice' && !item.pictureBankIds.length) return false
      if (mediaFilter === 'static' && item.entryMatches.length) return false
      if (!term) return true
      const bankNames = item.pictureBankIds.map((id) => voices?.pictureEntries?.[id]?.titleSimplified || '').join(' ')
      return `${item.id} ${item.title} ${simplifyDisplay(item.title)} ${item.img || ''} ${item.l2dName || ''} ${bankNames}`
        .toLocaleLowerCase().includes(term)
    })
  }, [pictures, groupFilter, mediaFilter, query, voices])
  const visibleUnmatched = useMemo(() => {
    if (groupFilter !== 'all' && groupFilter !== 'unmatched') return []
    if (mediaFilter === 'dynamic' || mediaFilter === 'static') return []
    const term = query.trim().toLocaleLowerCase()
    return unmatchedIds.filter((id) => {
      const item = voices?.pictureEntries?.[id]
      return item && (!term || `${item.titleSimplified} ${simplifyDisplay(item.titleSimplified)} ${item.sourceFile}`.toLocaleLowerCase().includes(term))
    })
  }, [groupFilter, mediaFilter, query, unmatchedIds, voices])

  const rows: VoiceRow[] = useMemo(() => bank?.streams.map((stream) => ({
    bankId: bank.id, stream,
    speakerId: stream.semantic?.characterRoleId || stream.semantic?.character || '未识别',
    speaker: (stream.semantic?.characterRoleId && roleNames[stream.semantic.characterRoleId])
      || stream.semantic?.character || '未识别',
  })) ?? [], [bank, roleNames])
  const visibleRows = useMemo(() => {
    const term = transcriptQuery.trim().toLocaleLowerCase()
    return rows.filter(({ stream, speaker: name, speakerId }) =>
      (speaker === 'all' || speaker === speakerId)
      && (!term || `${name} ${lineTitle(stream)} ${stream.semantic?.script || ''}`
        .toLocaleLowerCase().includes(term)))
  }, [rows, speaker, transcriptQuery])

  const play = useCallback((row: VoiceRow) => {
    const audio = audioRef.current
    if (!audio) return
    audio.src = sitePath(`assets/voice/${encodeURIComponent(row.bankId)}/${row.stream.index}.wav`)
    setPlayingKey(`${row.bankId}:${row.stream.index}`)
    setSelectedVoiceKey(`${row.bankId}:${row.stream.index}`)
    void audio.play().catch(() => setFigureStatus(`音轨 ${row.stream.index} 播放失败`))
  }, [])
  const playConfiguredAudio = useCallback((audioId: number) => {
    const location = contract?.audioLookup[String(audioId)]
    const item = location && voices?.pictureEntries?.[location.bankId]
      ?.streams.find((stream) => stream.index === location.streamIndex)
    if (!location || !item) {
      setFigureStatus(`游戏语音 ${audioId} 未在本地声库中解析`)
      return
    }
    if (bankIds.includes(location.bankId)) setActiveBankId(location.bankId)
    const roleId = item.semantic?.characterRoleId
    play({ bankId: location.bankId, stream: item,
      speakerId: roleId || item.semantic?.character || '未识别',
      speaker: (roleId && roleNames[roleId]) || item.semantic?.character || '未识别' })
  }, [bankIdsKey, contract, voices, play, roleNames])
  const handleStaticClick = (event: ReactMouseEvent<HTMLImageElement>) => {
    if (!picture || !contract) return
    const rows = contract.staticModels[String(picture.id)] ?? []
    const hit = hitStaticPicture(event.currentTarget, event.clientX, event.clientY, rows)
    if (!hit?.audioId?.length || (audioRef.current && !audioRef.current.paused)) return
    playConfiguredAudio(hit.audioId[0])
  }
  const handleAnimations = useCallback((names: string[]) => {
    setAnimations(selectableAnimations(names))
    setAnimation(null)
  }, [])
  const resetAnimation = useCallback(() => setAnimation(null), [])
  const advance = (delta: number) => {
    const position = visibleRows.findIndex((row) => `${row.bankId}:${row.stream.index}` === playingKey)
    const next = visibleRows[position + delta]
    if (next) play(next)
  }
  useEffect(() => {
    if (!playingKey) return
    const list = linesRef.current
    const line = list?.querySelector<HTMLElement>('.picture-line.active')
    if (!list || !line || !list.clientHeight) return
    list.scrollTo({ top: list.scrollTop + line.getBoundingClientRect().top - list.getBoundingClientRect().top
      - (list.clientHeight - line.offsetHeight) / 2, behavior: 'smooth' })
  }, [playingKey])

  const selectedVoice = rows.find(row => `${row.bankId}:${row.stream.index}` === selectedVoiceKey) ?? visibleRows[0]

  const title = simplifyDisplay(picture?.title || (bank?.titleSimplified || bank?.title) || '插画')
  const groupLabel = picture?.groupIds.map((id) => groupNames.get(id)).filter(Boolean).join(' · ') || '档案分组之外'

  return <ImmersiveContext.Provider value={layout.immersive}><div ref={layout.root} className={`app-shell gallery-shell illustration-gallery ${layout.immersive.active ? 'immersive-active' : ''} ${layout.libraryOpen ? '' : 'library-closed'} ${layout.toolsOpen ? '' : 'tools-closed'}`}>
    <ImmersiveTools mode={layout.immersive} playing={figurePlaying} onPlay={mode === 'dynamic' ? () => setFigurePlaying(v => !v) : undefined} canAdjust={mode === 'dynamic' && Boolean(variant)}
      debug={hotspotDebug} onDebug={mode === 'dynamic' && showFigure && interactive && !animation ? () => setHotspotDebug(v => !v) : undefined}/>
    <GalleryTopbar active="picture" onSelect={onSelectSection}/>
    <div className="gallery-mobilebar">
      <button aria-label="选择插画档案" aria-expanded={layout.libraryOpen} onClick={() => { layout.setLibraryOpen(!layout.libraryOpen); if (layout.landscape) layout.setToolsOpen(false) }}>☰ 档案 <span>{title}</span></button>
      <button onClick={() => layout.showTools('voices')}>人物台词</button>
    </div>
    {layout.drawer && <button className="gallery-scrim" aria-label="关闭面板" onClick={() => { layout.setLibraryOpen(false); if (layout.landscape) layout.setToolsOpen(false) }}/>}
    <aside className="library-panel" aria-label="插画档案">
      <button className="gallery-rail" aria-label="展开档案栏" onClick={() => layout.setLibraryOpen(true)}>☰<span>档案</span></button>
      <div className="gallery-library-heading"><strong>插画档案 <small>{pictures.length || '—'}</small></strong><button aria-label="收起档案栏" onClick={() => layout.setLibraryOpen(false)}>◧</button></div>
      <label className="search-box">
        <span>⌕</span>
        <input aria-label="搜索插画档案" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索画面、ID 或语音" />
      </label>
      <div className="illustration-filters">
        <label>
          <span>档案分组</span>
          <select value={groupFilter} onChange={(event) => setGroupFilter(event.target.value)}>
            <option value="all">全部画面 · {pictures.length}</option>
            {(contract?.groups ?? []).map((group) =>
              <option key={group.id} value={group.id}>{simplifyDisplay(group.name)} · {group.boardIds.length}</option>)}
            <option value="other">档案分组之外 · {pictures.filter((item) => !item.groupIds.length).length}</option>
            <option value="unmatched">未匹配语音 · {unmatchedIds.length}</option>
          </select>
        </label>
        <div className="illustration-filter-chips" aria-label="媒体筛选">
          {([['all', '全部'], ['dynamic', '动态'], ['static', '纯静态'], ['voice', '有语音']] as const).map(([id, label]) =>
            <button key={id} className={mediaFilter === id ? 'active' : ''} onClick={() => setMediaFilter(id)}>{label}</button>)}
        </div>
      </div>
      <div className="entry-count">{filteredPictures.length} 幅画面{visibleUnmatched.length ? ` · ${visibleUnmatched.length} 组待匹配语音` : ''}</div>
      <section className="entry-list illustration-list">
        {filteredPictures.map((item) => {
          const thumb = thumbnails?.archiveEntries?.[String(item.id)]
          return <button
            key={item.id}
            title={simplifyDisplay(item.title || item.img || `画面 ${item.id}`)}
            className={`entry-card illustration-card ${selectedKey === `archive:${item.id}` ? 'selected' : ''}`}
            onClick={() => choosePicture(`archive:${item.id}`)}
          >
            <span className="entry-monogram">
              {thumb ? <img src={sitePath(`assets/${thumb.path}`)} alt="" loading="lazy" /> : `#${item.id}`}
            </span>
            <span className="entry-copy">
              <strong>{simplifyDisplay(item.title || item.img || `画面 ${item.id}`)}</strong>
              <small>#{item.id} · {item.groupIds.map((id) => groupNames.get(id)).filter(Boolean).join(' / ') || '档案外'}
                {item.entryMatches.length ? ' · 动态' : ' · 静态'}
                {item.pictureBankIds.length ? ` · ${item.pictureBankIds.length} 组语音` : ''}</small>
            </span>
            <span className="entry-arrow">›</span>
          </button>
        })}
        {visibleUnmatched.length > 0 && <div className="illustration-list-heading">待匹配语音</div>}
        {visibleUnmatched.map((id) => {
          const item = voices?.pictureEntries?.[id]
          if (!item) return null
          return <button
            key={id}
            title={simplifyDisplay(item.titleSimplified || item.title)}
            className={`entry-card illustration-card ${selectedKey === `voice:${id}` ? 'selected' : ''}`}
            onClick={() => choosePicture(`voice:${id}`)}
          >
            <span className="entry-monogram">♫</span>
            <span className="entry-copy"><strong>{simplifyDisplay(item.titleSimplified || item.title)}</strong>
              <small>{item.sourceFile} · 画面待匹配</small></span>
            <span className="entry-arrow">›</span>
          </button>
        })}
        {!filteredPictures.length && !visibleUnmatched.length && <p className="gallery-empty">没有匹配的档案，请调整关键词或筛选条件。</p>}
      </section>
    </aside>

    <section className="viewer-panel illustration-panel">
      <header className="viewer-header illustration-header">
        <div>
          <span className="eyebrow">{picture ? `ARCHIVE #${picture.id} // ${groupLabel}` : 'UNMATCHED PICTURE AUDIO'}</span>
          <h2 title={title}>{title}</h2>
          <p>{picture ? '静态原图、动态画面与关联语音' : '画面关联待确认，可独立试听音轨'}
            {picture && poseName && <span className="viewer-header-meta"> · {poseName}</span>}
          </p>
        </div>
        <div className="viewer-header-actions">
          {picture?.entryMatches.map(([entryId, variantId], index) => <a className="illustration-related-link viewer-header-secondary" key={`${entryId}:${variantId}`}
            href={`/?${new URLSearchParams({ entry: entryId, variant: variantId })}`}
            title={`查看关联${entryId.startsWith('cg:') ? ' CG' : '角色'}资源，查看完整动作与交互指引`}>关联{entryId.startsWith('cg:') ? ' CG' : '角色'}{picture.entryMatches.length > 1 ? ` ${index + 1}` : ''} ↗</a>)}
          <ImmersiveEntry onEnter={layout.immersive.enter}/>
        </div>
      </header>

      <div className="illustration-workspace">
        <div className="illustration-canvas-column">
          <div className="illustration-viewport"><div className="picture-figure-frame illustration-frame">
            {picture && mode === 'static' && staticName && !staticError &&
              <img className="picture-static-image" src={sitePath(`assets/archive/${encodeURIComponent(staticName)}.png`)}
                alt={title} draggable={false} onClick={handleStaticClick}
                style={{ cursor: hasStaticAudio ? 'pointer' : undefined }}
                onError={() => setStaticError(true)} />}
            {picture && mode === 'dynamic' && variant && showFigure && interactive && contract && gallery &&
              <PictureInteractiveFigure key={picture.id} modelId={String(picture.id)} variant={variant}
                gallery={gallery} contract={contract} animation={animation} playing={figurePlaying} previewResetSerial={previewResetSerial}
                debug={hotspotDebug} onHotspotCount={setHotspotCount}
                onAudio={playConfiguredAudio} onStatus={setFigureStatus} onError={setFigureError}
                onAnimations={handleAnimations} onResetAnimation={resetAnimation} onPoseChange={setPoseName} />}
            {picture && mode === 'dynamic' && variant && showFigure && !interactive &&
              <PictureFigure key={picture.id} asset={variant.main}
                l2dPos={picture.l2dPos ?? DEFAULT_L2D_POS} animation={animation}
                playing={figurePlaying} previewResetSerial={previewResetSerial} onStatus={setFigureStatus} onError={setFigureError}
                onAnimations={handleAnimations} />}
            {(!picture || (mode === 'dynamic' && (!variant || !showFigure))
              || (mode === 'static' && (!staticName || staticError))) &&
              <div className="picture-figure-empty illustration-empty">
                <strong>{!picture ? '尚未确认对应画面' : !showFigure && mode === 'dynamic' ? '动态画面已隐藏' : '画面暂不可用'}</strong>
                <span>{!picture ? '可在右侧试听这组语音。' : mode === 'dynamic'
                  ? '当前档案没有已确认的可加载骨骼。' : '静态图未能从本地资源中加载。'}</span>
              </div>}
          </div></div>
        </div>
          <div className="illustration-mode-bar">
            <span>画面</span>
            <button className={mode === 'dynamic' ? 'active' : ''} disabled={!hasDynamic} onClick={() => { setMode('dynamic'); setFigureStatus(''); setFigureError('') }}>动态</button>
            <button className={mode === 'static' ? 'active' : ''} disabled={!hasStatic} onClick={() => { setMode('static'); setFigureStatus(''); setFigureError('') }}>静态原图</button>
            <div className="illustration-mode-actions">
              {mode === 'dynamic' && showFigure && picture?.hasDynamicTouch && <span className="illustration-evidence"
                title={animation ? '选择“游戏待机”恢复画面交互' : '点击画面热区，按游戏原配置触发动作或语音；可用区域随当前姿态变化'}>{animation ? '素材预览' : '支持画面交互'}</span>}
              {mode === 'static' && hasStaticAudio && <span className="illustration-evidence" title="点击原图中游戏配置的区域播放语音">点击听语音</span>}
            </div>
          </div>
          <div className="illustration-controls">
            {mode === 'dynamic' && variant && <GalleryToolbar items={[
              { id: 'play', minWidth: 0, node: <button className="play-button" onClick={() => setFigurePlaying(value => !value)} disabled={!showFigure}
                aria-label={figurePlaying ? '暂停动作' : '继续动作'} title={figurePlaying ? '暂停动作' : '继续动作'}>{figurePlaying ? 'Ⅱ' : '▶'}</button> },
              { id: 'animation', minWidth: 320, node: <label className="illustration-animation-select">动作
                <select aria-label="插画动作" value={animation ?? ''} onChange={(event) => setAnimation(event.target.value || null)}>
                  <option value="">游戏待机</option>
                  {animations.map((name) => <option key={name} value={name}>{name}</option>)}
                </select>
              </label> },
              { id: 'replay', minWidth: 500, node: animation && <button disabled={!showFigure} onClick={() => setPreviewResetSerial(value => value + 1)}>重播动作</button> },
              { id: 'hotspots', minWidth: 0, node: interactive && <button aria-label="显示交互热区" aria-pressed={hotspotDebug && showFigure && !animation}
                disabled={!showFigure || Boolean(animation)} title={animation ? '选择游戏待机后可查看热区' : '显示当前姿态的配置热区'}
                onClick={() => setHotspotDebug(value => !value)}>热区 {hotspotCount}</button> },
              { id: 'figure', minWidth: 99999, node: <label><input type="checkbox" checked={showFigure} onChange={event => setShowFigure(event.target.checked)} />显示画面</label> },
            ]}/>}
          </div>
          {figureError && <div className="illustration-load-error" role="alert">{figureError}</div>}
          <details className="illustration-info"><summary>画面信息与交互详情</summary>
          <div className="illustration-feedback" aria-label="画面与交互提示">
            <strong>画面与交互提示</strong>
            <span className={figureError ? 'illustration-status error' : 'illustration-status'} role="status">
              {figureError || (animation ? `素材预览 · ${animation}；选择“游戏待机”恢复画面交互。` : figureStatus) || (!picture ? '画面对应关系待确认'
                : mode === 'static' ? hasStaticAudio ? '点击静态原图的配置区域可播放语音' : '游戏档案静态原图'
                  : interactive ? '点击画面可触发已配置的互动' : '动态画面可手动预览动作')}
            </span>
          </div>
          {picture && <div className="illustration-source-details"><div className="illustration-provenance">
            <span>游戏档案 ID <strong>{picture.id}</strong></span>
            <span>骨骼 <strong>{variant ? '已匹配' : picture.l2dName ? '资源未匹配' : '未配置'}</strong></span>
            <span>语音 <strong>{bankIds.length ? `${bankIds.length} 组` : '未关联'}</strong></span>
          </div><p>{picture.img || '无静态图名'}{picture.l2dName ? ` · ${picture.l2dName}` : ''}</p>
          </div>}
          </details>
      </div>
      {error && <div className="illustration-load-error">数据读取失败：{error}</div>}
    </section>

        <aside className="gallery-tools illustration-voice-panel" aria-label="人物与台词">
          <button className="gallery-rail" aria-label="展开档案台词栏" onClick={() => layout.setToolsOpen(true)}>☷<span>人物台词</span></button>
          <div className="gallery-tool-content">
          <div className="illustration-tools-heading"><strong>人物与台词 <small>{rows.length}</small></strong><button aria-label="收起档案台词栏" onClick={() => layout.setToolsOpen(false)}>◧</button></div>
          {bankIds.length > 1 && <div className="illustration-bank-tabs">
            {bankIds.map((id) => {
              const item = voices?.pictureEntries?.[id]
              return <button key={id} className={activeBankId === id ? 'active' : ''}
                onClick={() => { stopAudio(); setSelectedVoiceKey(''); setActiveBankId(id); setSpeaker('all'); setTranscriptQuery('') }}>
                {item ? simplifyDisplay(item.titleSimplified || item.sourceFile) : id}
              </button>
            })}
          </div>}
          {bank && <>
            <div className="illustration-bank-meta">
              <strong>{simplifyDisplay(bank.titleSimplified || bank.title)}</strong>
              <small>{bank.sourceFile} · {bank.streamCount} 条音轨 · {bank.semanticStreamCount} 条已标注</small>
            </div>
            <div className="illustration-audio-controls">
              <button onClick={() => advance(-1)} disabled={!playingKey}>上一句</button>
              <button onClick={() => advance(1)} disabled={!playingKey}>下一句</button>
              <label><input type="checkbox" checked={chain} onChange={(event) => setChain(event.target.checked)} />连播</label>
            </div>
            <label className="search-box illustration-transcript-search"><span>⌕</span>
              <input aria-label="搜索档案台词" value={transcriptQuery} onChange={(event) => setTranscriptQuery(event.target.value)} placeholder="搜索台词或说话人" />
            </label>
            {bank.speakers.length > 1 && <div className="illustration-speakers">
              <button className={speaker === 'all' ? 'active' : ''} onClick={() => setSpeaker('all')}>全部</button>
              {bank.speakers.map((item) => <button key={item.roleId || item.name}
                className={speaker === (item.roleId || item.name) ? 'active' : ''}
                onClick={() => setSpeaker(item.roleId || item.name)}>
                {(item.roleId && roleNames[item.roleId]) || item.name}</button>)}
            </div>}
            <div className="illustration-lines" ref={linesRef}>
              {visibleRows.map((row) => <button key={`${row.bankId}:${row.stream.index}`}
                className={`picture-line illustration-line ${playingKey === `${row.bankId}:${row.stream.index}` ? 'active' : ''}`}
                onClick={() => play(row)}>
                <span className="illustration-line-index">{String(row.stream.index).padStart(2, '0')}</span>
                <span className="illustration-line-copy"><strong>{simplifyDisplay(lineTitle(row.stream))}</strong>
                  <span>{simplifyDisplay(row.stream.semantic?.script || row.stream.name)}</span></span>
                <span className="illustration-line-speaker">{row.speaker}</span>
              </button>)}
              {!visibleRows.length && <p className="gallery-empty">没有匹配的台词，请调整关键词或人物筛选。</p>}
            </div>
          </>}
          {!bank && <div className="illustration-no-voice">这张插画没有可靠关联的 `picture` 语音包，画面仍可独立浏览。</div>}
          <div className="gallery-voice-detail">
            <small>当前台词</small><strong>{selectedVoice ? simplifyDisplay(selectedVoice.speaker) : '暂无台词'}</strong>
            <p>{selectedVoice ? simplifyDisplay(selectedVoice.stream.semantic?.script || selectedVoice.stream.name) : '画面仍可独立查看。'}</p>
            <div><button className="gallery-action-entry" disabled={!selectedVoice} onClick={() => selectedVoice && play(selectedVoice)}>
              <span className="gallery-action-icon" aria-hidden="true">▷</span>{selectedVoice && playingKey === `${selectedVoice.bankId}:${selectedVoice.stream.index}` ? '重新播放' : '试听这句'}
            </button><button disabled={!playingKey} onClick={stopAudio}>停止</button></div>
            <label>音量<input aria-label="档案语音音量" type="range" min="0" max="1" step=".01" value={volume} onChange={event => setVolume(Number(event.target.value))}/><small>{Math.round(volume * 100)}%</small></label>
          </div>
          </div>
          <audio ref={audioRef} preload="none" onEnded={() => {
            const position = visibleRows.findIndex((row) => `${row.bankId}:${row.stream.index}` === playingKey)
            if (chain && visibleRows[position + 1]) play(visibleRows[position + 1])
            else setPlayingKey('')
          }} onError={() => setPlayingKey('')} />
        </aside>
  </div></ImmersiveContext.Provider>
}
