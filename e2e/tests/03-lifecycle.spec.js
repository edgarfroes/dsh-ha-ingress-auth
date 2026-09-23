// Lifecycle: admins sharing configuration, persistence across restarts, role
// changes, idle stop and deleted users. Runs after 01 and 02.
import { test, expect } from '@playwright/test'
import {
  openAs, dismissFirstRun, openSettings, rpc, readData, selectStubModel, sendMessage,
  setUsers, getUsers, restartApp, waitForPanel, gatewayLog, listData, USERS, INGRESS,
} from './helpers.js'

test.describe.configure({ mode: 'serial' })

let originalUsers

test.beforeAll(async ({ request }) => { originalUsers = await getUsers(request) })
test.afterAll(async ({ request }) => { if (originalUsers) await setUsers(request, originalUsers) })

test('a second admin gets the shared configuration and their changes reach everyone', async ({ browser }) => {
  // First boot of a new admin, then a settings sync and a reload: slower than most.
  test.setTimeout(240_000)
  const { context, page } = await openAs(browser, 'admin2')
  // A new admin's profile is created on first boot; the gateway then copies
  // the shared rows into it and dsh reloads them.
  await expect.poll(() => readData(`users/${USERS.admin2}/home/profiles/web/cordis.patch.yml`) ?? '', { timeout: 30_000 }).toContain('stub-model')
  await page.reload()
  await dismissFirstRun(page)
  await selectStubModel(page)
  // admin2 renames the provider; the change must reach the store and alice.
  const settings = await openSettings(page)
  await settings.getByText('Models', { exact: true }).click()
  const described = await rpc(page, 'settings/describe', {})
  expect(JSON.stringify(described.body)).toContain('stub-model')
  const ns = described.body.result.value
  const revision = JSON.stringify(ns).match(/"llm-pi-ai".*?"revision":(\d+)/)?.[1]
  const res = await rpc(page, 'settings/mutate', {
    ns: 'llm-pi-ai',
    ops: [{ op: 'set', path: ['providers', 'stub', 'displayName'], value: 'Stub LLM (renamed)' }],
    ...(revision ? { expectedRevision: Number(revision) } : {}),
  })
  expect(res.body?.result?.ok, JSON.stringify(res.body)).toBe(true)
  await expect.poll(() => readData('shared/admin-rows.yml') ?? '', { timeout: 20_000 }).toContain('Stub LLM (renamed)')
  await expect.poll(() => readData(`users/${USERS.owner}/home/profiles/web/cordis.patch.yml`) ?? '', { timeout: 20_000 }).toContain('Stub LLM (renamed)')
  await context.close()
})

test('sessions, preferences and models survive an app restart', async ({ browser, request }) => {
  test.skip(!process.env.E2E_RESTART_CMD, 'E2E_RESTART_CMD not set')
  restartApp()
  await waitForPanel(request, 'alice')
  const { context, page } = await openAs(browser, 'alice')
  await dismissFirstRun(page)
  await expect(page.getByText('Stub title').first()).toBeVisible()
  const list = await rpc(page, 'session/list', { _request: {} })
  expect(JSON.stringify(list.body)).toContain('session-')
  const settings = await openSettings(page)
  await expect(settings.getByRole('button', { name: /Dark/ })).toHaveAttribute('aria-pressed', 'true')
  await page.keyboard.press('Escape')
  await selectStubModel(page)
  await sendMessage(page, 'after restart')
  await expect(page.getByText('stub reply: after restart')).toBeVisible()
  await context.close()
})

test('promoting and demoting an HA user switches their dsh composition', async ({ browser, request }) => {
  const users = await getUsers(request)
  const promote = users.map((u) => (u.username === 'bob' ? { ...u, group_ids: ['system-admin'] } : u))
  await setUsers(request, promote)
  // The role cache holds for up to a minute; a new user id forces a refresh,
  // so poll the panel until the admin composition shows up.
  const { context, page } = await openAs(browser, 'bob')
  await expect.poll(async () => {
    await page.reload()
    return page.getByText('Plugins', { exact: true }).count()
  }, { timeout: 90_000, intervals: [5000] }).toBeGreaterThan(0)
  await setUsers(request, users)
  await expect.poll(async () => {
    await page.reload()
    return page.getByText('Plugins', { exact: true }).count()
  }, { timeout: 90_000, intervals: [5000] }).toBe(0)
  await context.close()
})

test('an idle non-admin process stops and comes back with its history', async ({ browser }) => {
  test.skip(!process.env.E2E_SHORT_IDLE, 'needs the gateway started with a short idle timeout (E2E_SHORT_IDLE=1)')
  const { context, page } = await openAs(browser, 'bob')
  await dismissFirstRun(page)
  await selectStubModel(page)
  await sendMessage(page, 'bob before idle')
  await expect(page.getByText('stub reply: bob before idle')).toBeVisible()
  await context.close()
  // No connection left: the gateway stops bob's process after the idle timeout.
  await expect.poll(() => gatewayLog(), { timeout: 120_000, intervals: [3000] }).toContain(`stopping idle process of ${USERS.bob.slice(0, 6)}…${USERS.bob.slice(-4)}`)
  const again = await openAs(browser, 'bob')
  await dismissFirstRun(again.page)
  await expect(again.page.getByText('Stub title').first()).toBeVisible()
  await again.context.close()
})

test('a deleted HA user is archived, not deleted', async ({ browser, request }) => {
  test.skip(!process.env.E2E_SHORT_IDLE, 'needs short archive interval (E2E_SHORT_IDLE=1)')
  // A throwaway user uses the app once…
  const users = await getUsers(request)
  const temp = { id: 'e0000000000000000000000000000001', username: 'temp', name: 'Temp', is_owner: false, is_active: true, system_generated: false, group_ids: ['system-users'] }
  await setUsers(request, [...users, temp])
  const { context, page } = await openAs(browser, 'temp')
  await dismissFirstRun(page)
  await context.close()
  expect(readData(`users/${temp.id}/home/profiles/web/cordis.patch.yml`)).toBeDefined()
  // …then is removed from Home Assistant.
  await setUsers(request, users)
  await expect.poll(() => readData(`users/${temp.id}/home/profiles/web/cordis.patch.yml`), { timeout: 60_000 }).toBeUndefined()
  expect(listData('archive').some((d) => d.startsWith(temp.id))).toBe(true)
})

test('the sidebar panel works inside an iframe, like Home Assistant', async ({ browser }) => {
  const context = await browser.newContext()
  const page = await context.newPage()
  await page.goto('/login?user=alice')
  await page.goto('/panel')
  const frame = page.frameLocator('#panel')
  await expect(frame.getByText('New Session').first()).toBeVisible()
  expect(page.url()).toContain('/panel')
  expect(INGRESS).toContain('hassio_ingress')
  await context.close()
})
