/** Pure RoleSpineItem2 interaction state machine.
 *
 * Rendering and audio are emitted as effects. The reducer never touches Pixi,
 * React, timers, random APIs or media, so every configured branch can be
 * replayed deterministically in tests and in the browser diagnostics panel.
 */

export type InteractionContent = {
  activation?: Record<string, number>
  actions?: { stopPerc?: number; stopLimit?: number; stopTime?: number; stopCount?: number }
  asmr?: { id: number; jumpShop?: number }
  changeIdle?: [string, number, ...number[]]
  changerole?: unknown[]
  clicks?: number[]
  clickTime?: number | string
  conditions?: number[]
  drag?: Record<string, unknown>
  gestureDatas?: { speed?: number; splitPerc?: number; limitPerc?: number; stopTime?: number }
  guochange?: unknown
  inIgnore?: unknown
  isHide?: unknown
  isSpineUI?: unknown
  needClicks?: number[]
  needIdle?: unknown
  nextClick?: number
  noClick?: number[]
  noFade?: unknown
  orderActions?: string[]
  randomActions?: Array<[string, number]>
  reset7?: number[]
  trackIndex?: number
}

export type PoseSwitch = {
  targetSpine: string
  interludeSpine: string
  durationMs: number
  afterIndex: number | null
  inheritProgress: string | null
  targetRole: number
}

export type InteractionRow = {
  dragHost?: { sourcePack: string; object: string; image?: string; unsupported?: string;
    overlays?: Array<{ image: string; x: number; y: number; width: number; height: number; scaleX: number; scaleY: number; pivotX: number; pivotY: number;
      fade?: { delay: number; duration: number; from: number; to: number } | null }>;
    nested?: { asset: import('./types').ModelAsset; matrix: number[]; idle: string };
    x: number; y: number; a: number; b: number; c: number; d: number; width: number; height: number;
    pivotX: number; pivotY: number; distanceScale: number;
    targets: Array<{ name: string; animation: string; x: number; y: number }> }
  index: number
  anim: string | null
  track: number
  realIndex: number
  kind: string
  gesture: number
  rects: Array<[number, number, number, number, number]>
  pose: number
  poseSwitch: PoseSwitch | null
  initialActive: boolean
  touchObject?: boolean
  hittable: boolean
  audio: number[] | null
  audioMode: 'sequence' | 'random'
  content: InteractionContent
}

export type TrackState = { animation: string; progress: number; playing: boolean }

export type InteractionState = {
  hallEntry?: { phase: 'in' | 'out'; elapsedMs: number }
  role: number
  spine: string | null
  idle: string
  active: Record<string, boolean>
  records: Record<string, number>
  clickCounts: Record<string, number>
  tracks: Record<string, TrackState>
  cooldownUntilMs: number
  interludeUntilMs: number
  changeIdle: { atMs: number; idle: string; sourceIndex: number; keepIndexes: number[] } | null
  pendingChains: Record<string, number>
  pendingRecordInheritance: string | null
  pendingPoseLoad?: { atMs: number | null; track: number | null; effect: Extract<InteractionEffect, { type: 'load-pose' }> } | null
  spineUi: { open: boolean; openedAtMs: number }
  dragging: number | null
  restoreObjects: Record<string, boolean>
  blocked: { entering: boolean; harmony: boolean }
}

export type InteractionEvent =
  | { type: 'hall-enter'; baseIdle: string; fallbackIdle: string; clearTracks: number[]; audio: number[]; rowIndex: number; random?: number }
  | { type: 'hall-cancel' }
  | { type: 'hall-exit' }
  | { type: 'hall-frame'; deltaMs: number }
  | { type: 'ui-reset'; indexes: number[] }
  | { type: 'object-drop'; cancelled?: boolean; index: number; animation: string | null; nowMs: number; random: number;
      diagnostic?: { objectFound: boolean; moves: number; x?: number; y?: number;
        targets: Array<{ animation: string; distance: number }> } }
  | { type: 'press'; index: number; nowMs: number; random?: number; internal?: boolean; force?: boolean; skipInterludeCheck?: boolean }
  | { type: 'spine-event'; name: string; nowMs: number; animation?: string; random?: number }
  | { type: 'track-progress'; track: number; animation: string; progress: number; playing: boolean; nowMs?: number; playSerial?: number }
  | { type: 'track-complete'; track: number; nowMs: number; random?: number; playSerial?: number }
  | { type: 'track-callback'; track: number; nowMs: number; playSerial?: number }
  | { type: 'track-abandoned'; track: number; nowMs: number; playSerial?: number }
  | { type: 'pose-loaded'; nowMs: number; idle?: string }
  | { type: 'multi-reset'; index: number; nowMs?: number; playSerial?: number }
  | { type: 'tick'; nowMs: number }
  | { type: 'resume-clock'; elapsedMs: number }
  | { type: 'drag-begin'; index: number; nowMs: number; random: number; longPress?: boolean; x?: number; y?: number }
  | { type: 'drag-move'; x: number; y: number; nowMs?: number }
  | { type: 'drag-end'; cancelled?: boolean; x: number; y: number; nowMs?: number }
  | { type: 'set-blocked'; entering?: boolean; harmony?: boolean }

