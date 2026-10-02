import assert from 'node:assert/strict'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { chromium } = require(process.env.CROSSCORE_PLAYWRIGHT_PATH || 'playwright')
const base = process.env.CROSSCORE_TEST_URL || 'http://127.0.0.1:4173/crosscore-local-archive'
const entries = await (await fetch(`${base}/static-api/hall-entries.json`)).json()
const preferenceKey = 'crosscore-local-viewer.autoHallEntrance'
const skin = '3006_skin_crestedplume03_spine/3006_skin_CrestedPlume03'
const target = `${base}/?${new URLSearchParams({ entry: 'character:crestedplume', variant: skin })}`
const browser = await chromium.launch({ channel: process.env.CROSSCORE_BROWSER_CHANNEL, headless: true })
const errors = []
const newPage = async preference => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  const page = await context.newPage()
  page.on('pageerror', error => errors.push(error.message))
  await page.addInitScript(({ key, preference }) => {
    if (!localStorage.getItem('crosscore-test.prepared')) {
      if (preference !== undefined) localStorage.setItem(key, String(preference))
      localStorage.setItem('crosscore-test.prepared', 'true')
    }
    HTMLElement.prototype.requestFullscreen = () => Promise.reject(new Error('Test window immersion'))
  }, { key: preferenceKey, preference })
  // Audio fidelity is manual acceptance; avoid decoding actual game voices.
  await page.route('**/assets/voice/**', route => route.abort())
  return { context, page }
}
const stage = page => page.locator('.stage-runtime:not(.stage-runtime-hidden) .spine-stage').first()
const ready = (page, phase = 'idle') => page.waitForFunction(({ skin, phase }) => {
  const host = document.querySelector('.stage-runtime:not(.stage-runtime-hidden) .spine-stage')
  return host?.dataset.assetId === skin && host.dataset.entrancePhase === phase && Boolean(window.__interactionStage)
}, { skin, phase })
const tools = page => page.locator('.control-deck .gallery-toolbar-menu')
const openTools = async page => {
  const details = page.locator('.control-deck .gallery-toolbar-more')
  if (!await details.evaluate(node => node.open)) await details.locator('summary').click()
}
const preference = page => tools(page).getByRole('button', { name: '自动播放入场', exact: true })
const switchAway = page => page.locator('.control-deck .variant-strip').getByRole('button', { name: '突破', exact: true }).click()
const switchBack = page => page.locator('.control-deck .variant-strip').getByRole('button', { name: '皮肤 03', exact: true }).click()
const replay = page => page.locator('.gallery-shared-status').getByRole('button', { name: '重播入场', exact: true })
const skip = page => page.locator('.gallery-shared-status').getByRole('button', { name: '跳过入场', exact: true })
const stored = page => page.evaluate(key => localStorage.getItem(key), preferenceKey)

