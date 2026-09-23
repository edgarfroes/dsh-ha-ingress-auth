// Access control between HA admins and HA users. Runs after 01-first-setup,
// which leaves a "stub" provider configured by the owner.
import { test, expect } from '@playwright/test'
import { openAs, dismissFirstRun, openSettings, rpc, readData, selectStubModel, sendMessage, INGRESS, USERS } from './helpers.js'

test.describe.configure({ mode: 'serial' })

test('non-admin sees Settings → General only, no Plugins, no Permission', async ({ browser }) => {
  const { context, page } = await openAs(browser, 'alice')
  await dismissFirstRun(page)
  await expect(page.getByRole('dialog').filter({ hasText: 'Add an API key' })).toHaveCount(0)
  await expect(page.getByText('Plugins', { exact: true })).toHaveCount(0)
  const settings = await openSettings(page)
  await expect(settings.getByText('General', { exact: true })).toBeVisible()
  for (const name of ['Models', 'Built-in plugins']) await expect(settings.getByText(name, { exact: true })).toHaveCount(0)
  await expect(settings.getByText('Agent presets', { exact: true })).toBeHidden()
  await expect(settings.getByText('Permission', { exact: true })).toHaveCount(0)
  for (const name of ['Language', 'Appearance', 'Font size', 'Send behavior while busy']) {
    await expect(settings.getByText(name, { exact: true })).toBeVisible()
  }
  await context.close()
})

test('the admin-configured model reaches non-admins', async ({ browser }) => {
  const { context, page } = await openAs(browser, 'alice')
  await dismissFirstRun(page)
  await selectStubModel(page)
  await sendMessage(page, 'hello from alice')
  await expect(page.getByText('stub reply: hello from alice')).toBeVisible()
  await context.close()
})

test('non-admin cannot change shared configuration or keys, even by calling the API', async ({ browser }) => {
  const before = readData('shared/admin-rows.yml')
  const { context, page } = await openAs(browser, 'alice')
  await dismissFirstRun(page)
  const setKey = await rpc(page, 'credentials/set', { ref: 'STUB_API_KEY', value: 'stolen' })
  expect(setKey.status).toBe(403)
  const mutate = await rpc(page, 'settings/mutate', { ns: 'llm-pi-ai', ops: [{ op: 'set', path: ['providers'], value: {} }], expectedRevision: 0 })
  expect(mutate.status).toBe(403)
  const invoke = await rpc(page, 'dynamicCordisRunner/invoke', {})
  expect(invoke.status).toBe(403)
  const file = await page.evaluate(async () => (await fetch('api/file?path=/etc/passwd')).status)
  expect(file).toBe(403)
  // A forged identity header is replaced by ingress: alice stays alice.
  const forged = await page.evaluate(async (owner) => (await fetch('api/settings/mutate', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-remote-user-id': owner },
    body: JSON.stringify({ type: 'client-request', rpcId: 'x', method: 'settings/mutate', payload: { args: { ns: 'llm-pi-ai', ops: [] } } }),
  })).status, USERS.owner)
  expect(forged).toBe(403)
  expect(readData('shared/admin-rows.yml')).toBe(before)
  await context.close()
})

test('shell and file tools are refused for non-admins and allowed for admins', async ({ browser }) => {
  const a = await openAs(browser, 'alice')
  await dismissFirstRun(a.page)
  await selectStubModel(a.page)
  await sendMessage(a.page, 'TOOL:bash {"command":"id","description":"who am i"}')
  await expect(a.page.getByText(/tool result: .*administrators only/).first()).toBeVisible()
  await a.context.close()

  const o = await openAs(browser, 'owner')
  await dismissFirstRun(o.page)
  await selectStubModel(o.page)
  await sendMessage(o.page, 'TOOL:bash {"command":"echo tokens=$(env | grep -c SUPERVISOR_TOKEN)","description":"check env"}')
  await expect(o.page.getByText(/tool result: .*tokens=0/).first()).toBeVisible({ timeout: 60_000 })
  await o.context.close()
})