export type InteractionEffect =
  | { type: 'object-restore'; rowIndex: number }
  | { type: 'reset-actions'; track: number; animation: string; stopPerc: number; stopLimit: number }
  | { type: 'play'; animation: string; track: number; progress?: number; timeScale?: number; complete?: boolean; clickTime?: number; rowIndex?: number; fadeIn?: boolean; fadeOut?: boolean; mode: 'click' | 'multi' | 'actions' | 'restore' }
  | { type: 'audio'; cue: number; rowIndex: number }
  | { type: 'open-asmr'; id: number; jumpShop?: number }
  | { type: 'clear-tracks'; tracks: number[]; fade?: boolean }
  | { type: 'change-idle'; idle: string }
  | { type: 'pose-interlude'; spine: string; durationMs: number }
  | { type: 'prepare-pose'; spine: string }
  | { type: 'load-pose'; spine: string; role: number; afterIndex: number | null; inheritProgress: string | null }
  | { type: 'drag-start'; rowIndex: number; longPress?: boolean; x?: number; y?: number }
  | { type: 'drag-progress'; rowIndex: number; x: number; y: number }
  | { type: 'drag-recover'; cancelled?: boolean; rowIndex: number; x: number; y: number }
  | { type: 'open-spine-ui' }

export type Transition = { state: InteractionState; effects: InteractionEffect[]; accepted: boolean; reason?: string }

/** Called when the target skeleton actually exists, before its first render. */
export function completePoseLoad(rows: InteractionRow[], state: InteractionState,
  nowMs: number, idle: string | undefined, afterIndex: number | null): Transition {
  const loaded = reduceInteraction(rows, state, { type: 'pose-loaded', nowMs, idle })
  if (afterIndex == null) return loaded
  const follow = reduceInteraction(rows, loaded.state, {
    type: 'press', index: afterIndex, nowMs, internal: true, skipInterludeCheck: true, random: Math.random(),
  })
  return { ...follow, effects: [...loaded.effects, ...follow.effects] }
}

const key = (value: number) => String(value)
const copyState = (state: InteractionState): InteractionState => ({
  ...state,
  active: { ...state.active },
  records: { ...state.records },
  restoreObjects: { ...state.restoreObjects },
  clickCounts: { ...state.clickCounts },
  tracks: Object.fromEntries(Object.entries(state.tracks).map(([k, value]) => [k, { ...value }])),
  pendingChains: { ...state.pendingChains },
  spineUi: { ...state.spineUi },
  blocked: { ...state.blocked },
})

export function createInteractionState(rows: InteractionRow[], spine: string | null, idle = 'idle', role = 1): InteractionState {
  return {
    role,
    spine,
    idle,
    active: Object.fromEntries(rows.map((row) => [
      key(row.index),
      // CardTouchItem.Refresh L58-70: role mismatch or content.isHide hides the
      // gameObject. Zero-area rects stay active objects (they merely can never
      // win a raycast), so hittable is deliberately not part of this flag.
      row.touchObject !== false && row.pose === role && !('isHide' in row.content),
    ])),
    records: {},
    clickCounts: {},
    tracks: {},
    cooldownUntilMs: 0,
    interludeUntilMs: 0,
    changeIdle: null,
    pendingChains: {},
    pendingRecordInheritance: null,
    spineUi: { open: false, openedAtMs: 0 },
    dragging: null,
    restoreObjects: {},
    blocked: { entering: false, harmony: false },
  }
}

