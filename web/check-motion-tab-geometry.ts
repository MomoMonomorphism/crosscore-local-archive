import assert from 'node:assert/strict'
import { motionTabBox } from './src/motionTabGeometry.ts'

// Navigation preserves its text-width underline on desktop and compact mobile padding.
assert.deepEqual(motionTabBox({ left: 92, top: 0, width: 120, height: 58, paddingLeft: 20, paddingRight: 20 }, 'navigation'),
  { x: 112, y: 56, width: 80, height: 2 })
assert.deepEqual(motionTabBox({ left: 68, top: 0, width: 70, height: 50, paddingLeft: 6, paddingRight: 6 }, 'navigation'),
  { x: 74, y: 48, width: 58, height: 2 })
// Right-column tabs center their shorter underline; wrapped chips use the selected row's top.
assert.deepEqual(motionTabBox({ left: 8, top: 11, width: 100, height: 34 }, 'tabs'), { x: 33, y: 43, width: 50, height: 2 })
assert.deepEqual(motionTabBox({ left: 0, top: 40, width: 81, height: 32 }, 'chips'), { x: 0, y: 70, width: 81, height: 2 })
// Hidden strips do not generate a stale line; narrow/invalid padding cannot produce negative widths.
assert.equal(motionTabBox({ left: 0, top: 0, width: 0, height: 32 }, 'chips'), null)
assert.equal(motionTabBox({ left: Number.NaN, top: 0, width: 80, height: 32 }, 'tabs'), null)
assert.deepEqual(motionTabBox({ left: 0, top: 0, width: 20, height: 1, paddingLeft: 50, paddingRight: 50 }, 'navigation'),
  { x: 9, y: 0, width: 2, height: 1 })
assert.deepEqual(motionTabBox({ left: 1, top: 2, width: 80, height: 32, paddingLeft: -2, paddingRight: Number.NaN }, 'navigation'),
  { x: 1, y: 32, width: 80, height: 2 })
console.log('Motion tab geometry checks passed.')
