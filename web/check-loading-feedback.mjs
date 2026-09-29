import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { chromium } from 'playwright'

const url = process.env.LOADING_TEST_URL || 'http://127.0.0.1:4173/crosscore-local-archive/'
const output = new URL('../.scratch/loading-feedback/', import.meta.url)
await fs.mkdir(output, { recursive: true })
const checks = [], errors = [], pages = []
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
const makePage = async (viewport = { width: 390, height: 844 }) => {
  const page = await browser.newPage({ viewport, deviceScaleFactor: 1 })
  page.setDefaultTimeout(90000)
  page.on('pageerror', error => errors.push(error.message))
  pages.push(page)
  return page
}
const shot = (page, name) => page.screenshot({ path: new URL(name, output).pathname, fullPage: true, animations: 'disabled' })
const notice = page => page.locator('.stage-wrap .resource-loading-notice:visible')
const waitReady = async page => {
  await page.waitForFunction(() => Boolean(window.__interactionStage))
  await notice(page).waitFor({ state: 'hidden' })
  assert.equal(await page.locator('.stage-wrap .error-state').count(), 0)
}
const isResource = request => {
  const path = new URL(request.url()).pathname
  return path.includes('/assets/') && /\.(png|jpe?g|webp|atlas|skel|json)$/i.test(path)
}
const waitForThumbnail = (page, state) => page.locator(`.entry-card .entry-monogram[data-thumbnail-state="${state}"]`).first().waitFor({ state: 'visible' })