function byIndex(rows: InteractionRow[], index: number) {
  return rows.find((row) => row.index === index)
}

function isIdle(state: InteractionState) {
  return state.tracks['1'] == null
}

function conditionsPass(state: InteractionState, rows: InteractionRow[], row: InteractionRow, force = false) {
  const conditions = row.content.conditions
  if (conditions?.length) {
    const target = byIndex(rows, Number(conditions[0]))
    const track = target ? state.tracks[key(target.track)] : undefined
    const min = Number(conditions[1] ?? 0)
    if (conditions.length === 2) {
      if (min === 0 ? track != null : track == null || track.progress < min) return false
    } else {
      if (!track || track.progress < min || track.progress > Number(conditions[2] ?? 1)) return false
    }
  }
  if (force) return true
  for (const index of row.content.noClick ?? []) {
    const target = byIndex(rows, Number(index))
    if (target && state.tracks[key(target.track)]?.progress) return false
  }
  for (const index of row.content.needClicks ?? []) {
    if (!state.clickCounts[key(Number(index))]) return false
  }
  return true
}

function weightedAction(actions: Array<[string, number]>, random: number) {
  let total = 0
  for (let cursor = 0; cursor < actions.length; cursor += 1) {
    total += actions[cursor][1]
    if (random <= total) return { animation: actions[cursor][0], record: cursor + 1 }
  }
  return { animation: actions.at(-1)?.[0] ?? '', record: actions.length }
}

function audioEffect(row: InteractionRow, record: number | undefined, random: number): InteractionEffect | null {
  const cues = row.audio ?? []
  if (!cues.length) return null
  // RoleSpineItem2 L588-603: sequential rows read records[realIndex] with a
  // default of 1 (an actions row never writes records), only truly random
  // rows sample entropy.
  const cursor = row.audioMode === 'sequence'
    ? Math.max(0, Math.min(cues.length - 1, (record ?? 1) - 1))
    : Math.min(cues.length - 1, Math.floor(random * cues.length))
  return { type: 'audio', cue: cues[cursor], rowIndex: row.index }
}

