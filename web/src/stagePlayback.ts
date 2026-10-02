// Use the current controls after asynchronous loading, as well as on updates.
export function applyStagePlayback(layers: readonly { state: { timeScale: number } }[],
  playing: boolean, speed: number) {
  for (const layer of layers) layer.state.timeScale = playing ? speed : 0
}
