import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { chromium } from 'playwright'

const url = process.env.UI_POLISH_URL || 'http://127.0.0.1:4173/'
const output = new URL('../.scratch/ui-polish/', import.meta.url)
await fs.mkdir(output, { recursive: true })
const errors = []
const checks = []
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 })
page.setDefaultTimeout(30000)
page.on('pageerror', error => errors.push(error.message))
const shell = page.locator('.gallery-shell.gallery-character')
const stage = page.locator('.stage-wrap')
const ready = async () => {
  await page.locator('.entry-card').first().waitFor({ state: 'attached', timeout: 90000 })
  await page.locator('.stage-wrap canvas').first().waitFor({ state: 'visible', timeout: 90000 })
}
const noHorizontalOverflow = async () => assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1), 'No page-wide horizontal overflow')
const screenshot = async name => {
  await page.screenshot({ path: new URL(name, output).pathname, fullPage: true, animations: 'disabled' })
}
const panelState = async (className, closed) => {
  await page.waitForFunction(({ className, closed }) => document.querySelector('.gallery-shell')?.classList.contains(className) === closed, { className, closed })
}
const sameStage = async before => {
  const after = await stage.boundingBox()
  assert.ok(before && after)
  for (const key of ['x', 'y', 'width', 'height']) assert.ok(Math.abs(before[key] - after[key]) < 1, `Tool content must not move/resize stage (${key})`)
}

try {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 })
  await ready()
  await page.locator('.interaction-operation-cards article').first().waitFor({ timeout: 90000 })
  const pause = page.getByRole('button', { name: '暂停', exact: true })
  if (await pause.isEnabled()) await pause.click()
  assert.ok(!(await shell.evaluate(e => e.classList.contains('library-closed') || e.classList.contains('tools-closed'))))
  await noHorizontalOverflow()
  await screenshot('desktop-1920.png')
  checks.push('Fresh desktop opens all three columns; initial Spine canvas loads')

  const before = await stage.boundingBox()
  for (const id of ['gallery-actions-tab', 'gallery-voices-tab', 'gallery-interaction-tab']) {
    await page.locator(`#${id}`).click()
    await sameStage(before)
  }
  const details = page.locator('.interaction-operation-cards article details').first()
  await details.locator('summary').click()
  await sameStage(before)
  await details.locator('summary').click()
  checks.push('Three tabs and disclosure do not resize the stage')

  await page.getByRole('button', { name: '收起工具栏', exact: true }).focus()
  await page.keyboard.press('Enter')
  await panelState('tools-closed', true)
  const rail = page.getByRole('button', { name: '展开查看工具', exact: true })
  assert.ok(await rail.evaluate(e => e === document.activeElement), 'Focus returns to visible tools rail')
  assert.ok((await stage.boundingBox()).width > before.width, 'Collapsing tools gives space to the stage')
  await screenshot('desktop-tools-collapsed.png')
  await page.reload({ waitUntil: 'domcontentloaded' })
  await ready()
  await panelState('tools-closed', true)
  await rail.click()
  await panelState('tools-closed', false)
  assert.ok(await page.locator('#gallery-interaction-tab').evaluate(e => e === document.activeElement))
  checks.push('Close/reopen, focus restoration, and persistence across reload')

  const search = page.getByRole('textbox', { name: '搜索资源', exact: true })
  await search.fill('__ui_polish_no_match__')
  await page.locator('.entry-list .gallery-empty').waitFor()
  await search.fill('')
  await page.locator('.entry-card').first().waitFor()
  assert.ok(await page.locator('.entry-card').count() > 1)
  checks.push('Search empty state and restoring directory results')

  for (const width of [1440, 1280]) {
    await page.setViewportSize({ width, height: 900 })
    await noHorizontalOverflow()
    const box = await page.getByRole('button', { name: '收起工具栏', exact: true }).boundingBox()
    assert.ok(box.width >= 60 && box.height >= 32)
    await screenshot(`desktop-${width}.png`)
  }
  checks.push('1440px and 1280px desktop: no horizontal overflow, reachable close control')

  await page.getByRole('button', { name: '收起工具栏', exact: true }).click()
  await panelState('tools-closed', true)
  await page.setViewportSize({ width: 390, height: 844 })
  await panelState('library-closed', true)
  await noHorizontalOverflow()
  await screenshot('mobile-portrait.png')
  await page.getByRole('button', { name: '选择资源', exact: true }).click()
  await page.locator('.library-panel[role=dialog]').waitFor()
  await screenshot('mobile-directory.png')
  await page.keyboard.press('Escape')
  await panelState('library-closed', true)
  checks.push('Portrait drawer opens and Escape closes it')

  await page.setViewportSize({ width: 844, height: 390 })
  await page.getByRole('button', { name: '交互', exact: true }).click()
  await page.locator('.gallery-tools[role=dialog]').waitFor()
  await screenshot('mobile-landscape-tools.png')
  await page.keyboard.press('Escape')
  await panelState('tools-closed', true)
  await page.setViewportSize({ width: 1920, height: 1080 })
  await panelState('tools-closed', true)
  await page.getByRole('button', { name: '恢复布局', exact: true }).click()
  await panelState('tools-closed', false)
  await panelState('library-closed', false)
  assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('crosscore-local-viewer.layout.v1'))), { version: 1, libraryOpen: true, toolsOpen: true })
  checks.push('Landscape drawer; mobile does not overwrite desktop preference; Restore Layout resets preference')
  assert.deepEqual(errors, [], 'No uncaught browser exceptions')
  console.log(JSON.stringify({ checks, errors }, null, 2))
} catch (error) {
  await screenshot('failure.png').catch(() => {})
  throw error
} finally {
  await fs.writeFile(new URL('report.json', output), JSON.stringify({ checks, errors }, null, 2))
  await browser.close()
}
