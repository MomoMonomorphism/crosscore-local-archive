// Functional UI checks. Uses silent test audio; game audio and visual fidelity
// remain part of manual acceptance. Set CROSSCORE_PLAYWRIGHT_PATH if necessary.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import path from 'node:path'

const require = createRequire(import.meta.url)
const { chromium } = require(process.env.CROSSCORE_PLAYWRIGHT_PATH || 'playwright')
const base = process.env.CROSSCORE_TEST_URL || 'http://127.0.0.1:4173/crosscore-local-archive'

const samples = 8000 * 90
const wav = Buffer.alloc(44 + samples * 2)
wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8)
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22)
wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28); wav.writeUInt16LE(2, 32)
wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(samples * 2, 40)

const browser = await chromium.launch({ channel: process.env.CROSSCORE_BROWSER_CHANNEL, headless: true })
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  // Exercise the window immersion fallback independently of native fullscreen.
  await page.addInitScript(() => {
    HTMLElement.prototype.requestFullscreen = () => Promise.reject(new Error('Test window immersion'))
  })
  // The public demo has one 18-second album. Duplicate its metadata only in
  // this test so album switching and longer silent-audio seeks stay covered.
  const asmrFixture = await (await fetch(`${base}/static-api/asmr.json`)).json()
  const originalAlbum = asmrFixture.albums[0]
  asmrFixture.albums = [originalAlbum, { ...originalAlbum, id: -1, voice: 1007, title: 'Test second album' }]
    .map(album => ({ ...album, seconds: 90, previewSeconds: 90 }))
  await page.route('**/static-api/asmr.json', route => route.fulfill({ json: asmrFixture }))
  await page.route('**/assets/thumbnails/asmr-1007.png', route => route.fulfill({ status: 204 }))
  let audioRequests = 0
  await page.route('**/assets/asmr/*.wav', route => {
    audioRequests++
    const range = route.request().headers().range?.match(/bytes=(\d+)-(\d*)/)
    const start = range ? Number(range[1]) : 0
    const end = range?.[2] ? Math.min(Number(range[2]), wav.length - 1) : wav.length - 1
    return route.fulfill({ status: range ? 206 : 200, contentType: 'audio/wav', body: wav.subarray(start, end + 1),
      headers: { 'Accept-Ranges': 'bytes', ...(range ? { 'Content-Range': `bytes ${start}-${end}/${wav.length}` } : {}) } })
  })
  await page.goto(`${base}/?view=asmr`)
  await page.locator('.asmr-gallery .viewer-header h2').waitFor()
  const normalAlbumList = page.locator('.library-panel .entry-list')
  const savedAlbumScroll = await normalAlbumList.evaluate(node => { node.scrollTop = 80; return node.scrollTop })
  assert.equal(audioRequests, 0, 'Album selection must not preload a full track')
  const audio = () => page.locator('.asmr-transport audio')
  await audio().evaluate(node => { node.__immersiveTest = true })
  await page.getByRole('button', { name: '播放专辑', exact: true }).click()
  await page.waitForFunction(() => { const audio = document.querySelector('audio'); return audio && !audio.paused && audio.readyState >= 2 })
  await page.getByRole('button', { name: '进入沉浸', exact: true }).click()
  await page.getByRole('button', { name: '打开沉浸菜单', exact: true }).click()
  const menu = () => page.locator('.immersive-controls')
  const tab = name => menu().getByRole('tab', { name, exact: true })
  assert.equal(await audio().evaluate(node => node.__immersiveTest && !node.paused), true, 'Entering immersion retains the playing audio element')
  await menu().getByLabel('沉浸专辑播放速度').selectOption('1.5')
  assert.equal(await audio().evaluate(node => node.playbackRate), 1.5)
  const range = async (name, value) => menu().getByLabel(name, { exact: true }).evaluate((node, value) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(node, String(value))
    node.dispatchEvent(new Event('input', { bubbles: true }))
  }, value)
  await range('沉浸专辑音量', .23)
  assert.equal(await audio().evaluate(node => node.volume), .23)
  await menu().getByRole('button', { name: '暂停播放', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('.asmr-transport audio').paused)
  await menu().getByRole('button', { name: '开始播放', exact: true }).waitFor()
  await range('沉浸专辑播放进度', 20)
  await page.waitForFunction(() => Math.abs(document.querySelector('audio').currentTime - 20) < .2, undefined, { timeout: 5000 })
  await menu().getByRole('button', { name: '前进10秒', exact: true }).click()
  assert.ok(Math.abs(await audio().evaluate(node => node.currentTime) - 30) < .2)
  await menu().getByRole('button', { name: '后退10秒', exact: true }).click()
  assert.ok(Math.abs(await audio().evaluate(node => node.currentTime) - 20) < .2)
  assert.equal(await menu().getByRole('button', { name: '放大画面', exact: true }).isDisabled(), true)
  await menu().getByRole('button', { name: '调整画面', exact: true }).click()
  assert.equal(await menu().getByRole('button', { name: '放大画面', exact: true }).isEnabled(), true)
  await menu().getByRole('button', { name: '放大画面', exact: true }).click()
  await menu().getByRole('button', { name: '复位画面', exact: true }).click()
  await menu().getByRole('button', { name: '锁定画面', exact: true }).click()
  await tab('同步台词').click()
  await menu().locator('.asmr-line').first().waitFor()
  assert.equal(await page.locator('.asmr-lines:visible').count(), 1, 'Only the visible transcript follows playback')
  await menu().locator('.asmr-line').first().click()
  await page.waitForFunction(() => !document.querySelector('audio').paused)
  await tab('常用').click()
  assert.equal(await audio().evaluate(node => node.__immersiveTest), true, 'Changing menu tabs retains the same audio')
  await menu().getByRole('button', { name: /^独立试听/ }).click()
  await page.waitForFunction(() => document.querySelector('audio').src.includes('-preview.wav'))
  assert.equal(await menu().getByRole('button', { name: /^运镜/ }).isDisabled(), true, 'Preview has no camera timeline')
  await tab('同步台词').click()
  await menu().locator('.asmr-line').first().click()
  await page.waitForFunction(() => { const audio = document.querySelector('audio'); return !audio.src.includes('-preview.wav') && !audio.paused })
  await tab('专辑').click()
  assert.equal(await menu().getByLabel('搜索专辑', { exact: true }).count(), 1)
  const albums = menu().locator('.entry-card')
  assert.ok(await albums.count() > 1)
  const before = await audio().getAttribute('src')
  await albums.nth(1).click()
  assert.notEqual(await audio().getAttribute('src'), before)
  assert.equal(await audio().evaluate(node => node.paused), true, 'Choosing an album does not autoplay')
  await tab('设置').click()
  await menu().getByRole('button', { name: /^字幕穿透/ }).click()
  assert.equal(await page.locator('.gallery-floating-lyric').evaluate(node => node.classList.contains('lyric-passthrough')), true)
  await menu().getByRole('button', { name: '复位台词位置', exact: true }).click()

  // Numeric reachability checks, without screenshots or aesthetic assertions.
  for (const size of [{ width: 390, height: 844 }, { width: 844, height: 390 }, { width: 320, height: 568 }]) {
    await page.setViewportSize(size)
    for (const name of ['常用', '专辑', '同步台词', '设置']) {
      await tab(name).click()
      const bounds = await menu().evaluate(node => {
        const rect = node.getBoundingClientRect()
        const body = node.querySelector('.immersive-panel-body')
        return { left: rect.left, right: rect.right, bottom: rect.bottom, viewport: innerHeight, width: innerWidth,
          bodyHeight: body.clientHeight, overflowX: body.scrollWidth > body.clientWidth + 1 }
      })
      assert.ok(bounds.left >= 0 && bounds.right <= bounds.width + 1 && bounds.bottom <= bounds.viewport + 1, `${name} fits ${size.width}×${size.height}`)
      assert.ok(bounds.bodyHeight > 40 && !bounds.overflowX, `${name} remains usable ${size.width}×${size.height}`)
      await menu().getByRole('button', { name: /^退出沉浸/ }).scrollIntoViewIfNeeded()
    }
  }
  await page.setViewportSize({ width: 1280, height: 800 })
  await tab('设置').focus()
  await page.keyboard.press('Home')
  assert.equal(await tab('常用').getAttribute('aria-selected'), 'true', 'Keyboard navigation selects a tab')
  await page.mouse.click(20, 600)
  assert.equal(await menu().count(), 1, 'Clicking the stage keeps the menu open')
  await menu().getByRole('button', { name: '收起沉浸菜单', exact: true }).click()
  if (await menu().count()) {
    assert.equal(await menu().getAttribute('data-ui-interactive'), 'false', 'Close disables input immediately')
    assert.equal(await menu().getAttribute('aria-hidden'), 'true', 'Exiting visuals are not accessible controls')
    assert.equal(await menu().evaluate(node => node.inert), true, 'Close blocks focus during the exit animation')
  }
  await menu().waitFor({ state: 'detached' })
  assert.equal(await menu().count(), 0, 'The menu collapses only through its manual control')
  await page.getByRole('button', { name: '打开沉浸菜单', exact: true }).click()
  await menu().getByRole('button', { name: /^退出沉浸/ }).click()
  await page.locator('.asmr-gallery:not(.immersive-active)').waitFor()
  assert.equal(await normalAlbumList.evaluate(node => node.scrollTop), savedAlbumScroll, 'Normal album scroll survives immersion')
  assert.equal(await audio().evaluate(node => node.volume), .23, 'Settings persist on exit')
  assert.equal(await audio().evaluate(node => node.playbackRate), 1.5)
  await page.getByRole('button', { name: '进入沉浸', exact: true }).click()
  await page.getByRole('button', { name: '打开沉浸菜单', exact: true }).click()
  assert.equal(await menu().getByRole('button', { name: '调整画面', exact: true }).getAttribute('aria-pressed'), 'false', 'Reentry locks the viewport')
  await page.keyboard.press('Escape')
  await page.locator('.asmr-gallery:not(.immersive-active)').waitFor()

  // Shared menu regressions: retain existing gallery panels and expose the
  // illustration controls that are otherwise hidden by the immersion layout.
  await page.goto(`${base}/`)
  await page.locator('.viewer-header h2').waitFor()
  await page.getByRole('button', { name: '进入沉浸', exact: true }).click()
  await page.getByRole('button', { name: '打开沉浸菜单', exact: true }).click()
  for (const name of ['常用', '形态', '动作与指引', '台词列表', '设置']) {
    await tab(name).click()
    assert.equal(await tab(name).getAttribute('aria-selected'), 'true')
  }
  await menu().getByRole('button', { name: /^退出沉浸/ }).click()
  await page.goto(`${base}/?view=picture&illustration=archive:1`)
  await page.locator('.illustration-gallery .viewer-header h2').waitFor()
  await page.waitForFunction(() => [...document.querySelectorAll('.illustration-mode-bar>button')].some(button => !button.disabled))
  await page.getByRole('button', { name: '进入沉浸', exact: true }).click()
  await page.getByRole('button', { name: '打开沉浸菜单', exact: true }).click()
  for (const name of ['常用', '画面与动作', '人物台词']) {
    await tab(name).click()
    assert.equal(await tab(name).getAttribute('aria-selected'), 'true')
  }
  assert.equal(await menu().getByLabel('档案语音音量', { exact: true }).count(), 1)
  assert.equal(await menu().getByRole('tab', { name: '设置', exact: true }).count(), 0, 'Do not show an empty settings tab')
  await menu().getByRole('button', { name: /^退出沉浸/ }).click()
  assert.deepEqual(errors, [], 'No uncaught JavaScript errors')
  console.log('PASS immersive ASMR: audio continuity / seek / speed / volume / tracks / transcript / album selection / subtitles / view lock / responsive reachability / exit')
  console.log('PASS shared immersive menu: keyboard navigation / manual collapse / stage clicks keep menu open / gallery panels / illustration panels / no empty settings')
} finally {
  await browser.close()
}
