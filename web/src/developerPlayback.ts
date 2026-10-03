import { useEffect, useRef, type RefObject } from 'react'
import { useDeveloperMode } from './DeveloperMode'

/** Register once per page; live refs prevent every animation tick from replacing
 * the playback handle or remounting the scene's renderer. */
export function useDeveloperPlayback(id: string, root: RefObject<HTMLElement | null>, state: {
  playing: boolean; available: boolean; setPlaying: (playing: boolean) => void
}) {
  const { registerPlayback, notifyPlaybackChanged } = useDeveloperMode()
  const latest = useRef(state)
  latest.current = state
  useEffect(() => registerPlayback({ id, surface: () => root.current,
    getState: () => ({ playing: latest.current.playing, available: latest.current.available }),
    setPlaying: value => latest.current.setPlaying(value),
  }), [id, root, registerPlayback])
  useEffect(() => { notifyPlaybackChanged() }, [state.playing, state.available, notifyPlaybackChanged])
}
