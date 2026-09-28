import { sitePath } from './sitePaths'

/** Static builds read pre-exported JSON instead of asking the Python cache server. */
export function installStaticGateway() {
  if (import.meta.env.VITE_STATIC_DEMO !== '1') return
  const original = window.fetch.bind(window)
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const path = typeof input === 'string' ? input : input instanceof URL ? input.pathname : input.url
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET')
    if (path === '/api/spine-audit') {
      const key = 'crosscore.pages-demo.audit'
      if (method.toUpperCase() === 'POST') {
        try {
          const body = JSON.parse(String(init?.body ?? '{}')) as { manifestRevision: string; record: { variantId: string } }
          const saved = JSON.parse(localStorage.getItem(key) ?? 'null') as { manifestRevision: string; results: Record<string, unknown> } | null
          const next = saved?.manifestRevision === body.manifestRevision ? saved
            : { manifestRevision: body.manifestRevision, results: {} as Record<string, unknown> }
          next.results[body.record.variantId] = body.record
          const payload = { ...next, generatedAt: new Date().toISOString() }
          localStorage.setItem(key, JSON.stringify(payload))
          return Promise.resolve(Response.json(payload))
        } catch (error) { return Promise.resolve(Response.json({ detail: String(error) }, { status: 400 })) }
      }
      const saved = localStorage.getItem(key)
      if (saved) return Promise.resolve(new Response(saved, { headers: { 'Content-Type': 'application/json' } }))
    }
    if (method.toUpperCase() === 'GET' && path.startsWith('/api/')) {
      const name = path.slice('/api/'.length).split('?')[0]
      return original(sitePath(`static-api/${name}.json`), init)
    }
    return original(input, init)
  }
}