function reducePress(rows: InteractionRow[], previous: InteractionState, event: Extract<InteractionEvent, { type: 'press' }>): Transition {
  const row = byIndex(rows, event.index)
  // PlayByIndex calls TouchItemClickCB directly after a pose loads. It does not
  // go through CardTouchItem's visibility or raycast (some targets are hidden
  // or zero-sized), and it resets the click timer before dispatching.
  if (!row || (!event.internal && (!row.hittable || !previous.active[key(row.index)] || row.gesture))
    || (!event.internal && row.pose !== previous.role)) {
    return { state: previous, effects: [], accepted: false, reason: '触点当前不可点击' }
  }
  // CardTouchItem.OnClick L94-98: content.asmr rows jump straight to the ASMR
  // view before TouchItemClickCB ever runs — no cooldown, no count, no animation.
  if (row.content.asmr) {
    return {
      state: previous,
      effects: [{ type: 'open-asmr', ...row.content.asmr }],
      accepted: true,
    }
  }
  if ((!event.internal && event.nowMs < previous.cooldownUntilMs)
    || (!event.skipInterludeCheck && event.nowMs < previous.interludeUntilMs)) {
    return { state: previous, effects: [], accepted: false,
      reason: event.nowMs < previous.interludeUntilMs ? '姿态过场尚未结束' : '点击冷却中' }
  }

  const state = copyState(previous)
  state.cooldownUntilMs = event.nowMs + 500
  if (state.blocked.entering || state.blocked.harmony || state.dragging != null
    || !conditionsPass(state, rows, row, event.force)) {
    return { state, effects: [], accepted: false, reason: '游戏前置条件尚未满足' }
  }
  if (!event.force && row.track === 1 && !isIdle(state) && !row.content.actions)
    return { state, effects: [], accepted: false, reason: '上一段主轨动作尚未结束' }
  if (!event.force && row.track !== 1 && row.content.needIdle && !isIdle(state))
    return { state, effects: [], accepted: false, reason: '需要主轨回到待机' }
  if (!event.force && row.content.guochange && (!isIdle(state)
    || (state.tracks[key(row.track)] != null && state.tracks[key(row.track)].progress < 1))) {
    // SpineTools CheckCanPlay L555-561: a finished entry does not block.
    return { state, effects: [], accepted: false, reason: '当前轨道尚未到可切换时刻' }
  }

  const effects: InteractionEffect[] = []
  const random = Math.max(0, Math.min(0.999999, event.random ?? 0))
  let animation = row.anim
  let record = state.records[key(row.realIndex)]
  let mode: Extract<InteractionEffect, { type: 'play' }>['mode'] = 'click'
  let progress: number | undefined
  let timeScale: number | undefined

  if (row.content.randomActions?.length) {
    const selected = weightedAction(row.content.randomActions, random)
    animation = selected.animation
    record = selected.record
    state.records[key(row.realIndex)] = record
  }
  if (row.content.orderActions?.length) {
    record = ((record ?? 0) % row.content.orderActions.length) + 1
    animation = row.content.orderActions[record - 1]
    state.records[key(row.realIndex)] = record
  }
  if (row.content.clicks?.length) {
    if (state.tracks[key(row.track)]?.playing) animation = null
    else {
      record = record && record < row.content.clicks.length ? record + 1 : 1
      state.records[key(row.realIndex)] = record
      progress = row.content.clicks[record - 1]
      timeScale = progress === 0 ? -1 : 1
      mode = 'multi'
    }
  } else if (row.content.actions) {
    mode = 'actions'
  }

  if (row.content.activation) {
    const inverse = Boolean(row.content.clicks && record && record % 2 === 0)
    for (const [index, raw] of Object.entries(row.content.activation)) {
      state.active[index] = (raw === 1) !== inverse
    }
  }

  const resetTracks: number[] = []
  for (const index of row.content.reset7 ?? []) {
    const target = byIndex(rows, Number(index))
    if (!target) continue
    resetTracks.push(target.track)
    delete state.tracks[key(target.track)]
    delete state.pendingChains[key(target.track)]
    delete state.records[key(target.realIndex)]
  }
  if (resetTracks.length) effects.push({ type: 'clear-tracks', tracks: [...new Set(resetTracks)], fade: true })

  if (row.content.changeIdle) {
    state.changeIdle = {
      atMs: event.nowMs + Number(row.content.changeIdle[1]),
      idle: row.content.changeIdle[0],
      sourceIndex: row.index,
      keepIndexes: row.content.changeIdle.slice(2).map(Number),
    }
  }

  // Replacing the source entry also replaces SpineTools' completion callback.
  if (animation && state.pendingPoseLoad?.track === row.track) state.pendingPoseLoad = null
  if (row.poseSwitch) {
    state.interludeUntilMs = event.nowMs + row.poseSwitch.durationMs
    effects.push({ type: 'pose-interlude', spine: row.poseSwitch.interludeSpine, durationMs: row.poseSwitch.durationMs })
    state.pendingPoseLoad = { atMs: animation ? null : event.nowMs + Math.floor(row.poseSwitch.durationMs / 2),
      track: animation ? row.track : null, effect: {
      type: 'load-pose',
      spine: row.poseSwitch.targetSpine,
      role: row.poseSwitch.targetRole,
      afterIndex: row.poseSwitch.afterIndex,
      inheritProgress: row.poseSwitch.inheritProgress,
    } }
    effects.push({ type: 'prepare-pose', spine: row.poseSwitch.targetSpine })
  }

  if (row.content.isSpineUI) effects.push({ type: 'open-spine-ui' })
  const existingActionsTrack = mode === 'actions' ? state.tracks[key(row.track)] : undefined
  if (animation && existingActionsTrack) {
    // RoleSpineItem2: an existing matching entry is reset in place. An occupied
    // different animation does nothing; neither branch plays another voice.
    if (existingActionsTrack.animation === animation) effects.push({
      type: 'reset-actions', track: row.track, animation,
      stopPerc: row.content.actions!.stopPerc!, stopLimit: row.content.actions!.stopLimit!,
    })
  } else if (animation) {
    state.tracks[key(row.track)] = { animation, progress: mode === 'multi' ? 0 : (progress ?? 0), playing: true }
    // RoleSpineItem2.TouchItemClickCB chooses these flags before calling
    // SpineTools.PlayByClick. PlayByClick1 uses both; PlayByClick2 ignores
    // fadeIn but may still queue the empty fade for a guochange object track.
    const fadeIn = mode === 'actions' || !row.content.noFade
    const fadeOut = mode === 'actions' || Boolean(row.content.noFade)
      || row.track === 1 || Boolean(row.content.guochange)
    effects.push({ type: 'play', animation, track: row.track, progress, timeScale, mode,
      ...(mode === 'actions' ? { rowIndex: row.index } : {}),
      ...(mode === 'click' || mode === 'actions' ? { fadeIn, fadeOut } : {}),
      ...(mode === 'multi' ? { complete: record === row.content.clicks?.length,
        clickTime: row.content.clickTime == null ? undefined : Number(row.content.clickTime),
        rowIndex: row.index } : {}) })
    if (row.content.nextClick) state.pendingChains[key(row.track)] = row.content.nextClick
  } else {
    // RoleSpineItem2 L303-317: sName nil -> timer reset. A changerole row
    // without sName delays its callback by duration/2, so the cooldown clears
    // then; a nextClick row fires its chain immediately.
    if (row.content.changerole) {
      const duration = Number(row.content.changerole[2] ?? 0)
      state.cooldownUntilMs = event.nowMs + Math.floor(duration / 2)
    } else if (row.content.nextClick != null) {
      state.cooldownUntilMs = 0
      const next = byIndex(rows, Number(row.content.nextClick))
      if (next) return reducePress(rows, state, {
        type: 'press', index: next.index, nowMs: event.nowMs, random, internal: true,
      })
    } else {
      state.cooldownUntilMs = 0
    }
  }

  const audio = audioEffect(row, record, random)
  // RoleSpineItem2 L319-323: audio only fires when a play call returned true;
  // a pose switch without sName never reaches PlayAudio.
  if (audio && animation && !existingActionsTrack) effects.push(audio)
  state.clickCounts[key(row.index)] = (state.clickCounts[key(row.index)] ?? 0) + 1
  return { state, effects, accepted: true }
}

