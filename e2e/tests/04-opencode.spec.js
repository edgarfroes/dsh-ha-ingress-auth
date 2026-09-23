// OpenCode Go requires a stable `x-opencode-session` header per conversation.
// dsh's pi-ai (overridden to 0.87.1) adds it for the opencode providers. The
// opencode-go route is pointed at the stub model, so this spends no tokens.
import { test, expect } from '@playwright/test'
import { openAs, dismissFirstRun, rpc, sendMessage, STUB_LLM_URL } from './helpers.js'

test.describe.configure({ mode: 'serial' })

test('opencode-go requests carry a per-conversation x-opencode-session', async ({ browser }) => {
  const { context, page } = await openAs(browser, 'owner')
  await dismissFirstRun(page)
  const key = await rpc(page, 'credentials/set', { ref: 'OPENCODE_GO_API_KEY', value: 'sk-e2e-fake-opencode' })
  expect(key.status).toBe(200)
  const describe = await rpc(page, 'settings/describe', {})
  const ns = describe.body.result.value.namespaces.find((n) => n.ns === 'llm-pi-ai')
  const set = await rpc(page, 'settings/mutate', {
    ns: 'llm-pi-ai',
    ops: [{ op: 'set', path: ['providers', 'opencode-go'], value: { apiKeyEnv: 'OPENCODE_GO_API_KEY', baseURL: STUB_LLM_URL, models: [{ id: 'glm-5.3-flash', name: 'Go via stub' }] } }],
    expectedRevision: ns.revision,
  })
  expect(set.body?.result?.ok, JSON.stringify(set.body).slice(0, 400)).toBe(true)
  await page.reload()
  await dismissFirstRun(page)

  const pick = async () => {
    await page.getByRole('button', { name: /^Select model/ }).click()
    await page.getByRole('menuitem', { name: /^Model / }).click()
    await page.getByRole('menuitemradio', { name: 'Go via stub' }).click()
  }
  const tagOf = async (text) => {
    const line = page.getByText(new RegExp(`stub reply: ${text} \\[opencode-session:[0-9a-f]{8}\\]`)).first()
    await expect(line).toBeVisible({ timeout: 60_000 })
    return (await line.innerText()).match(/opencode-session:([0-9a-f]{8})/)[1]
  }

  await page.getByRole('button', { name: 'New Session' }).first().click()
  await pick()
  await sendMessage(page, 'go first')
  const first = await tagOf('go first')
  await sendMessage(page, 'go again')
  expect(await tagOf('go again')).toBe(first)

  await page.getByRole('button', { name: 'New Session' }).first().click()
  await pick()
  await sendMessage(page, 'go other chat')
  expect(await tagOf('go other chat')).not.toBe(first)
  await context.close()
})
