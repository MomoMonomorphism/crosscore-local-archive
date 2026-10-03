import assert from 'node:assert/strict'
import { animateDeveloperCollapse } from './src/developerCollapseMotion.ts'

class FakeAnimation {
  onfinish: (() => void) | null = null
  oncancel: (() => void) | null = null
  cancelled = 0
  frames: Keyframe[]
  options: KeyframeAnimationOptions
  constructor(frames: Keyframe[], options: KeyframeAnimationOptions) { this.frames = frames; this.options = options }
  cancel() { this.cancelled++; this.oncancel?.() }
  finish() { this.onfinish?.() }
}
function elements() {
  const animations: FakeAnimation[] = []
  const content = { hidden: false, animate(frames: Keyframe[], options: KeyframeAnimationOptions) {
    const animation = new FakeAnimation(frames, options); animations.push(animation); return animation as unknown as Animation
  } }
  let measurements = 0
  const shell = { style: { overflow: 'visible' }, getBoundingClientRect() {
    measurements++; return { height: content.hidden ? 72 : 420 }
  }, animate: content.animate }
  return { shell: shell as unknown as HTMLElement, content: content as unknown as HTMLElement, animations, measurements: () => measurements }
}
let completed = 0, released = 0
const first = elements()
const cancel = animateDeveloperCollapse(first.shell, first.content, 420, true, {
  onComplete: () => completed++, releaseMeasure: () => released++,
})
assert.equal(first.measurements(), 1, 'Only the final height is measured; the caller captured the start before toggle')
assert.deepEqual(first.animations[0].frames, [{ height: '420px' }, { height: '72px' }])
assert.equal(first.animations[0].options.duration, 190)
assert.equal(first.animations[1].options.duration, 130)
assert.equal(first.content.hidden, false, 'Content remains visually present while closing height shrinks')
assert.equal(first.shell.style.overflow, 'hidden')
const stale = first.animations[0].onfinish!
first.animations[0].finish()
assert.equal(first.content.hidden, true); assert.equal(first.shell.style.overflow, 'visible')
assert.equal(completed, 1); assert.equal(released, 1)
assert(first.animations.every(animation => animation.cancelled === 1 && !animation.onfinish && !animation.oncancel))
cancel(); stale(); assert.equal(completed, 1); assert.equal(released, 1, 'Cleanup is idempotent after finish')
assert.equal(first.measurements(), 1, 'Finishing does not measure intermediate frames')

const opening = elements(); opening.content.hidden = true
const cancelOpening = animateDeveloperCollapse(opening.shell, opening.content, 193, false, {
  fromOpacity: .42,
  onComplete: () => completed++, releaseMeasure: () => released++,
})
assert.equal(opening.content.hidden, false)
assert.deepEqual(opening.animations[0].frames, [{ height: '193px' }, { height: '420px' }], 'Reversal continues from the currently rendered height')
assert.deepEqual(opening.animations[1].frames, [{ opacity: .42 }, { opacity: 1 }], 'Reversal retains its current fade instead of flashing at zero')
const late = opening.animations[0].onfinish!
cancelOpening(); late()
assert.equal(completed, 1, 'A cancelled transition does not complete a newer owner state')
assert.equal(released, 2); assert.equal(opening.shell.style.overflow, 'visible')

const reduced = elements()
animateDeveloperCollapse(reduced.shell, reduced.content, 420, true, { reducedMotion: true, onComplete: () => completed++ })
assert.equal(reduced.animations.length, 0); assert.equal(reduced.content.hidden, true); assert.equal(completed, 2)
const unsupported = elements(); (unsupported.shell as unknown as { animate?: unknown }).animate = undefined
animateDeveloperCollapse(unsupported.shell, unsupported.content, 420, true, { onComplete: () => completed++ })
assert.equal(unsupported.animations.length, 0); assert.equal(unsupported.content.hidden, true); assert.equal(completed, 3)

// A failing animation API still restores transient clipping and measurement.
const broken = elements(); (broken.shell as unknown as { animate: () => never }).animate = () => { throw new Error('Disposed DOM') }
animateDeveloperCollapse(broken.shell, broken.content, 420, true, { onComplete: () => completed++, releaseMeasure: () => released++ })
assert.equal(broken.shell.style.overflow, 'visible'); assert.equal(broken.content.hidden, true)
assert.equal(completed, 4); assert.equal(released, 3)
console.log(JSON.stringify({ developerCollapseMotion: 'passed', verified: 'measured endpoints, retained collapse visuals, expansion, interrupted callback cleanup, reduced motion and fallback' }))