function beginPoseLoad(rows: InteractionRow[], state: InteractionState) {
  const effect = state.pendingPoseLoad!.effect
  state.pendingPoseLoad = null
  state.role = effect.role
  state.spine = effect.spine
  state.records = effect.inheritProgress ? state.records : {}
  state.pendingRecordInheritance = effect.inheritProgress
  for (const row of rows) state.active[key(row.index)] = row.touchObject !== false
    && row.pose === effect.role && !('isHide' in row.content)
  return effect
}

export function reduceInteraction(rows: InteractionRow[], previous: InteractionState, event: InteractionEvent): Transition {
  if (event.type === 'hall-enter') {
    const actualIdle = previous.idle === 'idle' ? event.fallbackIdle : previous.idle
    if (previous.hallEntry || previous.role !== 1 || actualIdle !== event.baseIdle
      || previous.blocked.harmony || previous.spineUi.open || previous.dragging != null)
      return { state: previous, effects: [], accepted: false, reason: '当前姿态或互动界面不支持大厅入场' }
    const state = createInteractionState(rows, previous.spine, previous.idle, previous.role)
    state.active = { ...previous.active }
    state.tracks = Object.fromEntries(Object.entries(previous.tracks).filter(([t]) => !event.clearTracks.includes(Number(t))))
    state.hallEntry = { phase: 'in', elapsedMs: 0 }
    state.blocked = { ...previous.blocked, entering: true }
    state.tracks['1'] = { animation: 'in', progress: 0, playing: true }
    const effects: InteractionEffect[] = [
      ...Object.keys(previous.restoreObjects).map(index => ({ type: 'object-restore' as const, rowIndex: Number(index) })),
      { type: 'clear-tracks', tracks: event.clearTracks.filter(t => t > 0) },
      { type: 'play', animation: 'in', track: 1, mode: 'click', fadeIn: false, fadeOut: false },
    ]
    if (event.audio.length) effects.push({ type: 'audio', rowIndex: event.rowIndex,
      cue: event.audio[Math.min(event.audio.length - 1, Math.floor((event.random ?? 0) * event.audio.length))] })
    return { state, effects, accepted: true }
  }
  if (event.type === 'hall-cancel' && previous.hallEntry) {
    const state = copyState(previous)
    delete state.hallEntry;delete state.tracks['1'];state.blocked.entering = false
    return { state, effects: [{ type: 'clear-tracks', tracks: [1] }], accepted: true }
  }
  if (previous.hallEntry && (event.type === 'hall-exit'
    || ((event.type === 'track-complete' || event.type === 'track-abandoned') && event.track === 1))) {
    if (previous.hallEntry.phase !== 'in') return { state: previous, effects: [], accepted: false }
    return { state: { ...previous, hallEntry: { phase: 'out', elapsedMs: 0 } }, effects: [], accepted: true }
  }
  if (event.type === 'hall-frame') {
    if (previous.hallEntry?.phase !== 'out' || !(event.deltaMs > 0)) return { state: previous, effects: [], accepted: false }
    const elapsedMs = previous.hallEntry.elapsedMs + event.deltaMs
    const state = copyState(previous)
    state.hallEntry = { phase: 'out', elapsedMs }
    const effects: InteractionEffect[] = []
    if (previous.hallEntry.elapsedMs < 100 && elapsedMs >= 100) {
      delete state.tracks['1'];effects.push({ type: 'clear-tracks', tracks: [1] })
    }
    // InExit: clear at 100ms; PlayInCB at 350ms; touch buttons at +300ms.
    if (elapsedMs >= 650) { delete state.hallEntry;state.blocked.entering = false }
    return { state, effects, accepted: true }
  }
  if (previous.hallEntry && ['press', 'drag-begin', 'spine-event', 'tick'].includes(event.type))
    return { state: previous, effects: [], accepted: false, reason: '大厅入场中，可点击画面跳过' }
  if (event.type === 'resume-clock') {
    if (!(event.elapsedMs > 0) || !Number.isFinite(event.elapsedMs)) return { state: previous, effects: [], accepted: false }
    const state = copyState(previous)
    if (state.cooldownUntilMs > 0) state.cooldownUntilMs += event.elapsedMs
    if (state.interludeUntilMs > 0) state.interludeUntilMs += event.elapsedMs
    if (state.changeIdle) state.changeIdle = { ...state.changeIdle, atMs: state.changeIdle.atMs + event.elapsedMs }
    if (state.pendingPoseLoad?.atMs != null) state.pendingPoseLoad = { ...state.pendingPoseLoad, atMs: state.pendingPoseLoad.atMs + event.elapsedMs }
    // openedAtMs is also the mounted UI session key; never mutate it on pause.
    return { state, effects: [], accepted: true }
  }
  if (event.type === 'press' && previous.restoreObjects[key(event.index)]) {
    const state = copyState(previous)
    delete state.restoreObjects[key(event.index)]
    const result = reducePress(rows.map(r => r.index === event.index ? { ...r, gesture: 0 } : r), state, event)
    result.effects.unshift({ type: 'object-restore', rowIndex: event.index })
    // CardTouchItem restores slots and switches input mode before click gating.
    return { ...result, accepted: true }
  }
  if (event.type === 'object-drop') {
    const row = byIndex(rows, event.index)
    if (!row?.content.drag) return { state: previous, effects: [], accepted: false }
    const state = copyState(previous)
    state.dragging = null
    const effects: InteractionEffect[] = []
    const animation = event.cancelled ? null : event.animation
    if (event.cancelled) {
      delete state.restoreObjects[key(row.index)]
      return { state, effects: [{ type: 'object-restore', rowIndex: row.index }], accepted: true }
    }
    if (animation && row.dragHost?.targets.some(t => t.animation === animation)) {
      state.tracks[key(row.track)] = { animation, progress: 0, playing: true }
      effects.push({ type: 'object-restore', rowIndex: row.index },
        { type: 'play', animation, track: row.track, mode: 'click', fadeIn: true, fadeOut: true })
      const audio = audioEffect(row, state.records[key(row.realIndex)], event.random)
      if (audio) effects.push(audio)
    } else if ((row.content.drag.slots as string[] | undefined)?.length) state.restoreObjects[key(row.index)] = true
    return { state, effects, accepted: true }
  }
  if (event.type === 'ui-reset') {
    const state = copyState(previous)
    const tracks: number[] = []
    for (const index of event.indexes) {
      const row = byIndex(rows, index)
      if (!row) continue
      tracks.push(row.track)
      delete state.tracks[key(row.track)]
      delete state.pendingChains[key(row.track)]
      delete state.records[key(row.realIndex)]
    }
    return { state, effects: [{ type: 'clear-tracks', tracks: [...new Set(tracks)], fade: true }], accepted: true }
  }
  if (event.type === 'press') return reducePress(rows, previous, event)
  if (event.type === 'spine-event') {
    if (event.name === 'SpineUI') {
      const state = copyState(previous)
      // RoleSpineItem2.SpineEvent toggles the source UI. SpineStage admits only
      // events from the current interaction entry, excluding previews/mix-out.
      const open = !previous.spineUi.open
      state.spineUi = { open, openedAtMs: open ? event.nowMs : previous.spineUi.openedAtMs }
      return { state, effects: [], accepted: true }
    }
    const match = /^TriggerIndex_(\d+)$/.exec(event.name)
    if (!match) return { state: previous, effects: [], accepted: false, reason: '不属于动作索引事件' }
    return reducePress(rows, previous, {
      type: 'press', index: Number(match[1]), nowMs: event.nowMs,
      random: event.random, internal: true, force: true,
    })
  }
  const state = copyState(previous)
  const effects: InteractionEffect[] = []

  if (event.type === 'pose-loaded') {
    state.pendingPoseLoad = null
    if (event.idle) state.idle = event.idle
    state.restoreObjects = {}
    // SetImg replaces the Spine object. Entries on the old skeleton cannot
    // complete in the new one, so keeping them would block every role click.
    state.tracks = {}
    state.pendingChains = {}
    state.changeIdle = null
    state.dragging = null
    // RoleSpineItem2.SetImg invokes RecordsJC and then RestoreClicks after the
    // replacement skeleton has loaded. Current game mappings use disjoint
    // source/target pairs, so taking a snapshot preserves each source stage.
    if (state.pendingRecordInheritance) {
      const indexes = state.pendingRecordInheritance.split('_').map(Number)
      const sourceRecords = { ...state.records }
      for (let offset = 0; offset + 1 < indexes.length; offset += 2) {
        const source = byIndex(rows, indexes[offset])
        const target = byIndex(rows, indexes[offset + 1])
        if (!source || !target) continue
        const value = sourceRecords[key(source.realIndex)]
        if (value == null) delete state.records[key(target.realIndex)]
        else state.records[key(target.realIndex)] = value
      }
    }
    state.pendingRecordInheritance = null
    for (const row of rows) {
      const record = state.records[key(row.realIndex)]
      const clicks = row.content.clicks
      if (row.pose !== state.role || row.kind !== 'multi-click' || !row.anim
        || !clicks?.length || record == null || record < 1 || record > clicks.length) continue
      const progress = clicks[record - 1]
      state.tracks[key(row.track)] = { animation: row.anim, progress, playing: false }
      effects.push({ type: 'play', animation: row.anim, track: row.track,
        progress, timeScale: 0, mode: 'restore' })
    }
    return { state, effects, accepted: true }
  }

  if (event.type === 'track-progress') {
    state.tracks[key(event.track)] = {
      animation: event.animation,
      progress: Math.max(0, Math.min(1, event.progress)),
      playing: event.playing,
    }
    return { state, effects, accepted: true }
  }
  if (event.type === 'track-abandoned') {
    if (state.pendingPoseLoad?.track === event.track) state.pendingPoseLoad = null
    // The renderer can lose an entry when a viewer control or a missing
    // animation interrupts it. Do not run its completion chain: no game
    // completion callback occurred.
    delete state.tracks[key(event.track)]
    delete state.pendingChains[key(event.track)]
    for (const row of rows) {
      if (row.track !== event.track || !row.content.clicks?.length) continue
      delete state.records[key(row.realIndex)]
      if (row.content.activation) {
        for (const [index, raw] of Object.entries(row.content.activation)) {
          state.active[index] = raw !== 1
        }
      }
    }
    return { state, effects, accepted: true }
  }
  if (event.type === 'track-callback') {
    if (state.pendingPoseLoad?.track === event.track) {
      effects.push(beginPoseLoad(rows, state))
    }
    return { state, effects, accepted: true }
  }
  if (event.type === 'track-complete') {
    delete state.tracks[key(event.track)]
    const completedMulti = rows.find((row) => row.track === event.track
      && row.content.clicks?.length
      && state.records[key(row.realIndex)] === row.content.clicks.length)
    if (completedMulti) {
      delete state.records[key(completedMulti.realIndex)]
      if (completedMulti.content.activation) {
        for (const [index, raw] of Object.entries(completedMulti.content.activation)) {
          state.active[index] = raw !== 1
        }
      }
    }
    const next = state.pendingChains[key(event.track)]
    delete state.pendingChains[key(event.track)]
    if (next != null) {
      state.cooldownUntilMs = 0
      return reducePress(rows, state, {
        type: 'press', index: next, nowMs: event.nowMs, random: event.random, internal: true,
      })
    }
    return { state, effects, accepted: true }
  }
  if (event.type === 'multi-reset') {
    const row = byIndex(rows, event.index)
    if (!row) return { state: previous, effects, accepted: false }
    delete state.records[key(row.realIndex)]
    // SpineTools Update L127-136: the timeout reverse ends in ClearTrack,
    // so the paused segment entry is gone and the renderer must clear it too.
    delete state.tracks[key(row.track)]
    effects.push({ type: 'clear-tracks', tracks: [row.track] })
    if (row.content.activation) {
      for (const [index, raw] of Object.entries(row.content.activation)) state.active[index] = raw !== 1
    }
    return { state, effects, accepted: true }
  }
  if (event.type === 'tick') {
    if (state.pendingPoseLoad?.atMs != null && event.nowMs >= state.pendingPoseLoad.atMs) {
      effects.push(beginPoseLoad(rows, state))
    }
    if (state.changeIdle && event.nowMs >= state.changeIdle.atMs) {
      const source = byIndex(rows, state.changeIdle.sourceIndex)
      const keepTracks = new Set(state.changeIdle.keepIndexes
        .map((index) => byIndex(rows, index)?.track)
        .filter((track): track is number => track != null))
      const sourceTrack = source?.track
      const clear = Object.keys(state.tracks).map(Number).filter((track) => track !== sourceTrack && !keepTracks.has(track))
      for (const track of clear) {
        delete state.tracks[key(track)]
        delete state.pendingChains[key(track)]
      }
      // RoleSpineItem2.Update calls GetTrackIndexs -> ImmClearTracks and then
      // ClearRecords. The latter clears configured row indexes even when the
      // corresponding track is already stopped or absent. Retaining those
      // records made a later pose/idle cycle resume an old multi-click stage.
      for (const row of rows) {
        if (row.track !== sourceTrack && !keepTracks.has(row.track)) {
          delete state.records[key(row.index)]
        }
      }
      state.idle = state.changeIdle.idle
      state.changeIdle = null
      effects.push({ type: 'clear-tracks', tracks: clear }, { type: 'change-idle', idle: state.idle })
    }
    return { state, effects, accepted: true }
  }
  if (event.type === 'drag-begin') {
    const row = byIndex(rows, event.index)
    if (state.dragging != null || !row || !row.gesture || !state.active[key(row.index)] || !isIdle(state)
      || event.nowMs < state.interludeUntilMs || state.blocked.entering || state.blocked.harmony) {
      return { state: previous, effects, accepted: false }
    }
    if (row.content.drag && (!row.dragHost?.image || row.dragHost.unsupported)) {
      return { state: previous, effects, accepted: false, reason: '该物件的特殊显示宿主尚未接入' }
    }
    state.dragging = row.index
    state.clickCounts[key(row.index)] = (state.clickCounts[key(row.index)] ?? 0) + 1
    effects.push({ type: 'drag-start', rowIndex: row.index, longPress: event.longPress, x: event.x, y: event.y })
    const audio = audioEffect(row, state.records[key(row.realIndex)], event.random)
    if (audio) effects.push(audio)
    return { state, effects, accepted: true }
  }
  if (event.type === 'drag-move') {
    if (state.dragging == null) return { state: previous, effects, accepted: false }
    effects.push({ type: 'drag-progress', rowIndex: state.dragging, x: event.x, y: event.y })
    return { state, effects, accepted: true }
  }
  if (event.type === 'drag-end') {
    if (state.dragging == null) return { state: previous, effects, accepted: false }
    effects.push({ type: 'drag-recover', rowIndex: state.dragging, cancelled: event.cancelled, x: event.x, y: event.y })
    state.dragging = null
    return { state, effects, accepted: true }
  }
  if (event.type === 'set-blocked') {
    if (event.entering != null) state.blocked.entering = event.entering
    if (event.harmony != null) state.blocked.harmony = event.harmony
    return { state, effects, accepted: true }
  }
  return { state: previous, effects: [], accepted: false }
}
