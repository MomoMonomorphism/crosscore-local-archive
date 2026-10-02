import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
const require = createRequire(import.meta.url)
const { chromium } = require(process.env.CROSSCORE_PLAYWRIGHT_PATH || 'playwright')

const mode = process.env.VERIFY_MODE || 'baseline'
assert.ok(['baseline', 'published'].includes(mode))
const base = process.env.LIVE_BASE_SHA || '97a83887f6e4192990bca7210d5118fb32116337'
const live = 'https://momomonomorphism.github.io/crosscore-local-archive/'
const localBefore = 'http://127.0.0.1:4174/crosscore-local-archive/'
const localAfter = 'http://127.0.0.1:4173/crosscore-local-archive/'
const output = new URL('../.scratch/live-verification/', import.meta.url)
await fs.mkdir(output, { recursive: true })
const report = { mode, base, head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), live, checks: [], errors: [] }
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const expectedRoot = path.resolve('../dist-pages')
const references = html => [...html.matchAll(/(?:src|href)="([^"]+\.(?:js|css))"/g)].map(match => match[1]).sort()
const expectedHtml = await fs.readFile(path.join(expectedRoot, 'index.html'), 'utf8')
const expectedReferences = references(expectedHtml)
assert.ok(expectedReferences.length > 2)
let liveHtml = '', lastError
// After deployment allow CDN propagation, but never accept a different build.
for (let attempt = 0; attempt < (mode === 'published' ? 24 : 3); attempt++) {
  try {
    const response = await fetch(`${live}?loadingVerification=${Date.now()}`, { headers: { 'Cache-Control': 'no-cache' }, signal: AbortSignal.timeout(30000) })
    assert.ok(response.ok, `Live index HTTP ${response.status}`)
    liveHtml = await response.text()
    assert.deepEqual(references(liveHtml), expectedReferences, 'Actual Pages asset references match the independently built expected commit')
    lastError = null
    break
  } catch (error) { lastError = error; await new Promise(resolve => setTimeout(resolve, 5000)) }
}
if (lastError) throw lastError
await fs.writeFile(new URL('live-index.html', output), liveHtml)
report.liveBundles = []
for (const reference of expectedReferences) {
  const remote = new URL(reference, live)
  const file = path.join(expectedRoot, remote.pathname.replace(/^\/crosscore-local-archive\//, ''))
  const response = await fetch(remote, { signal: AbortSignal.timeout(60000) })
  assert.ok(response.ok, `Live bundle HTTP ${response.status}: ${remote.pathname}`)
  const digest = sha256(Buffer.from(await response.arrayBuffer()))
  assert.equal(digest, sha256(await fs.readFile(file)), `Byte-identical live bundle: ${reference}`)
  report.liveBundles.push({ path: remote.pathname, sha256: digest })
}
report.checks.push(`Live HTML plus all bootstrap CSS/JS bundles match the ${mode === 'baseline' ? 'published build' : 'published build'} byte for byte`)

const browser = await chromium.launch({ channel: process.env.CROSSCORE_BROWSER_CHANNEL, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
const pages = []
const makePage = async viewport => {
  const page = await browser.newPage({ viewport, deviceScaleFactor: 1 })
  await page.addInitScript(() => localStorage.setItem('crosscore-local-viewer.autoHallEntrance', 'false'))
  page.setDefaultTimeout(90000)
  page.on('pageerror', error => report.errors.push(error.message))
  pages.push(page)
  return page
}
const shot = (page, name) => page.screenshot({ path: fileURLToPath(new URL(name, output)), fullPage: true, animations: 'disabled' })
const ready = async page => {
  await page.waitForFunction(() => Boolean(window.__interactionStage))
  await page.locator('.stage-wrap .resource-loading-notice').waitFor({ state: 'hidden' })
  await page.locator('.interaction-operation-cards article').first().waitFor()
  await page.evaluate(() => document.fonts.ready)
  const pause = page.getByRole('button', { name: '暂停', exact: true })
  if (await pause.count() && await pause.isEnabled()) await pause.click()
  await page.waitForTimeout(400)
}
const chrome = page => page.evaluate(() => {
  const selectors = [
    '.gallery-topbar', '.primary-nav button', '.gallery-mobilebar', '.library-panel', '.gallery-library-heading',
    '.search-box', '.entry-card', '.entry-monogram', '.entry-copy strong', '.entry-copy small', '.viewer-header',
    '.viewer-header h2', '.viewer-header-actions button', '.stage-wrap', '.control-deck', '.variant-strip',
    '.variant-strip button', '.gallery-compact-toolbar', '.gallery-tools', '.gallery-tabs', '.gallery-tabs button',
  ]
  const properties = ['display', 'position', 'color', 'backgroundColor', 'backgroundImage', 'fontFamily', 'fontSize',
    'fontWeight', 'lineHeight', 'letterSpacing', 'borderTopWidth', 'borderRightWidth', 'borderBottomWidth',
    'borderLeftWidth', 'borderTopColor', 'borderRadius', 'padding', 'margin', 'gap', 'gridTemplateColumns', 'opacity']
  const result = {}
  for (const selector of selectors) result[selector] = [...document.querySelectorAll(selector)].filter(el => el.getClientRects().length).map(el => {
    const rect = el.getBoundingClientRect(), css = getComputedStyle(el)
    return {
      rect: [rect.x, rect.y, rect.width, rect.height].map(value => Math.round(value * 100) / 100),
      style: Object.fromEntries(properties.map(property => [property, css[property]])),
    }
  })
  return result
})
try {
  for (const [name, viewport] of [['mobile', { width: 390, height: 844 }], ['desktop', { width: 1440, height: 900 }]]) {
    const before = await makePage(viewport), after = await makePage(viewport)
    await before.goto(localAfter, { waitUntil: 'domcontentloaded' })
    await ready(before)
    await after.goto(live, { waitUntil: 'domcontentloaded' })
    await ready(after)
    const beforeChrome = await chrome(before), afterChrome = await chrome(after)
    await fs.writeFile(new URL(`${name}-chrome.json`, output), JSON.stringify({ before: beforeChrome, after: afterChrome }, null, 2))
    assert.deepEqual(afterChrome, beforeChrome, `${name}: ready-state layout, fonts, colours, borders and controls are unchanged`)
    await shot(before, `${name}-before-ready.png`)
    await shot(after, `${name}-after-ready.png`)
    if (name === 'mobile') {
      await before.getByRole('button', { name: '选择资源', exact: true }).click()
      await after.getByRole('button', { name: '选择资源', exact: true }).click()
      await before.waitForFunction(() => [...document.querySelectorAll('.entry-monogram img')].every(img => img.complete && img.naturalWidth > 0))
      await after.waitForFunction(() => [...document.querySelectorAll('.entry-monogram img')].every(img => img.complete && img.naturalWidth > 0))
      assert.deepEqual(await chrome(after), await chrome(before), 'Ready-state mobile directory is unchanged')
      await shot(after, 'mobile-directory-ready.png')
    }
    report.checks.push(`${name}: live/local current-build ready-state geometry and computed styles match`)
    await before.close(); await after.close()
  }

  const loading = await makePage({ width: 390, height: 844 })
  let release
  const held = new Promise(resolve => { release = resolve })
  await loading.route('**/*', async route => {
    const pathname = new URL(route.request().url()).pathname
    if (pathname.includes('/assets/') && /\.(png|jpe?g|webp|atlas|skel|json)$/i.test(pathname)) await held
    await route.continue()
  })
  await loading.goto(live, { waitUntil: 'domcontentloaded' })
  const notice = loading.locator('.stage-wrap .resource-loading-notice')
  await notice.waitFor({ state: 'visible' })
  await shot(loading, 'mobile-loading.png')
  await loading.waitForTimeout(5200)
  assert.ok(await notice.isVisible(), 'Loading is not dismissed by a fixed five-second timer')
  await loading.getByRole('button', { name: '选择资源', exact: true }).click()
  await loading.locator('.entry-monogram[data-thumbnail-state=loading]').first().waitFor()
  await shot(loading, 'mobile-directory-loading.png')
  release()
  await loading.locator('.entry-monogram[data-thumbnail-state=ready]').first().waitFor()
  await loading.keyboard.press('Escape')
  await ready(loading)
  await shot(loading, 'mobile-loaded.png')
  report.checks.push(`${mode === 'published' ? 'Actual public Pages URL' : 'Candidate'}: real delayed assets show loading for stage and directory; indicators disappear on successful load`)
  assert.deepEqual(report.errors, [], 'No uncaught page exceptions')
  report.success = true
} catch (error) {
  report.failure = String(error.stack || error)
  for (let i = 0; i < pages.length; i++) if (!pages[i].isClosed()) await shot(pages[i], `failure-${i}.png`).catch(() => {})
  throw error
} finally {
  await fs.writeFile(new URL('report.json', output), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
  await browser.close()
}
