import { useCallback, useEffect, useRef, useState } from 'react'
import SpineStage, { type SpineMetadata } from './SpineStage'
import type { ModelAsset, Variant } from './types'
import { useDeveloperPlayback } from './developerPlayback'

const NO_EFFECTS: Variant['effects'] = []
const NO_STATES: string[] = []

/** Isolated material viewer: no reducer, game callbacks, or shared preview state. */
export default function AuxiliaryPreview({ asset, onClose }: { asset: ModelAsset; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [animations, setAnimations] = useState<string[]>([])
  const [animation, setAnimation] = useState<string | null>(null)
  const [playing, setPlaying] = useState(true)
  const [loop, setLoop] = useState(false)
  const [serial, setSerial] = useState(0)
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [status, setStatus] = useState('正在加载辅助素材…')
  const [error, setError] = useState('')
  useDeveloperPlayback('auxiliary-preview', dialog, { playing, available: Boolean(animation), setPlaying })
  useEffect(() => {
    const element = dialog.current
    element?.showModal()
    return () => element?.close()
  }, [])
  const metadata = useCallback((data: SpineMetadata) => {
    setAnimations(data.animations)
    setAnimation(current => current && data.animations.includes(current) ? current : data.animations[0] ?? null)
  }, [])
  return <dialog ref={dialog} className="auxiliary-preview" aria-label="辅助素材独立预览"
    onCancel={event => { event.preventDefault(); onClose() }}>
    <header><div><strong>辅助素材独立预览</strong><small>{asset.sourceName}</small></div>
      <button onClick={onClose}>关闭并返回</button></header>
    <p>单独查看原始骨骼，不叠加到人物画面。游戏中的过场时长由交互配置控制。</p>
    <div className="auxiliary-preview-canvas">
      <SpineStage asset={asset} effects={NO_EFFECTS} animation={animation} playing={playing} speed={1}
        effectsVisible={false} flipped={false} zoom={zoom} pan={pan} persistentStates={NO_STATES}
        hiddenLayerIds={NO_STATES} onZoomChange={setZoom} onPanChange={setPan}
        onMetadata={metadata} onStatus={setStatus} onError={setError}
        loopAnimation={loop} previewResetSerial={serial} probeKey="__auxiliaryPreviewStage" />
    </div>
    <footer>
      <label>动画 <select aria-label="辅助素材动画" value={animation ?? ''} onChange={event => {
        setAnimation(event.target.value); setSerial(value => value + 1); setPlaying(true)
      }}>{animations.map(name => <option key={name}>{name}</option>)}</select></label>
      <button onClick={() => { setSerial(value => value + 1); setPlaying(true) }}>重播</button>
      <button onClick={() => setPlaying(value => !value)}>{playing ? '暂停' : '继续'}</button>
      <label><input type="checkbox" checked={loop} onChange={event => {
        setLoop(event.target.checked); setSerial(value => value + 1); setPlaying(true)
      }} />循环播放</label>
      <button onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }) }}>复位视图</button>
      <span role="status">{error || status}</span>
    </footer>
  </dialog>
}