try {
  // Default on waits for config. Switching off releases that wait, and a late
  // response or switching back on cannot remount or auto-start the live skin.
  {
    const { context, page } = await newPage(undefined)
    let count = 0, release
    const gate = new Promise(resolve => { release = resolve })
    const resources = []
    page.on('request', request => { if (request.url().includes('/assets/spine/')) resources.push(request.url()) })
    await page.route('**/static-api/hall-entries.json*', async route => { count++; await gate; await route.fulfill({ json: entries }) })
    const requested = page.waitForRequest('**/static-api/hall-entries.json*')
    await page.goto(target)
    await requested
    await page.locator('.stage-wrap .boot-fallback').waitFor()
    assert.equal(await stage(page).count(), 0, 'Default on waits for entrance config')
    await page.waitForFunction(() => performance.getEntriesByType('resource').some(entry => entry.name.includes('/assets/spine/')))
    assert.ok(resources.length > 0, 'Selected resources start while entrance config is pending')
    await openTools(page)
    assert.equal(await preference(page).getAttribute('aria-pressed'), 'true')
    await preference(page).click()
    await ready(page)
    const skinResources = resources.filter(url => url.includes('/3006_skin_crestedplume03_spine/'))
    for (const extension of ['.json', '.atlas', '.png']) {
      assert.ok(skinResources.some(url => new URL(url).pathname.endsWith(extension)), `Android family requests ${extension}`)
    }
    assert.ok(skinResources.every(url => new URL(url).searchParams.get('reference') === 'android-cn-bea4b5a5'), 'Skeleton, atlas and PNG bypass the previous PC cache together')
    assert.equal(await stored(page), 'false')
    await stage(page).locator('canvas').evaluate(node => { node.__entranceTest = true })
    await preference(page).click()
    release()
    await page.waitForResponse('**/static-api/hall-entries.json*')
    assert.equal(await stage(page).locator('canvas').evaluate(node => node.__entranceTest), true, 'Enabling preserves the live canvas')
    assert.ok(!(await stage(page).getAttribute('data-entrance-history')).split(',').includes('in'), 'Late config does not start an entrance')
    assert.equal(count, 1, 'Requests are coalesced')
    await switchAway(page)
    await switchBack(page)
    await ready(page, 'in')
    await skip(page).click()
    await ready(page)
    await context.close()
  }

  // Saved off does not even request the full table. Manual replay requests it
  // lazily; a selection change cancels only the stale replay, then replay still
  // works without changing the saved preference.
  {
    const { context, page } = await newPage(false)
    let count = 0, release
    const gate = new Promise(resolve => { release = resolve })
    await page.route('**/static-api/hall-entries.json*', async route => { count++; await gate; await route.fulfill({ json: entries }) })
    await page.goto(target)
    await ready(page)
    assert.equal(count, 0, 'Saved off skips the full entrance scan')
    await switchAway(page)
    await switchBack(page)
    await ready(page)
    assert.equal(count, 0, 'Skin selection off stays independent of entrance config')
    await replay(page).click()
    await page.locator('.gallery-shared-status').getByRole('button', { name: '准备入场…', exact: true }).waitFor()
    assert.equal(count, 1)
    await switchAway(page)
    release()
    await page.waitForResponse('**/static-api/hall-entries.json*')
    await switchBack(page)
    await ready(page)
    assert.ok(!(await stage(page).getAttribute('data-entrance-history')).split(',').includes('in'), 'Stale replay does not affect the newly selected skin')
    await replay(page).click()
    await ready(page, 'in')
    assert.equal(await stored(page), 'false', 'Manual replay does not enable autoplay')
    await skip(page).click()
    await ready(page)
    await page.reload()
    await ready(page)
    assert.equal(count, 1, 'Saved off also skips the scan after reload')
    await openTools(page)
    assert.equal(await preference(page).getAttribute('aria-pressed'), 'false')
    await page.getByRole('button', { name: '进入沉浸', exact: true }).click()
    await page.getByRole('button', { name: '打开沉浸菜单', exact: true }).click()
    const menu = page.locator('.immersive-controls')
    await menu.getByRole('tab', { name: '设置', exact: true }).click()
    const immersivePreference = menu.getByRole('button', { name: '自动播放入场', exact: true })
    assert.equal(await immersivePreference.getAttribute('aria-pressed'), 'false')
    await immersivePreference.click()
    await menu.getByRole('button', { name: /^退出沉浸/ }).click()
    await openTools(page)
    assert.equal(await preference(page).getAttribute('aria-pressed'), 'true', 'Both menus share the same state')
    await page.reload()
    await ready(page, 'in')
    assert.equal(await stored(page), 'true', 'Enabling survives reload')
    await skip(page).click()
    await ready(page)
    await context.close()
  }

  // A failed lazy fetch leaves manual replay available for retry.
  {
    const { context, page } = await newPage(false)
    let count = 0
    await page.route('**/static-api/hall-entries.json*', route => ++count === 1
      ? route.fulfill({ status: 500, json: { error: 'test failure' } }) : route.fulfill({ json: entries }))
    await page.goto(target)
    await ready(page)
    await replay(page).click()
    await page.waitForFunction(() => document.querySelector('.interaction-runtime-details')?.textContent.includes('可再次点击'))
    assert.equal(await replay(page).isEnabled(), true)
    await replay(page).click()
    await ready(page, 'in')
    assert.equal(count, 2)
    await skip(page).click()
    await ready(page)
    await context.close()
  }
  assert.deepEqual(errors, [], 'No uncaught JavaScript errors')
  console.log('PASS entrance preference: default on / config-wait release / no live remount / no late autoplay / next skin / saved off skips scan / lazy manual replay / stale selection / retry / menu sync / reload persistence')
} finally { await browser.close() }
