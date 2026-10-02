// Explicit particle names only. Additive lighting, eyes, clothing and authored
// entrance mattes must remain part of the character even with particles off.
export function isParticleSlot(name: string): boolean {
  return /(?:^|_)(?:lizi|particles?|fx)(?:_|\d|$)/i.test(name)
}

type ParticleSlot<T> = { data: { name: string }; attachment: T | null }

/** Hide while the renderer builds meshes, then immediately restore.
 * AnimationState, slot timelines and shared SkeletonData never see the filter;
 * toggling on works even when idle has no particle attachment timeline. */
export function createParticleSlotFilter<T>(slots: readonly ParticleSlot<T>[]) {
  const particles = slots.filter(slot => isParticleSlot(slot.data.name))
  return (visible: boolean, render: () => void) => {
    const hidden: Array<{ slot: ParticleSlot<T>; attachment: T }> = []
    if (!visible) for (const slot of particles) {
      const attachment = slot.attachment
      // Slot.setAttachment clears mesh deforms and sequenceIndex. Render-only
      // filtering must leave both intact, especially when playback is paused.
      if (attachment) { hidden.push({ slot, attachment }); slot.attachment = null }
    }
    try { render() }
    finally { for (const { slot, attachment } of hidden) slot.attachment = attachment }
  }
}
