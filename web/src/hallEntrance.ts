import type { InteractionEvent, InteractionState } from './interactionMachine'

export type HallEntryConfig = { index: number; audio: number[]; clearTracks: number[]; baseIdle: string | null; effect?: string | null }

export function configuredHallIdle(config: HallEntryConfig | undefined, animations: readonly string[]): string {
  if (config?.baseIdle && animations.includes(config.baseIdle)) return config.baseIdle
  return animations.find(name => /(^|_)idle(?:_?\d+)?($|_)/i.test(name))
    ?? animations.find(name => /stand|loop/i.test(name)) ?? animations[0] ?? ''
}

// Admission happens on the ready skeleton, not on a timer after selection.
export function automaticHallEntrance(config: HallEntryConfig | undefined, state: InteractionState,
  animations: readonly string[], idle: string | null, preview: boolean, enabled = true): InteractionEvent | null {
  if (!enabled || preview || !config?.baseIdle || state.role !== 1 || state.hallEntry
    || !animations.includes('in') || !animations.includes(config.baseIdle)
    || (idle ?? state.idle) !== config.baseIdle) return null
  return { type: 'hall-enter', baseIdle: config.baseIdle, fallbackIdle: idle ?? config.baseIdle,
    clearTracks: config.clearTracks, audio: config.audio, rowIndex: config.index, random: Math.random() }
}

// Deliberately simplified transition. Full white covers the track reset at
// 100 ms; hold through the original 350 ms switch, then reveal idle by 650 ms.
export function hallTransitionVisual(entry: InteractionState['hallEntry']) {
  if (entry?.phase !== 'out') return { white: 0, scale: 1 }
  const t = Math.max(0, entry.elapsedMs)
  const reveal = Math.max(0, Math.min(1, (t - 350) / 300))
  return { white: t < 80 ? t / 80 : 1 - reveal,
    scale: t < 350 ? 1 : 1 + .03 * (1 - reveal) ** 2 }
}

// Draw the mask for the same step that clears the entrance track. Limit a
// delayed frame so returning to a backgrounded tab cannot skip the mask/hold.
export function hallTransitionFrame(entry: InteractionState['hallEntry'], deltaMs: number,
  playing: boolean, speed: number) {
  const delta = entry?.phase === 'out' && playing && Number.isFinite(deltaMs) && Number.isFinite(speed)
    ? Math.max(0, Math.min(100, deltaMs * speed)) : 0
  return { deltaMs: delta, ...hallTransitionVisual(entry?.phase === 'out'
    ? { ...entry, elapsedMs: entry.elapsedMs + delta } : entry) }
}
