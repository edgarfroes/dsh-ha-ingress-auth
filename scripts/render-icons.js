// Render the app's icon.png (128×128) and logo.png (250×100) from assets/icon.svg.
import { chromium } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const svg = readFileSync(join(root, 'assets', 'icon.svg'), 'utf8')
const out = join(root, 'app', 'dsh_ha_ingress_auth')
const browser = await chromium.launch()
const page = await browser.newPage({ deviceScaleFactor: 1 })

await page.setViewportSize({ width: 128, height: 128 })
await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block;width:128px;height:128px}</style>${svg}`)
await page.screenshot({ path: join(out, 'icon.png'), omitBackground: true })

await page.setViewportSize({ width: 250, height: 100 })
await page.setContent(`<style>html,body{margin:0;background:transparent;font-family:system-ui,-apple-system,"Segoe UI",sans-serif}
.l{display:flex;align-items:center;gap:12px;height:100px;padding:0 6px}svg{width:76px;height:76px;flex:none}
b{display:block;font-size:22px;color:#1f3a8a;line-height:1.1}span{font-size:14px;color:#475569}</style>
<div class="l">${svg}<div><b>DeepSeek Harness</b><span>for Home Assistant</span></div></div>`)
await page.screenshot({ path: join(out, 'logo.png'), omitBackground: true })
await browser.close()
console.log('icon.png and logo.png written')
