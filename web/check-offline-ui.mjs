import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { buildSync } from 'esbuild'

const localPackage = process.env.CROSSCORE_FENGARI_PATH
const output = path.resolve('../.scratch/offline-ui-check.cjs')
fs.mkdirSync(path.dirname(output), { recursive: true })
buildSync({ entryPoints: ['src/localSpineUiTransport.ts'], bundle: true, platform: 'node', format: 'cjs',
  alias: localPackage ? { fengari: path.resolve(localPackage) } : {},
  define: { 'import.meta.env.BASE_URL': JSON.stringify('/') }, outfile: output })
const require = createRequire(import.meta.url)
const { createLocalSpineUiTransport } = require(output)

let afterOpen = false
let requestCount = 0
globalThis.fetch = async url => {
  requestCount++
  if (afterOpen) throw Error(`Unexpected network request during round: ${url}`)
  const file = path.resolve('../web/public', String(url).replace(/^\//, ''))
  if (!file.startsWith(path.resolve('../web/public') + path.sep)) throw Error('Invalid test asset path')
  const body = fs.readFileSync(file)
  return new Response(body, { status: 200, headers: { 'content-type': file.endsWith('.json') ? 'application/json' :
    file.endsWith('.png') ? 'image/png' : file.endsWith('.wav') ? 'audio/wav' : 'text/plain' } })
}

const send = createLocalSpineUiTransport()
let snap = await send({ op: 'open', model: '3018005', seed: 1 })
assert.equal(snap.nodes.length, 173)
assert.ok(send.audioUrl('Machairodus_Effects_01')?.startsWith('blob:'))
afterOpen = true

let sequence = 0
const step = async (endTime, timedInputs = []) => {
  snap = await send({ op: 'step', session: snap.session, sequence: ++sequence, endTime,
    idle: true, done: [], multiTracks: {}, timedInputs })
  return snap
}
for (let i = 1; i <= 11; i++) await step(i / 10)
const nodes = new Map(snap.nodes.map(node => [node.id, node]))
assert.equal(snap.nodes.filter(node => node.click === 'OnClickHead'
  && nodes.get(node.parent)?.anim === 'target_entry').length, 4,
  'A fixed seed should choose the same first-wave size in both Lua runtimes')
const target = snap.nodes.find(node => node.click === 'OnClickHead' &&
  nodes.get(node.parent)?.anim === 'target_entry')
assert.ok(target, 'A target should enter after .5 seconds')
const early = await step(1.18, [{ node: target.id, time: 1.18, wall: 1.18 }])
assert.ok(early.commands.some(command => command.type === 'input-trace' && command.outcome === 'callback-without-commands'))
const cooldown = await step(1.26, [{ node: target.id, time: 1.26, wall: 1.26 }])
assert.ok(cooldown.commands.some(command => command.type === 'input-trace' && command.outcome === 'button-cooldown'))
for (const time of [1.36, 1.46, 1.56, 1.66]) await step(time)
const hit = await step(1.72, [{ node: target.id, time: 1.72, wall: 1.72 }])
assert.ok(hit.commands.some(command => command.type === 'play' && command.index === 10))
assert.ok(hit.commands.some(command => command.type === 'input-trace' && command.outcome === 'callback-with-commands'))

let maxStepMs = 0
let samples = 0
while (snap.time < 15.5) {
  const begin = performance.now()
  const next = Math.min(15.6, Number((snap.time + .08).toFixed(4)))
  const result = await step(next)
  if (result.time > 2) { maxStepMs = Math.max(maxStepMs, performance.now() - begin); samples++ }
  if (result.commands.some(command => command.type === 'play' && [14, 15, 16].includes(command.index))) break
}
assert.ok(snap.commands.some(command => command.type === 'play' && [14, 15, 16].includes(command.index)),
  'The original Lua round should reach a score result')
assert.equal(snap.nodes.length, 173, 'Browser scene nodes must remain available through the round')
assert.equal(requestCount, 2 + JSON.parse(fs.readFileSync('../web/public/offline/ui/3018005.assets.json')).images.length + 7)
await send({ op: 'close', session: snap.session })
const otherModels = ['7003005', '7501003', '2008006', '7040003']
const otherResults = []
for (const model of otherModels) {
  afterOpen = false
  const local = createLocalSpineUiTransport()
  let current = await local({ op: 'open', model, seed: 1 })
  assert.ok(current.nodes.length > 0, `${model}: UI scene should boot`)
  afterOpen = true
  for (let i = 1; i <= 40; i++) {
    current = await local({ op: 'step', session: current.session, sequence: i,
      endTime: i * .05, idle: true, done: [], multiTracks: {}, timedInputs: [] })
  }
  const byId = new Map(current.nodes.map(node => [node.id, node]))
  const visible = node => node.active && (!node.parent || visible(byId.get(node.parent)))
  const button = current.nodes.find(node => node.click && visible(node))
  assert.ok(button, `${model}: expected an active game input`)
  current = await local({ op: 'step', session: current.session, sequence: 41,
    endTime: 2.05, idle: true, done: [], multiTracks: {},
    timedInputs: [{ node: button.id, time: 2.05, wall: 2.05 }] })
  assert.ok(current.commands.some(command => command.type === 'input-trace'), `${model}: input should reach Lua`)
  if (model === '7501003') {
    const fillAtStart = current.nodes.find(node => node.name === 'fill')?.fill
    for (let i = 42; i <= 48; i++) {
      current = await local({ op: 'step', session: current.session, sequence: i,
        endTime: i * .05, idle: true, done: [], multiTracks: {}, timedInputs: [] })
    }
    assert.ok((current.nodes.find(node => node.name === 'fill')?.fill ?? 0) > fillAtStart + .1,
      'Vodka browser Lua click must visibly raise the fill gauge')
  }
  if (model === '7040003') {
    let hit = false
    for (let i = 42; i <= 160; i++) {
      const live = new Map(current.nodes.map(node => [node.id, node]))
      const effective = node => node.active && (!node.parent || effective(live.get(node.parent)))
      const note = current.nodes.find(node => node.name.endsWith('_spine_item') && effective(node)
        && node.y > -1350 && node.y < -1230)
      const lane = note && live.get(note.parent)?.name === 'pointL' ? 'OnClickL' : 'OnClickR'
      const key = note && current.nodes.find(node => node.click === lane && effective(node))
      const comboBefore = current.nodes.find(node => node.name === 'combo')
      current = await local({ op: 'step', session: current.session, sequence: i,
        endTime: i * .05, idle: true, done: [], multiTracks: {},
        timedInputs: key ? [{ node: key.id, time: i * .05, wall: i * .05 }] : [] })
      const comboAfter = current.nodes.find(node => node.name === 'combo')
      if (key && comboAfter?.active && (!comboBefore?.active || comboAfter.text !== comboBefore.text)) hit = true
    }
    assert.ok(current.nodes.some(node => node.name.endsWith('_spine_item')),
      'Lycoris browser Lua must spawn rhythm notes past the first click')
    assert.ok(hit, 'Lycoris browser Lua must accept a timed rhythm hit')
  }
  otherResults.push({ model, nodes: current.nodes.length, firstInput: button.click })
  await local({ op: 'close', session: current.session })
}
console.log(JSON.stringify({ scope: 'Five original miniature-game Lua scenes inside Fengari; controlled logical time, no browser pixels',
  originalRules: ['early hit rejected', 'unscaled button cooldown', 'accepted hit', 'end result'],
  requestsAfterOpen: 0, inspectedSteps: samples, maxNodeStepMs: Math.round(maxStepMs), otherModels: otherResults,
  note: 'Node runtime measurement; browser input-to-pixel latency remains for user acceptance' }))
