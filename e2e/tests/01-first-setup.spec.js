// Fresh install: the first admin configures models through the UI.
import { test, expect } from '@playwright/test'
import { openAs, dismissFirstRun, openSettings, readData, selectStubModel, sendMessage, STUB_LLM_URL } from './helpers.js'

test.describe.configure({ mode: 'serial' })

test('first admin sees onboarding and can store an API key for everyone', async ({ browser }) => {
  const { context, page } = await openAs(browser, 'owner')
  await page.getByRole('button', { name: 'Continue', exact: true }).click()
  const dialog = page.getByRole('dialog').filter({ hasText: 'Add an API key to get started' })
  await expect(dialog).toBeVisible()
  await dialog.getByRole('textbox').fill('sk-e2e-dummy-deepseek-key')
  await dialog.getByRole('button', { name: 'Save and continue' }).click()
  await expect(dialog).toBeHidden()
  // The key lands in the shared (admin) credentials file, not in the user's own.
  await expect.poll(() => readData('shared/credentials.yaml') ?? '').toContain('DEEPSEEK_API_KEY')
  expect(readData('users/a0000000000000000000000000000001/home/.credentials.yaml') ?? '').not.toContain('DEEPSEEK_API_KEY')
  await context.close()
})

test('admin adds a custom model provider in Settings → Models', async ({ browser }) => {
  const { context, page } = await openAs(browser, 'owner')
  await dismissFirstRun(page)
  const settings = await openSettings(page)
  await settings.getByText('Models', { exact: true }).click()
  await settings.getByText('Add model provider').click()
  await settings.getByText('Custom model API').click()
  const form = settings.getByRole('tabpanel', { name: 'Custom model API' })
  await form.getByRole('textbox', { name: 'Provider ID' }).fill('stub')
  await form.getByRole('textbox', { name: 'Display name' }).fill('Stub LLM')
  await form.getByRole('textbox', { name: 'Base URL' }).fill(STUB_LLM_URL)
  await form.getByRole('textbox', { name: 'API key' }).fill('sk-e2e-stub-key')
  await form.getByRole('button', { name: 'Add model' }).click()
  await form.getByRole('textbox', { name: 'Model ID 1' }).fill('stub-model')
  await form.getByRole('textbox', { name: 'Display name 1' }).fill('Stub Model')
  await form.getByRole('button', { name: 'Create provider' }).click()
  // Provider config becomes a shared row; its key goes to the shared credentials.
  await expect.poll(() => readData('shared/admin-rows.yml') ?? '', { timeout: 20000 }).toContain('stub-model')
  expect(readData('shared/credentials.yaml') ?? '').toMatch(/STUB/i)
  await context.close()
})

test('admin chats with the stub model', async ({ browser }) => {
  const { context, page } = await openAs(browser, 'owner')
  await dismissFirstRun(page)
  await selectStubModel(page)
  await sendMessage(page, 'hello from owner')
  await expect(page.getByText('stub reply: hello from owner')).toBeVisible()
  await context.close()
})
