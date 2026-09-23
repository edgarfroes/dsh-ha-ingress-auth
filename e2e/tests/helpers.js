// Shared helpers for the fake-ingress E2E suite.
import { expect } from '@playwright/test'
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { execSync } from 'node:child_process'

export const INGRESS = `/api/hassio_ingress/${process.env.INGRESS_TOKEN ?? 'e2e-ingress-token'}/`
export const DATA_DIR = process.env.E2E_DATA_DIR
export const STUB_LLM_URL = process.env.STUB_LLM_URL ?? 'http://127.0.0.1:8081/v1'

export const USERS = {
  owner: 'a0000000000000000000000000000001',
  admin2: 'a0000000000000000000000000000002',
  alice: 'b0000000000000000000000000000001',
  bob: 'b0000000000000000000000000000002',
  reader: 'c0000000000000000000000000000001',
}

/** Open a fresh browser context signed in as one fake HA user, on the panel. */
export async function openAs(browser, username) {
  const context = await browser.newContext()
  const page = await context.newPage()
  await page.goto(`/login?user=${username}`)
  await page.goto(INGRESS)
  return { context, page }
}

/** Dismiss the first-run dialogs if they are shown. */
export async function dismissFirstRun(page) {
  await expect(page.getByText('New Session').first()).toBeVisible({ timeout: 60_000 })
  const cont = page.getByRole('button', { name: 'Continue', exact: true })
  const later = page.getByRole('button', { name: 'Configure later' })
  // The dialogs can appear a moment after the shell (settings load, or a
  // reload after the gateway syncs shared settings). Settle for 3 quiet seconds.
  let quiet = 0
  const deadline = Date.now() + 30_000
  while (quiet < 6 && Date.now() < deadline) {
    if (await cont.isVisible().catch(() => false)) { await cont.click().catch(() => {}); quiet = 0 }
    else if (await later.isVisible().catch(() => false)) { await later.click().catch(() => {}); quiet = 0 }
    else quiet++
    await page.waitForTimeout(500)
  }
}

export async function openSettings(page) {
  await page.getByText('Settings', { exact: true }).last().click()
  return page.getByRole('dialog')
}

/** A dsh unary call from inside the page, as the page itself would make it. */
export async function rpc(page, method, args = {}) {
  return page.evaluate(async ({ method, args }) => {
    const res = await fetch(`api/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method, payload: { args } }),
    })
    let body
    try { body = await res.json() } catch { body = undefined }
    return { status: res.status, body }
  }, { method, args })
}

/** Read a file under the app's /data (a local directory, or inside the app
 * container through E2E_APP_EXEC). Undefined when it does not exist. */
export function readData(rel) {
  if (process.env.E2E_APP_EXEC) {
    try { return execSync(`${process.env.E2E_APP_EXEC} cat '/data/${rel}'`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }) } catch { return undefined }
  }
  if (!DATA_DIR) return undefined
  const p = join(DATA_DIR, rel)
  return existsSync(p) ? readFileSync(p, 'utf8') : undefined
}

/** List a directory under the app's /data. */
export function listData(rel) {
  if (process.env.E2E_APP_EXEC) {
    try { return execSync(`${process.env.E2E_APP_EXEC} ls -1 '/data/${rel}'`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\n').filter(Boolean) } catch { return [] }
  }
  if (!DATA_DIR) return []
  const p = join(DATA_DIR, rel)
  return existsSync(p) ? readdirSync(p) : []
}

export async function setUsers(request, users) {
  const res = await request.post('/__test/users', { data: users })
  expect(res.ok()).toBeTruthy()
}

export async function getUsers(request) {
  return (await request.get('/__test/users')).json()
}

export function restartApp() {
  const cmd = process.env.E2E_RESTART_CMD
  if (!cmd) throw new Error('E2E_RESTART_CMD is not set')
  execSync(cmd, { stdio: 'inherit' })
}

/** Poll until the panel answers again after a restart. */
export async function waitForPanel(request, username = 'owner') {
  const deadline = Date.now() + 90_000
  for (;;) {
    try {
      const res = await request.get(INGRESS, { headers: { cookie: `fake_ha_user=${username}` } })
      if (res.ok()) return
    } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error('panel did not come back')
    await new Promise((r) => setTimeout(r, 1000))
  }
}

/** Pick the stub model in the composer's model selector. */
export async function selectStubModel(page) {
  await page.getByRole('button', { name: /^Select model/ }).click()
  await page.getByRole('menuitem', { name: /^Model / }).click()
  await page.getByRole('menuitem', { name: /Stub Model/ }).or(page.getByRole('menuitemradio', { name: /Stub Model/ })).or(page.getByRole('option', { name: /Stub Model/ })).first().click()
  await expect(page.getByRole('button', { name: /^Select model, current Stub Model/ })).toBeVisible()
}

/** Type a message in the composer and send it. */
export async function sendMessage(page, text) {
  const box = page.getByRole('textbox', { name: /^Describe what you want to build/ })
  await box.fill(text)
  await page.getByRole('button', { name: 'Send message' }).click()
}

/** The gateway's log so far (a file locally, `docker compose logs` in the container setup). */
export function gatewayLog() {
  if (process.env.E2E_GATEWAY_LOG_CMD) return execSync(process.env.E2E_GATEWAY_LOG_CMD, { encoding: 'utf8', maxBuffer: 64 << 20 })
  if (process.env.E2E_GATEWAY_LOG) return readFileSync(process.env.E2E_GATEWAY_LOG, 'utf8')
  return ''
}
