// The bundled pt-BR language pack reaches every user, admin or not, and each
// user's language choice stays their own.
import { test, expect } from '@playwright/test'
import { openAs, dismissFirstRun, openSettings, readData, INGRESS, USERS } from './helpers.js'

test.describe.configure({ mode: 'serial' })

const PT = 'Português (Brasil)'
const profile = (key) => readData(`users/${key}/home/profiles/web/cordis.patch.yml`) ?? ''

/** Open Settings → General → Language (in either language) and pick `label`. */
async function chooseLanguage(page, label) {
  await page.getByText(/^(Settings|Configurações)$/).last().click()
  const settings = page.getByRole('dialog')
  const row = settings.locator('div').filter({ has: page.getByText(/^(Language|Idioma)$/) }).filter({ has: page.getByRole('button') }).last()
  await row.getByRole('button').first().click()
  await page.getByRole('menuitemradio', { name: label }).or(page.getByRole('menuitem', { name: label })).or(page.getByRole('option', { name: label })).first().click()
  await page.keyboard.press('Escape')
}

test('a non-admin can pick Português (Brasil); the pack bundle is served through ingress', async ({ browser }) => {
  const { context, page } = await openAs(browser, 'alice')
  await dismissFirstRun(page)
  await chooseLanguage(page, PT)
  await expect(page.getByText('Nova sessão').first()).toBeVisible()
  // Stored in alice's own profile patch only.
  await expect.poll(() => profile(USERS.alice)).toContain('pt-BR')
  expect(profile(USERS.bob)).not.toContain('pt-BR')
  expect(readData('shared/admin-rows.yml') ?? '').not.toContain('pt-BR')
  // It survives a reload, and the pack's browser bundle comes through ingress.
  const bundles = []
  page.on('response', (res) => { if (decodeURIComponent(res.url()).includes('dsh-locale-pt-br')) bundles.push(res.status()) })
  await page.reload()
  await expect(page.getByText('Nova sessão').first()).toBeVisible({ timeout: 60_000 })
  expect(bundles.length).toBeGreaterThan(0)
  for (const status of bundles) expect(status).toBe(200)
  await context.close()
})

test('another user stays in English', async ({ browser }) => {
  const { context, page } = await openAs(browser, 'bob')
  await dismissFirstRun(page)
  await expect(page.getByText('New Session').first()).toBeVisible()
  await expect(page.getByText('Nova sessão')).toHaveCount(0)
  await context.close()
})

test('admins get the language too', async ({ browser }) => {
  const { context, page } = await openAs(browser, 'owner')
  await dismissFirstRun(page)
  const settings = await openSettings(page)
  const row = settings.locator('div').filter({ has: page.getByText('Language', { exact: true }) }).filter({ has: page.getByRole('button') }).last()
  await row.getByRole('button').first().click()
  await expect(page.getByText(PT).first()).toBeVisible()
  await page.keyboard.press('Escape')
  await context.close()
})

test('a pt-BR browser gets Portuguese without choosing it', async ({ browser }) => {
  // bob has no stored choice, so dsh follows the browser's language.
  const context = await browser.newContext({ locale: 'pt-BR' })
  const page = await context.newPage()
  await page.goto('/login?user=bob')
  await page.goto(INGRESS)
  await expect(page.getByText('Nova sessão').first()).toBeVisible({ timeout: 60_000 })
  expect(profile(USERS.bob)).not.toContain('pt-BR')
  await context.close()
})

test('alice switches back to English', async ({ browser }) => {
  const { context, page } = await openAs(browser, 'alice')
  await expect(page.getByText('Nova sessão').first()).toBeVisible({ timeout: 60_000 })
  await chooseLanguage(page, 'English')
  await expect(page.getByText('New Session').first()).toBeVisible()
  await context.close()
})
