import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { buildSync } from 'esbuild'

const output = path.resolve('../.scratch/static-gateway-check.cjs')
fs.mkdirSync(path.dirname(output), { recursive: true })
buildSync({ entryPoints: ['src/staticGateway.ts'], bundle: true, platform: 'node', format: 'cjs',
  define: { 'import.meta.env.BASE_URL': JSON.stringify('/crosscore-demo/'),
    'import.meta.env.VITE_STATIC_DEMO': JSON.stringify('1') }, outfile: output })

const calls = []
const values = new Map()
globalThis.localStorage = {
  getItem: key => values.get(key) ?? null,
  setItem: (key, value) => values.set(key, value),
}
globalThis.window = { fetch: async (url, init) => {
  calls.push({ url, init })
  return Response.json({ from: url })
} }

const require = createRequire(import.meta.url)
require(output).installStaticGateway()
const manifest = await (await window.fetch('/api/manifest')).json()
assert.equal(manifest.from, '/crosscore-demo/static-api/manifest.json')
const layout = await (await window.fetch('/api/spine-layout/folder%2Fmodel')).json()
assert.equal(layout.from, '/crosscore-demo/static-api/spine-layout/folder%2Fmodel.json')
await window.fetch('/api/spine-audit', { method: 'POST', body: JSON.stringify({ manifestRevision: 'r1',
  record: { variantId: 'v1', score: 2 } }) })
const audit = await (await window.fetch('/api/spine-audit')).json()
assert.equal(audit.results.v1.score, 2)
assert.equal(calls.length, 2, 'Audit write and read must stay in the browser')
console.log(JSON.stringify({ staticBase: '/crosscore-demo/', mappedGets: calls.length,
  localAudit: true, backendRequests: 0 }))
