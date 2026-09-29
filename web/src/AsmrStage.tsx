import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import AsmrSpine from './AsmrSpine'
import type { ContentSection } from './PrimaryNav'
import GalleryTopbar from './GalleryTopbar'
import type { AsmrAlbum, AsmrManifest } from './types'
import { useGalleryLayout } from './GalleryLayout'
import { ImmersiveContext, ImmersiveTools, ImmersiveEntry } from './ImmersiveMode'
import { simplifyDisplay } from './simplifyDisplay'
import voiceFold from '../../voice_fold_map.json'
import { sitePath } from './sitePaths'
import { FloatingLyrics } from './FloatingLyrics'
import { GalleryToolbar } from './GalleryToolbar'

const fold = voiceFold as Record<string, string>
const asmrText = (text: string) => simplifyDisplay(Array.from(text, char => fold[char] || char).join(''))

const formatClock = (seconds: number) => {
  if (!Number.isFinite(seconds) || seconds < 0) return '--:--'
  const whole = Math.floor(seconds)
  const minutes = Math.floor(whole / 60)
  const rest = whole % 60
  return `${minutes}:${String(rest).padStart(2, '0')}`
}

const formatSize = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`

/**
 * The album ACBs are ~20 minutes, so the server decodes them to a single ~210 MB
 * PCM WAV.  Two consequences drive this component: the audio element must never
 * preload (that is 210 MB on selection), and seeking only works because the server
 * answers `Range` requests.
 */
export default function AsmrStage({
  navigate,
  onSelectSection,
  initialAlbumId,
  roleNames,
}: {
  navigate: (view: 'gallery' | 'asmr' | 'picture' | 'audit') => void
  onSelectSection: (section: ContentSection) => void
  initialAlbumId?: number | null
  roleNames: Record<string, string>
}) {
  const layout = useGalleryLayout(true)
  const [albumQuery, setAlbumQuery] = useState('')
  const [volume, setVolume] = useState(.65)
  const [speed, setSpeed] = useState(1)
  const [waiting, setWaiting] = useState(false)
  const [viewCommand, setViewCommand] = useState<{ serial: number; action: 'in' | 'out' | 'reset' }>({ serial: 0, action: 'reset' })
  const pendingAudioSeek = useRef<{ time: number; autoplay: boolean } | null>(null)
  const [manifest, setManifest] = useState<AsmrManifest | null>(null)
  const [selectedVoice, setSelectedVoice] = useState<number | null>(null)
  const [query, setQuery] = useState('')
  const [currentTime, setCurrentTime] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [follow, setFollow] = useState(true)
  const [error, setError] = useState('')
  const [audioError, setAudioError] = useState('')
  const [usingPreview, setUsingPreview] = useState(false)
  const [requestPlay, setRequestPlay] = useState(false)
  const [cameraOn, setCameraOn] = useState(true)
  const [showLyrics, setShowLyrics] = useState(true)
  const [lyricsReset, setLyricsReset] = useState(0)
  const [figureStatus, setFigureStatus] = useState('')
  const [figureError, setFigureError] = useState('')
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)
  const pendingLineSeek = useRef<number | null>(null)

  useEffect(() => {
    let cancelled = false
    fetch('/api/asmr')
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`))))
      .then((payload: AsmrManifest) => {
        if (cancelled) return
        setManifest(payload)
        setSelectedVoice((current) => current
          ?? payload.albums.find((item) => item.id === initialAlbumId)?.voice
          ?? payload.albums[0]?.voice
          ?? null)
      })
      .catch((reason: Error) => {
        if (!cancelled) setError(reason.message)
      })
    return () => { cancelled = true }
  }, [initialAlbumId])

  const album: AsmrAlbum | null = useMemo(
    () => manifest?.albums.find((item) => item.voice === selectedVoice) ?? null,
    [manifest, selectedVoice]
  )

  const lines = useMemo(() => {
    if (!album) return []
    const term = asmrText(query.trim()).toLocaleLowerCase()
    if (!term) return album.lines
    return album.lines.filter((line) => asmrText(line.word).toLocaleLowerCase().includes(term))
  }, [album, query])

  const activeIndex = useMemo(() => {
    if (!album || usingPreview) return -1
    let found = -1
    for (let index = 0; index < album.lines.length; index += 1) {
      if (album.lines[index].time <= currentTime + 0.15) found = index
      else break
    }
    return found
  }, [album, currentTime, usingPreview])

  const playAudio = useCallback((audio: HTMLAudioElement) => {
    setAudioError('')
    void audio.play().catch((reason: Error) => {
      if (audioRef.current !== audio || reason.name === 'AbortError') return
      setWaiting(false)
      setAudioError('音频暂未播放，请再次点击播放。' + (reason.name === 'NotAllowedError' ? '' : ` ${reason.message}`))
    })
  }, [])

  const seekTo = useCallback((time: number, autoplay = true) => {
    const audio = audioRef.current
    if (!audio || !Number.isFinite(time)) return
    time = Math.max(0, Number.isFinite(audio.duration) ? Math.min(time, audio.duration) : time)
    setCurrentTime(time)
    // Keep only the latest seek while preload=none is acquiring metadata.
    // No per-seek listeners may survive a source switch.
    if (audio.readyState === HTMLMediaElement.HAVE_NOTHING) {
      pendingAudioSeek.current = { time, autoplay }
      setWaiting(true)
      if (audio.networkState !== HTMLMediaElement.NETWORK_LOADING) audio.load()
      return
    }
    pendingAudioSeek.current = null
    audio.currentTime = time
    if (autoplay) playAudio(audio)
  }, [playAudio])

  useEffect(() => {
    const audio = audioRef.current
    if (audio) { audio.volume = volume; audio.playbackRate = speed }
  }, [volume, speed, album?.voice, usingPreview])

  const seekToLine = useCallback((time: number) => {
    if (usingPreview) {
      pendingLineSeek.current = time
      setRequestPlay(false)
      setUsingPreview(false)
      setCurrentTime(time)
      return
    }
    seekTo(time)
  }, [seekTo, usingPreview])

  useEffect(() => {
    if (usingPreview || pendingLineSeek.current === null) return
    const time = pendingLineSeek.current
    pendingLineSeek.current = null
    seekTo(time)
  }, [usingPreview, seekTo])

  const locateCurrentLine = useCallback((smooth = true) => {
    const list = listRef.current
    const active = list?.querySelector<HTMLElement>('.asmr-line.active')
    if (!list || !active || !list.clientHeight) return
    const outer = list.getBoundingClientRect(), inner = active.getBoundingClientRect()
    list.scrollTo({ top: list.scrollTop + inner.top - outer.top - (list.clientHeight - inner.height) / 2,
      behavior: smooth ? 'smooth' : 'auto' })
  }, [])

  useEffect(() => {
    if (follow && playing && layout.toolsOpen) locateCurrentLine()
  }, [activeIndex, follow, playing, layout.toolsOpen, query, locateCurrentLine])

  const togglePlay = useCallback(() => {
    const audio = audioRef.current
    if (!audio) return
    if (audio.paused) playAudio(audio)
    else audio.pause()
  }, [playAudio])

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (layout.drawer || target?.closest('input, select, textarea, button, a, summary, [contenteditable]')) return
      if (event.code === 'Space') { event.preventDefault(); togglePlay() }
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [layout.drawer, togglePlay])

  const chooseAlbum = (voice: number) => {
    if (layout.compact) layout.setLibraryOpen(false)
    if (voice === selectedVoice) return
    audioRef.current?.pause()
    pendingAudioSeek.current = null
    setWaiting(false)
    setFigureError(''); setFigureStatus('')
    pendingLineSeek.current = null
    setRequestPlay(false)
    setPlaying(false)
    setAudioError('')
    setSelectedVoice(voice)
    setQuery('')
    setCurrentTime(0)
    setUsingPreview(false)
  }

  /** Switching sheet remounts the audio element, so playback is asked for via
   *  `autoPlay` rather than a `play()` call aimed at the outgoing source. */
  const chooseTrack = (preview: boolean) => {
    pendingLineSeek.current = null
    pendingAudioSeek.current = null
    setWaiting(false)
    if (preview === usingPreview) {
      if (audioRef.current) playAudio(audioRef.current)
      return
    }
    setRequestPlay(true)
    setPlaying(false)
    setAudioError('')
    setCurrentTime(0)
    setUsingPreview(preview)
  }

  const sourceUrl = album
    ? sitePath(`assets/asmr/${album.voice}${usingPreview ? '-preview' : ''}.wav`)
    : undefined

  const roleLabel = (item: AsmrAlbum) => asmrText(item.roleId
    ? roleNames[item.roleId] || item.roleName || item.roleId : item.roleName || '未知角色')
  const term = asmrText(albumQuery.trim()).toLowerCase()
  const visibleAlbums = (manifest?.albums ?? []).filter(item => !term ||
    `${asmrText(item.title)} ${roleLabel(item)} ${item.roleName} ${asmrText(item.cvName)}`.toLowerCase().includes(term))
  const duration = album ? (usingPreview ? album.previewSeconds ?? 0 : album.seconds) : 0
  const activeLine = album && activeIndex >= 0 ? album.lines[activeIndex] : null
  const setView = (action: 'in' | 'out' | 'reset') => setViewCommand(previous => ({ serial: previous.serial + 1, action }))

  return (
    <ImmersiveContext.Provider value={layout.immersive}><div ref={layout.root} className={`app-shell gallery-shell asmr-gallery ${layout.immersive.active ? 'immersive-active' : ''} ${layout.libraryOpen ? '' : 'library-closed'} ${layout.toolsOpen ? '' : 'tools-closed'}`}>
      <ImmersiveTools mode={layout.immersive} playing={playing} onPlay={togglePlay} canAdjust={Boolean(album?.spine)} subtitles={showLyrics} onSubtitles={() => setShowLyrics(value => !value)} onResetSubtitles={() => setLyricsReset(value => value + 1)}/>
      <GalleryTopbar active="asmr" onSelect={onSelectSection}/>
      <div className="gallery-mobilebar">
        <button aria-label="选择专辑" aria-expanded={layout.libraryOpen} onClick={() => { layout.setLibraryOpen(!layout.libraryOpen); if (layout.landscape) layout.setToolsOpen(false) }}>☰ 专辑 <span>{album && asmrText(album.title)}</span></button>
        <button onClick={() => layout.showTools('voices')}>同步台词</button>
      </div>
      {layout.drawer && <button className="gallery-scrim" aria-label="关闭面板" onClick={() => { layout.setLibraryOpen(false); if (layout.landscape) layout.setToolsOpen(false) }}/>}
      <aside className="library-panel" aria-label="ASMR 专辑">
        <button className="gallery-rail" aria-label="展开专辑栏" onClick={() => layout.setLibraryOpen(true)}>☰<span>专辑</span></button>
        <div className="gallery-library-heading"><strong>ASMR 专辑 <small>{manifest?.albumCount ?? '—'}</small></strong><button aria-label="收起专辑栏" onClick={() => layout.setLibraryOpen(false)}>◧</button></div>
        <label className="search-box"><span>⌕</span><input aria-label="搜索专辑" value={albumQuery} onChange={event => setAlbumQuery(event.target.value)} placeholder="搜索专辑 / 角色 / CV"/></label>
        <div className="entry-count">{visibleAlbums.length} 张专辑 · 日语音频</div>
        <section className="entry-list asmr-album-list">
          {visibleAlbums.map(item => <button className={`entry-card ${item.voice === selectedVoice ? 'selected' : ''}`} key={item.voice} title={`${asmrText(item.title)} · ${roleLabel(item)}`} onClick={() => chooseAlbum(item.voice)}>
            <span className="entry-monogram"><img src={sitePath(`assets/thumbnails/asmr-${item.voice}.png`)} alt="" loading="lazy" onError={event => { event.currentTarget.hidden = true }}/></span>
            <span className="entry-copy"><strong>{asmrText(item.title)}</strong><small>{roleLabel(item)}</small><small>{formatClock(item.seconds)} · {item.lineCount} 句</small></span>
          </button>)}
          {!visibleAlbums.length && manifest && <p className="gallery-empty">没有匹配的专辑</p>}
          {error && <p className="asmr-audio-error">台本载入失败：{error}</p>}
        </section>
      </aside>

      <main className="viewer-panel asmr-listening-panel">
        {!album && <p className="status">{error || '正在读取 ASMR 台本…'}</p>}
        {album && <>
          <header className="viewer-header">
            <div>
              <span className="eyebrow">ASMR / LISTENING ROOM</span>
              <h2 title={asmrText(album.title)}>{asmrText(album.title)}</h2>
              {album.description && <p className="asmr-album-description" title={asmrText(album.description)}>{asmrText(album.description)}</p>}
              <p className="asmr-album-meta" title={`${roleLabel(album)} · CV ${asmrText(album.cvName)}`}>{roleLabel(album)} · CV {asmrText(album.cvName)}</p>
            </div>
            <div className="viewer-header-actions"><ImmersiveEntry onEnter={layout.immersive.enter}/></div>
          </header>
          <section className="asmr-scene" aria-label="专辑动态画面">
            {album.spine && <div className="asmr-scene-runtime">
              <AsmrSpine asset={album.spine} cameraEnabled={cameraOn && !usingPreview}
                currentTime={usingPreview ? 0 : currentTime} playing={playing && !waiting && !usingPreview}
                playbackRate={speed} viewCommand={viewCommand} onStatus={setFigureStatus} onError={setFigureError}/>
            </div>}
            {!album.spine && <div className="asmr-figure-empty"><strong>该专辑暂无动态画面</strong></div>}
            <FloatingLyrics visible={showLyrics && !usingPreview && Boolean(activeLine)} text={activeLine ? asmrText(activeLine.word) : ''} passthrough={false} resetSerial={lyricsReset}/>
            {figureError && <p className="asmr-scene-error">{figureError}</p>}
          </section>
          <div className="asmr-track-tabs variant-strip" role="group" aria-label="选择播放音轨">
            <span className="control-label">音轨</span>
            <div className="chip-row">
            <button className={usingPreview ? '' : 'active'} aria-pressed={!usingPreview} onClick={() => chooseTrack(false)}>全曲</button>
            <button className={usingPreview ? 'active' : ''} aria-pressed={usingPreview} disabled={!album.previewSeconds} onClick={() => chooseTrack(true)}>独立试听 {album.previewSeconds ? formatClock(album.previewSeconds) : '—'}</button>
            </div>
          </div>
          <section className="asmr-transport" aria-label="ASMR 播放控制">
            <div className="asmr-playbar">
            <div className="asmr-timeline"><time>{formatClock(currentTime)}</time><input aria-label="专辑播放进度" type="range" min="0" max={duration} step=".1" value={Math.min(currentTime, duration)} onChange={event => seekTo(Number(event.target.value), playing)}/><time>{formatClock(duration)}</time></div>
            <GalleryToolbar items={[
              { id: 'play', minWidth: 0, node: <button className="play-button" aria-label={playing ? '暂停专辑' : '播放专辑'} onClick={togglePlay}>{waiting ? '…' : playing ? 'Ⅱ' : '▶'}</button> },
              { id: 'speed', minWidth: 0, node: <select aria-label="专辑播放速度" value={speed} onChange={event => setSpeed(Number(event.target.value))}>{[.5,.75,1,1.25,1.5,2].map(rate => <option key={rate} value={rate}>{rate}×</option>)}</select> },
              { id: 'seek', minWidth: 720, node: <><button aria-label="后退10秒" onClick={() => seekTo(Math.max(0, currentTime - 10), playing)}>↶ 10秒</button><button aria-label="前进10秒" onClick={() => seekTo(Math.min(duration, currentTime + 10), playing)}>10秒 ↷</button></> },
              { id: 'zoom', minWidth: 520, node: <><button aria-label="缩小专辑画面" disabled={!album.spine} onClick={() => setView('out')}>−</button><button aria-label="重置视图" disabled={!album.spine} onClick={() => setView('reset')}>复位</button><button aria-label="放大专辑画面" disabled={!album.spine} onClick={() => setView('in')}>＋</button></> },
              { id: 'camera', minWidth: 400, node: <button aria-pressed={cameraOn} disabled={!album.spine || usingPreview} onClick={() => setCameraOn(value => !value)}>运镜</button> },
              { id: 'lyrics', minWidth: 0, node: <button aria-pressed={showLyrics} onClick={() => setShowLyrics(value => !value)}>台词</button> },
              { id: 'volume', minWidth: 920, node: <label className="asmr-volume-control">音量<input aria-label="专辑音量" type="range" min="0" max="1" step=".01" value={volume} onChange={event => setVolume(Number(event.target.value))}/><small>{Math.round(volume*100)}%</small></label> },
              { id: 'reset-lyrics', minWidth: 99999, node: <button disabled={!showLyrics || !activeLine} onClick={() => setLyricsReset(value => value + 1)}>台词位置复位</button> },
            ]}/>
            </div>
            {(audioError || waiting) && <p className="asmr-playback-status" role="status">{audioError || '正在加载音频…'}</p>}
            <details className="asmr-source-details"><summary>资源信息</summary><p>全曲约 {formatSize(album.seconds * (album.sampleRate ?? 48000) * (album.channels ?? 2) * 2)}；按需加载，支持进度定位。</p>{(figureError || figureStatus) && <p>{figureError || figureStatus}</p>}</details>
            <audio key={`${album.voice}-${usingPreview ? 'preview' : 'full'}`} ref={audioRef} src={sourceUrl} preload="none" autoPlay={requestPlay}
              onLoadedMetadata={event => {
                const audio = event.currentTarget
                audio.volume = volume; audio.playbackRate = speed
                const pending = pendingAudioSeek.current
                if (pending) { pendingAudioSeek.current = null; audio.currentTime = pending.time; setCurrentTime(pending.time); if (pending.autoplay) playAudio(audio) }
                setWaiting(false)
              }}
              onTimeUpdate={event => { if (!pendingAudioSeek.current) setCurrentTime(event.currentTarget.currentTime) }}
              onPlay={() => setPlaying(true)} onPlaying={() => { setPlaying(true); setWaiting(false) }}
              onWaiting={() => setWaiting(true)} onCanPlay={() => setWaiting(false)}
              onPause={() => { setPlaying(false); setWaiting(false) }} onEnded={() => { setPlaying(false); setWaiting(false) }}
              onError={() => { pendingAudioSeek.current = null; setWaiting(false); setPlaying(false); setAudioError(`${album.sourceFile} 解码或播放失败`) }}/>
          </section>
        </>}
      </main>
      <aside className="gallery-tools asmr-script-panel" aria-label="同步台词">
        <button className="gallery-rail" aria-label="展开同步台词" onClick={() => layout.setToolsOpen(true)}>◧<span>同步台词</span></button>
        <div className="gallery-tool-content">
          <div className="asmr-script-heading"><strong>同步台词 <small>{album?.lineCount ?? 0}</small></strong><button aria-label="收起同步台词" onClick={() => layout.setToolsOpen(false)}>◧</button></div>
          <label className="search-box asmr-search"><span>⌕</span><input aria-label="搜索台词" value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索台词"/></label>
          <div className="asmr-follow-toolbar"><label><input type="checkbox" checked={follow} onChange={event => setFollow(event.target.checked)}/>跟随播放</label><button disabled={usingPreview || activeIndex < 0} onClick={() => { setQuery(''); requestAnimationFrame(() => locateCurrentLine()) }}>定位当前句</button><small>{lines.length} 句</small></div>
          <div className="asmr-lines" ref={listRef}>
            {lines.map(line => <button key={line.index} className={`asmr-line ${album?.lines.indexOf(line) === activeIndex ? 'active' : ''}`} aria-current={album?.lines.indexOf(line) === activeIndex ? 'true' : undefined} onClick={() => seekToLine(line.time)}><time className="asmr-time">{formatClock(line.time)}</time><span className="asmr-word">{asmrText(line.word)}</span></button>)}
            {album && !lines.length && <p className="gallery-empty">没有匹配的台词</p>}
          </div>
          <div className="asmr-script-footer">{usingPreview ? '点击台词将切换至全曲并播放对应片段。' : '点击任意台词，从该句开始播放。'}</div>
        </div>
      </aside>
    </div></ImmersiveContext.Provider>
  )
}
