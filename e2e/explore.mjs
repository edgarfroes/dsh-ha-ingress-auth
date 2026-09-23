// Dev helper: open the panel as a user, run steps, log API traffic.
import { chromium } from '@playwright/test'
const [user = 'owner', out = '/tmp/explore'] = process.argv.slice(2)
const base = process.env.FAKE_HA ?? 'http://127.0.0.1:8080'
const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } })
const page = await ctx.newPage()
page.on('request', (r) => { const u = new URL(r.url()); if (u.pathname.includes('/api/') && !u.pathname.endsWith('.js')) console.log('REQ', r.method(), u.pathname.replace(/.*hassio_ingress\/[^/]+/, ''), (r.postData() ?? '').slice(0, 400)) })
page.on('websocket', (ws) => { console.log('WS', ws.url()); ws.on('framesent', (f) => console.log('WS>', String(f.payload).slice(0, 300))) })
await page.goto(`${base}/login?user=${user}`)
await page.goto(`${base}/api/hassio_ingress/e2e-ingress-token/`)
await page.waitForTimeout(4000)
const steps = JSON.parse(process.env.STEPS ?? '[]')
for (const [kind, arg, arg2] of steps) {
  try {
    if (kind === 'click') await page.getByText(arg, { exact: true }).first().click({ timeout: 5000 })
    else if (kind === 'role') await page.getByRole(arg, { name: arg2 }).first().click({ timeout: 5000 })
    else if (kind === 'fill') await page.getByPlaceholder(arg).first().fill(arg2)
    else if (kind === 'label') await page.getByLabel(arg).first().fill(arg2)
    else if (kind === 'key') await page.keyboard.press(arg)
    else if (kind === 'wait') await page.waitForTimeout(Number(arg))
    else if (kind === 'shot') await page.screenshot({ path: `${out}-${arg}.png` })
    else if (kind === 'text') console.log('TEXT', (await page.locator('body').innerText()).slice(0, 3000))
    console.log('STEP ok', kind, arg)
  } catch (e) { console.log('STEP FAIL', kind, arg, e.message.split('\n')[0]) }
}
await browser.close()
