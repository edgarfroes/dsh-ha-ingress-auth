import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveConfig, makeUserToolGuard, DEFAULT_USER_TOOLS, apply } from '../../src/plugin/host.js'
import { buildOverlay, parseMcpServers, buildMcpRows, LANGUAGE_PACKS, languagePackRows, DEFAULT_USER_DISABLED_ROWS } from '../../src/gateway/overlays.js'
import { parsePatch } from '../../src/gateway/patches.js'
import { findRunning } from '../../src/gateway/busy.js'

test('tool guard allows the allow-list only', () => {
  const guard = makeUserToolGuard(DEFAULT_USER_TOOLS)
  assert.equal(guard({ name: 'web_search' }), undefined)
  for (const name of ['bash', 'pwsh', 'read', 'write', 'edit', 'glob', 'grep', 'run_code', 'job_kill', 'cordis_inspect_query']) {
    assert.match(guard({ name }), /administrators/)
  }
})

test('tool guard supports trailing-* prefix entries', () => {
  const guard = makeUserToolGuard(['web_search', 'mcp__firecrawl__*'])
  assert.equal(guard({ name: 'web_search' }), undefined)
  assert.equal(guard({ name: 'mcp__firecrawl__search' }), undefined)
  assert.equal(guard({ name: 'mcp__firecrawl__scrape' }), undefined)
  assert.match(guard({ name: 'mcp__playwright__browser_navigate' }), /administrators/)
  assert.match(guard({ name: 'bash' }), /administrators/)
  // A star in the middle is not a wildcard: the entry stays exact.
  const exact = makeUserToolGuard(['we*ird'])
  assert.equal(exact({ name: 'we*ird' }), undefined)
  assert.match(exact({ name: 'weird' }), /administrators/)
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

const MCP_SERVERS = [
  { serverName: 'firecrawl', url: 'http://localhost:3000/mcp' },
  { serverName: 'playwright', url: 'http://localhost:8931/mcp' },
]

test('overlay loads the pt-BR language pack for both roles, by absolute path', () => {
  assert.deepEqual([...LANGUAGE_PACKS], ['dsh-locale-pt-br'])
  const rows = languagePackRows(LANGUAGE_PACKS, (name) => `/opt/dsh-ha/node_modules/${name}/index.js`)
  assert.deepEqual(rows, [{ id: 'dsh-locale-pt-br', name: '/opt/dsh-ha/node_modules/dsh-locale-pt-br/index.js' }])
  for (const role of ['admin', 'user']) {
    const patch = parsePatch(buildOverlay({ role, handshakeFile: '/h', languagePackRows: rows }))
    const inserts = patch.flatMap((r) => (Array.isArray(r.insert) ? r.insert : []))
    assert.deepEqual(inserts.find((r) => r.id === 'dsh-locale-pt-br'), rows[0], role)
    // Nothing in the overlay disables it.
    assert.ok(!patch.some((r) => r.id === 'dsh-locale-pt-br' && r.disabled), role)
  }
  assert.ok(!DEFAULT_USER_DISABLED_ROWS.includes('dsh-locale-pt-br'))
})

test('a language pack that is not installed is left out', () => {
  const rows = languagePackRows(['dsh-locale-pt-br', 'not-installed'], (name) => {
    if (name === 'not-installed') throw new Error('MODULE_NOT_FOUND')
    return `/x/${name}/index.js`
  })
  assert.deepEqual(rows.map((r) => r.id), ['dsh-locale-pt-br'])
})

test('overlay adds one dsh-mcp-client row per server for both roles', () => {
  for (const role of ['admin', 'user']) {
    const patch = parsePatch(buildOverlay({ role, handshakeFile: '/h', documentsDirectory: '/w', mcpServers: MCP_SERVERS }))
    const inserts = patch.flatMap((r) => (Array.isArray(r.insert) ? r.insert : []))
    for (const server of MCP_SERVERS) {
      const row = inserts.find((r) => r.id === `mcp-${server.serverName}`)
      assert.ok(row, `${role}: mcp-${server.serverName}`)
      assert.equal(row.name, '@deepseek-ai/dsh-mcp-client')
      assert.deepEqual(row.config, { serverName: server.serverName, transport: 'streamable-http', url: server.url })
    }
  }
  // No mcp_servers option, no rows: the stock overlay is unchanged.
  for (const role of ['admin', 'user']) {
    const patch = parsePatch(buildOverlay({ role, handshakeFile: '/h' }))
    assert.equal(patch.filter((r) => Array.isArray(r.insert)).length, 1)
  }
})

test('parseMcpServers parses name/url pairs and rejects malformed input', () => {
  assert.deepEqual(parseMcpServers(undefined), [])
  assert.deepEqual(parseMcpServers(null), [])
  assert.deepEqual(parseMcpServers(''), [])
  assert.deepEqual(parseMcpServers([]), [])
  assert.deepEqual(parseMcpServers('   \n# only a comment\n'), [])
  // The add-on config UI collects a repeatable name/URL pair.
  assert.deepEqual(
    parseMcpServers(MCP_SERVERS.map(({ serverName, url }) => ({ name: serverName, url }))),
    MCP_SERVERS,
  )
  // Comma-separated, newline-separated and lists of strings also work.
  assert.deepEqual(
    parseMcpServers('# comment,firecrawl=http://localhost:3000/mcp,,playwright=http://localhost:8931/mcp#no space'),
    MCP_SERVERS,
  )
  assert.deepEqual(
    parseMcpServers(['firecrawl=http://localhost:3000/mcp', 'playwright=http://localhost:8931/mcp']),
    MCP_SERVERS,
  )
  for (const bad of [
    'just a word',
    'bad name=http://x/mcp',
    'ok=ftp://x/mcp',
    'ok=b=2',
    'a'.repeat(33) + '=http://x/mcp',
    ['x=http://a/mcp', 'x=http://b/mcp'],
    [{ url: 'http://x/mcp' }],
    [{ name: 'x', url: 'ftp://x/mcp' }],
    [{ name: 'x', url: 'http://a/mcp', extra: 1 }, { name: 'x', url: 'http://b/mcp' }],
    [42],
  ]) {
    assert.throws(() => parseMcpServers(bad), /(name=|name \(|duplicate|server name|pair)/)
  }
})

test('buildMcpRows emits streamable-http entries with the raw url', () => {
  const rows = buildMcpRows(MCP_SERVERS)
  assert.deepEqual(rows, MCP_SERVERS.map((s) => ({
    insert: [{ id: `mcp-${s.serverName}`, name: '@deepseek-ai/dsh-mcp-client', config: { serverName: s.serverName, transport: 'streamable-http', url: s.url } }],
  })))
  assert.deepEqual(buildMcpRows(undefined), [])
})

test('findRunning finds a running session anywhere in the answer', () => {
  assert.equal(findRunning({ sessions: [{ running: false }, { running: false }] }), false)
  assert.equal(findRunning({ page: { items: [{ running: true }] } }), true)
})