test("an admin's shell cannot read another user's chats on disk", async ({ browser }) => {
  test.skip(!process.env.E2E_APP_EXEC, 'uid isolation needs the container run')
  const o = await openAs(browser, 'owner')
  await dismissFirstRun(o.page)
  await selectStubModel(o.page)
  await sendMessage(o.page, `TOOL:bash {"command":"ls /data/users/${USERS.alice}/home 2>&1 | head -1; cat /data/shared/admin-rows.yml 2>&1 | head -1","description":"probe"}`)
  await expect(o.page.getByText(/tool result: .*Permission denied/).first()).toBeVisible({ timeout: 60_000 })
  await o.context.close()
})

test('chats are visible only to the user who created them', async ({ browser }) => {
  const a = await openAs(browser, 'alice')
  await dismissFirstRun(a.page)
  await selectStubModel(a.page)
  await sendMessage(a.page, 'alice private plan 7731')
  await expect(a.page.getByText('stub reply: alice private plan 7731')).toBeVisible()
  const aliceSessions = await rpc(a.page, 'session/list', { _request: {} })
  expect(JSON.stringify(aliceSessions.body)).toContain('session-')
  await a.context.close()

  const b = await openAs(browser, 'bob')
  await dismissFirstRun(b.page)
  await expect(b.page.getByText('alice private plan 7731')).toHaveCount(0)
  const bobSessions = await rpc(b.page, 'session/list', { _request: {} })
  for (const id of JSON.stringify(aliceSessions.body).match(/session-[0-9a-f-]{36}/g) ?? []) {
    expect(JSON.stringify(bobSessions.body)).not.toContain(id)
  }
  const search = await rpc(b.page, 'session/search', { request: { query: '7731' } })
  expect(JSON.stringify(search.body ?? {})).not.toContain('alice private plan')
  await b.context.close()
})

test('General preferences are saved per user', async ({ browser }) => {
  const a = await openAs(browser, 'alice')
  await dismissFirstRun(a.page)
  let settings = await openSettings(a.page)
  await settings.getByText('Dark', { exact: true }).click()
  await expect.poll(() => readData(`users/${USERS.alice}/home/profiles/web/cordis.patch.yml`) ?? '').toContain('dark')
  await a.page.reload()
  settings = await openSettings(a.page)
  await expect(settings.getByRole('button', { name: /Dark/ })).toHaveAttribute('aria-pressed', 'true')
  await a.context.close()

  for (const other of ['bob', 'owner']) {
    const key = other === 'bob' ? USERS.bob : USERS.owner
    expect(readData(`users/${key}/home/profiles/web/cordis.patch.yml`) ?? '').not.toMatch(/preference: dark/)
  }
  // The shared store never carries personal preferences.
  expect(readData('shared/admin-rows.yml') ?? '').not.toContain('ui-theme')
})

test('HA users outside the admin and user groups are refused', async ({ browser }) => {
  const { context, page } = await openAs(browser, 'reader')
  await expect(page.getByText('does not have access')).toBeVisible()
  await context.close()
})

test('every request stays under the ingress path', async ({ browser }) => {
  const { context, page } = await openAs(browser, 'bob')
  const outside = []
  page.on('request', (r) => {
    const u = new URL(r.url())
    if (!u.pathname.startsWith(INGRESS.replace(/\/$/, '')) && u.pathname !== '/login' && u.pathname !== '/panel') outside.push(u.pathname)
  })
  page.on('websocket', (ws) => { if (!new URL(ws.url()).pathname.startsWith(INGRESS)) outside.push(ws.url()) })
  await page.reload()
  await dismissFirstRun(page)
  await page.waitForTimeout(2000)
  expect(outside).toEqual([])
  await context.close()
})

test('the gateway refuses connections that do not come from ingress', async ({ request }) => {
  const direct = process.env.E2E_DIRECT_GATEWAY_URL
  test.skip(!direct, 'E2E_DIRECT_GATEWAY_URL not set (local run with a trusted loopback peer)')
  const res = await request.get(`${direct}/`, { headers: { 'x-remote-user-id': USERS.owner } })
  expect(res.status()).toBe(403)
})
