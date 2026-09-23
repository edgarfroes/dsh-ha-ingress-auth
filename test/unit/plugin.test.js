import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveConfig, makeUserToolGuard, DEFAULT_USER_TOOLS, apply } from '../../src/plugin/host.js'
import { buildOverlay } from '../../src/gateway/overlays.js'
import { parsePatch } from '../../src/gateway/patches.js'
import { findRunning } from '../../src/gateway/busy.js'

test('tool guard allows the allow-list only', () => {
  const guard = makeUserToolGuard(DEFAULT_USER_TOOLS)
  assert.equal(guard({ name: 'web_search' }), undefined)
  for (const name of ['bash', 'pwsh', 'read', 'write', 'edit', 'glob', 'grep', 'run_code', 'job_kill', 'cordis_inspect_query']) {
    assert.match(guard({ name }), /administrators/)
  }
})

test('config defaults: unknown role is user; users get General-only settings', () => {
  assert.equal(resolveConfig({}).role, 'user')
  assert.equal(resolveConfig({}).generalSettingsOnly, true)
  assert.equal(resolveConfig({ role: 'admin' }).generalSettingsOnly, false)
  assert.equal(resolveConfig({ role: 'admin' }).hiddenGeneralRows.length, 0)
  assert.equal(resolveConfig({}).defaultGrouping, 'flat')
  assert.equal(resolveConfig({ role: 'admin' }).defaultGrouping, undefined)
  assert.deepEqual(resolveConfig({ hiddenGeneralRows: ['ok_row', 'x}{display:block'] }).hiddenGeneralRows, ['ok_row'])
})

test('plugin registers index rows and the guard for users', () => {
  const handlers = []
  let guard
  const ctx = {
    on: (event, fn) => handlers.push([event, fn]),
    effect: (fn) => fn(),
    inject: (_deps, fn) => fn({ effect: (f) => f(), tools: { guard: (g) => { guard = g; return () => {} } } }),
  }
  apply(ctx, { role: 'user' })
  const table = []
  for (const [event, fn] of handlers) if (event === 'webserver/index-inject') fn(table)
  assert.deepEqual(table.find((r) => r.kind === 'global').value, { ownsHost: true })
  assert.ok(table.some((r) => r.kind === 'style' && r.text.includes('settings.header')))
  assert.ok(table.some((r) => r.kind === 'style' && r.text.includes('_2XZxNq_row') && r.text.includes('Pt1bsG_row')))
  assert.match(guard({ name: 'bash' }), /administrators/)
  const script = table.find((r) => r.kind === 'script')
  assert.ok(script && script.placement === 'head' && !script.text.includes('</script'))
  // The script sets "In one list" once, keeps other view fields, then respects the user's choice.
  const store = new Map([['dsh.workspace.view.v5', JSON.stringify({ groupBy: 'workspace', orderBy: 'manual' })]])
  globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)) }
  new Function(script.text)()
  assert.deepEqual(JSON.parse(store.get('dsh.workspace.view.v5')), { groupBy: 'flat', orderBy: 'manual', groupExpansion: {}, sessionOrderByAccount: {}, archivedFilter: 'default' })
  store.set('dsh.workspace.view.v5', JSON.stringify({ groupBy: 'workspace-tree' }))
  new Function(script.text)()
  assert.equal(JSON.parse(store.get('dsh.workspace.view.v5')).groupBy, 'workspace-tree')
  delete globalThis.localStorage
})

test('user overlay disables admin surfaces; admin overlay shares credentials', () => {
  const user = parsePatch(buildOverlay({ role: 'user', handshakeFile: '/h', documentsDirectory: '/w' }))
  const disabled = user.filter((r) => r.disabled === true).map((r) => r.id)
  for (const id of ['ui-settings-models', 'ui-settings-plugins', 'ui-permission', 'plugin-manager', 'ui-sidebar-terminal', 'terminal-controller', 'workspace-files', 'directory-picker']) assert.ok(disabled.includes(id), id)
  assert.equal(user.find((r) => r.id === 'credentials'), undefined)
  assert.equal(user.find((r) => r.id === 'ui-settings').config.enabled, false)
  const admin = parsePatch(buildOverlay({ role: 'admin', handshakeFile: '/h', sharedCredentialsFile: '/data/shared/credentials.yaml' }))
  assert.equal(admin.find((r) => r.id === 'credentials').config.path, '/data/shared/credentials.yaml')
  assert.equal(admin.filter((r) => r.disabled === true).length, 0)
  assert.equal(admin.find((r) => r.id === 'ui-settings'), undefined)
})

test('findRunning finds a running session anywhere in the answer', () => {
  assert.equal(findRunning({ sessions: [{ running: false }, { running: false }] }), false)
  assert.equal(findRunning({ page: { items: [{ running: true }] } }), true)
})
