import assert from 'node:assert/strict'
import { automaticHallEntrance, configuredHallIdle, hallTransitionFrame, hallTransitionVisual } from './src/hallEntrance.ts'
import { createInteractionState, reduceInteraction, type InteractionEvent, type InteractionRow } from './src/interactionMachine.ts'

const rows: InteractionRow[] = []
const start: InteractionEvent = { type: 'hall-enter', baseIdle: 'idle', fallbackIdle: 'idle', clearTracks: [1, 4], audio: [123, 456], rowIndex: 1, random: .9 }
let state = createInteractionState(rows, 'fixture', 'idle', 1)
state.records = { '4': 2 };state.clickCounts = { '4': 3 }
state.tracks = { '4': { animation: 'click4', progress: .5, playing: false }, '9': { animation: 'keep', progress: .4, playing: false } }
let result = reduceInteraction(rows, state, start)
assert.equal(result.accepted, true)
assert.deepEqual(result.state.records, {})
assert.deepEqual(result.state.clickCounts, {})
assert.equal(result.state.tracks['4'], undefined)
assert.equal(result.state.tracks['9'].animation, 'keep', 'inIgnore track survives')
assert.equal(result.effects.find(e => e.type === 'audio')?.cue, 456)
assert.equal(reduceInteraction(rows, result.state, start).accepted, false)
assert.equal(reduceInteraction(rows, result.state, { type: 'press', index: 1, nowMs: 1 }).accepted, false)
for (const event of [{ type: 'hall-exit' }, { type: 'track-complete', track: 1, nowMs: 1 }] as InteractionEvent[]) {
  let s = reduceInteraction(rows, result.state, event).state
  s = reduceInteraction(rows, s, { type: 'hall-frame', deltaMs: 0 }).state
  assert.equal(s.hallEntry?.elapsedMs, 0)
  let r = reduceInteraction(rows, s, { type: 'hall-frame', deltaMs: 100 })
  assert.ok(r.effects.some(e => e.type === 'clear-tracks'))
  assert.equal(r.state.tracks['1'], undefined)
  r = reduceInteraction(rows, r.state, { type: 'hall-frame', deltaMs: 549 })
  assert.equal(r.state.blocked.entering, true)
  r = reduceInteraction(rows, r.state, { type: 'hall-frame', deltaMs: 1 })
  assert.equal(r.state.hallEntry, undefined)
  assert.equal(r.state.blocked.entering, false)
  assert.equal(reduceInteraction(rows, r.state, start).accepted, true)
}
const cancelled = reduceInteraction(rows, result.state, { type: 'hall-cancel' })
assert.equal(cancelled.state.hallEntry, undefined)
assert.equal(cancelled.state.tracks['1'], undefined)
for (const other of [ { ...state, role: 2 }, { ...state, idle: 'idle2' }, { ...state, spineUi: { open: true, openedAtMs: 0 } } ])
  assert.equal(reduceInteraction(rows, other, start).accepted, false)
assert.equal(reduceInteraction(rows, state, { ...start, baseIdle: 'idle1', fallbackIdle: 'idle1' }).accepted, true)
console.log('Hall entry: track cleanup/inIgnore, voice, gates, complete/skip, pause, timed restore, cancel and replay OK')

const config = { index: 1, audio: [], clearTracks: [1], baseIdle: 'idle1' }
assert.equal(configuredHallIdle({ ...config, baseIdle: 'idle2' }, ['idle1', 'idle2', 'in']), 'idle2',
  'Replay gate uses the authored idle, not the first animation in the list (Machairodus 04)')
assert.equal(configuredHallIdle(undefined, ['click1', 'idle']), 'idle')
const fresh = createInteractionState(rows, 'fresh-skin', 'idle', 1)
const auto = automaticHallEntrance(config, fresh, ['in', 'idle1', 'click1'], 'idle1', false)
assert.ok(auto, 'Ready configured skin starts entrance without clicking replay')
assert.equal(automaticHallEntrance(config, fresh, ['in', 'idle1'], 'idle1', false, false), null,
  'Disabled autoplay never issues an entrance command; manual replay uses its independent gate')
assert.equal(automaticHallEntrance(config, fresh, ['in', 'idle1'], 'idle1', true), null, 'Explicit preview stays a preview')
assert.equal(automaticHallEntrance(undefined, fresh, ['in', 'idle1'], 'idle1', false), null)
assert.equal(automaticHallEntrance(config, fresh, ['idle1'], 'idle1', false), null, 'Missing in must not leave a blocked entrance')
assert.equal(automaticHallEntrance(config, { ...fresh, role: 2 }, ['in', 'idle1'], 'idle1', false), null, 'Restored secondary pose stays intact')
let automatic = reduceInteraction(rows, fresh, auto!)
assert.equal(automatic.state.idle, 'idle1', 'State reports the actual authored idle after entrance')
assert.equal(automatic.state.hallEntry?.phase, 'in')
assert.equal(automatic.state.blocked.entering, true)
automatic = reduceInteraction(rows, automatic.state, { type: 'track-complete', track: 1, nowMs: 1000 })
assert.equal(automatic.state.hallEntry?.phase, 'out')
automatic = reduceInteraction(rows, automatic.state, { type: 'hall-frame', deltaMs: 100 })
assert.equal(hallTransitionVisual(automatic.state.hallEntry).white, 1, 'Track reset is fully masked')
assert.ok(automatic.effects.some(e => e.type === 'clear-tracks' && e.tracks.includes(1)))
automatic = reduceInteraction(rows, automatic.state, { type: 'hall-frame', deltaMs: 250 })
assert.equal(hallTransitionVisual(automatic.state.hallEntry).white, 1, 'Idle reveal starts under white')
automatic = reduceInteraction(rows, automatic.state, { type: 'hall-frame', deltaMs: 300 })
assert.equal(automatic.state.hallEntry, undefined)
assert.equal(automatic.state.blocked.entering, false)
assert.deepEqual(hallTransitionVisual(automatic.state.hallEntry), { white: 0, scale: 1 })
console.log('Automatic entrance: ready/preview/missing-resource/pose gates and masked idle reveal OK')

for (const delta of [16, 66, 250, 5000]) {
  let s = reduceInteraction(rows, fresh, auto!).state
  s = reduceInteraction(rows, s, { type: 'hall-exit' }).state
  assert.equal(hallTransitionFrame(s.hallEntry, delta, false, 4).deltaMs, 0)
  while (s.hallEntry) {
    const frame = hallTransitionFrame(s.hallEntry, delta, true, 4)
    const next = reduceInteraction(rows, s, { type: 'hall-frame', deltaMs: frame.deltaMs })
    if (next.effects.some(e => e.type === 'clear-tracks')) assert.equal(frame.white, 1)
    s = next.state
  }
  assert.equal(s.blocked.entering, false)
}
assert.equal(hallTransitionFrame({ phase: 'out', elapsedMs: 0 }, Infinity, true, 1).deltaMs, 0)
console.log('Transition frames: pause, 4x playback, low FPS and delayed frames preserve the reset mask')