try {
  const page = await makePage()
  let release
  const held = new Promise(resolve => { release = resolve })
  await page.route('**/*', async route => {
    if (isResource(route.request())) await held
    await route.continue()
  })
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  await notice(page).waitFor({ state: 'visible' })
  await page.locator('.stage-wrap canvas').first().waitFor({ state: 'attached' })
  assert.match(await notice(page).innerText(), /首次打开可能需要几秒钟/)
  const before = await page.locator('.stage-wrap').boundingBox()
  await shot(page, 'mobile-stage-loading.png')
  // A created canvas and five seconds passing are NOT a completion signal.
  await page.waitForTimeout(5200)
  assert.ok(await notice(page).isVisible())
  checks.push('Delayed assets: visible loading notice persists after a canvas is created and after five seconds')

  await page.getByRole('button', { name: '选择资源', exact: true }).click()
  await waitForThumbnail(page, 'loading')
  const loadingThumb = page.locator('.entry-monogram[data-thumbnail-state="loading"]').first()
  assert.match(await loadingThumb.evaluate(e => getComputedStyle(e, '::after').content), /加载中/)
  await shot(page, 'mobile-thumbnails-loading.png')
  release()
  await waitForThumbnail(page, 'ready')
  const thumbnailPath = await page.locator('.entry-card .entry-monogram img').first().evaluate(img => new URL(img.src).pathname)
  await page.keyboard.press('Escape')
  await waitReady(page)
  const after = await page.locator('.stage-wrap').boundingBox()
  assert.ok(Math.abs(before.width - after.width) < 1 && Math.abs(before.height - after.height) < 1, 'Loading overlay does not resize canvas')
  await shot(page, 'mobile-stage-ready.png')
  checks.push('Thumbnails have real loading placeholders; successful image/Spine loads remove feedback without resizing stage')

  await page.setViewportSize({ width: 1440, height: 900 })
  await page.evaluate(() => { window.__loadingTestCanvas = document.querySelector('.stage-runtime canvas') })
  for (const tab of ['gallery-actions-tab', 'gallery-voices-tab', 'gallery-interaction-tab']) await page.locator(`#${tab}`).click()
  await page.waitForTimeout(300)
  assert.equal(await notice(page).count(), 0)
  assert.ok(await page.evaluate(() => window.__loadingTestCanvas === document.querySelector('.stage-runtime canvas')))
  await shot(page, 'desktop-ready.png')
  checks.push('Tab switching and loading feedback renders preserve the existing runtime canvas')

  // Reload with browser-cached thumbnails; no permanent loading skeleton.
  await page.unroute('**/*')
  await page.reload({ waitUntil: 'domcontentloaded' })
  await waitReady(page)
  await waitForThumbnail(page, 'ready')
  checks.push('Repeat visit/cached images reach ready state')

  const failedPage = await makePage()
  let failAtlas = true
  await failedPage.route('**/*', async route => {
    if (failAtlas && new URL(route.request().url()).pathname.endsWith('.atlas')) {
      await route.fulfill({ status: 503, contentType: 'text/plain', body: 'Intentional test failure' })
    } else await route.continue()
  })
  await failedPage.goto(url, { waitUntil: 'domcontentloaded' })
  await failedPage.locator('.stage-wrap .error-state').waitFor({ state: 'visible' })
  assert.equal(await notice(failedPage).count(), 0)
  await shot(failedPage, 'mobile-stage-error.png')
  failAtlas = false
  await failedPage.locator('.stage-wrap .error-state').getByRole('button', { name: '重新载入', exact: true }).click()
  await waitReady(failedPage)
  checks.push('Failed atlas: loading stops, existing error/retry UI appears, retry recovers')

  const thumbnailPage = await makePage({ width: 1280, height: 900 })
  let failThumbnail = true
  await thumbnailPage.route('**/*', async route => {
    if (failThumbnail && new URL(route.request().url()).pathname === thumbnailPath) {
      await route.fulfill({ status: 503, contentType: 'text/plain', body: 'Intentional thumbnail failure' })
    } else await route.continue()
  })
  await thumbnailPage.goto(url, { waitUntil: 'domcontentloaded' })
  await waitForThumbnail(thumbnailPage, 'error')
  await waitReady(thumbnailPage)
  failThumbnail = false
  const failedCard = thumbnailPage.locator('.entry-card:has(.entry-monogram[data-thumbnail-state="error"])').first()
  await failedCard.focus()
  await thumbnailPage.keyboard.press('Enter')
  await thumbnailPage.waitForFunction(path => {
    const image = [...document.querySelectorAll('.entry-monogram img')].find(img => new URL(img.src).pathname === path)
    return image?.dataset.thumbnailState === 'ready' && image.naturalWidth > 0
  }, thumbnailPath)
  checks.push('Thumbnail error is distinct from loading, does not block canvas, and keyboard selection retries it')

  const staticPage = await makePage()
  await staticPage.goto(url, { waitUntil: 'domcontentloaded' })
  await waitReady(staticPage)
  let releasePortrait
  const portraitHeld = new Promise(resolve => { releasePortrait = resolve })
  await staticPage.route('**/*', async route => {
    if (isResource(route.request())) await portraitHeld
    await route.continue()
  })
  await staticPage.locator('.variant-strip').getByRole('button', { name: '默认立绘', exact: true }).click()
  await notice(staticPage).waitFor({ state: 'visible' })
  assert.match(await notice(staticPage).innerText(), /正在加载立绘/)
  await shot(staticPage, 'mobile-static-loading.png')
  releasePortrait()
  await notice(staticPage).waitFor({ state: 'hidden' })
  assert.ok(await staticPage.locator('.stage-wrap img').evaluate(img => img.naturalWidth > 0))
  checks.push('Static portrait uses its own actual image-load lifecycle')

  assert.deepEqual(errors, [], 'No uncaught browser exceptions')
  console.log(JSON.stringify({ checks, errors }, null, 2))
} catch (error) {
  for (let i = 0; i < pages.length; i++) await shot(pages[i], `failure-${i}.png`).catch(() => {})
  throw error
} finally {
  await fs.writeFile(new URL('report.json', output), JSON.stringify({ checks, errors }, null, 2))
  await browser.close()
}
