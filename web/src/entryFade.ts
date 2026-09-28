import type { TrackEntry } from '@esotericsoftware/spine-core'

// SpineTools.Update retains the original entry during a queued empty mix.
export function advanceEntryFade(current: TrackEntry | null, entry: TrackEntry, deltaSeconds: number) {
  let live = current
  while (live && live !== entry) live = live.mixingFrom
  if (!live) return true
  entry.alpha = Math.min(1, entry.alpha + deltaSeconds / 0.2)
  return entry.alpha >= 1
}
