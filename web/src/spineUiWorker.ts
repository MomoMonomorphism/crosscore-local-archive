import { createLocalSpineUiTransport } from './localSpineUiTransport'

const transport = createLocalSpineUiTransport({ compactSteps: true })
let queue = Promise.resolve()

self.addEventListener('message', (event: MessageEvent<{ id: number; body: Record<string, unknown> }>) => {
  const { id, body } = event.data
  const arrived = performance.now()
  queue = queue.then(async () => {
    const started = performance.now()
    try {
      const data = await transport(body)
      self.postMessage({ id, data: body.op === 'step'
        ? { ...data, workerTiming: { queueMs: started - arrived, runMs: performance.now() - started } }
        : data })
    } catch (error) {
      self.postMessage({ id, error: String(error) })
    }
  })
})
