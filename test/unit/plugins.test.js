import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parsePluginSpecs, pluginRows } from '../../src/gateway/plugins.js'
import { buildOverlay } from '../../src/gateway/overlays.js'
import { parsePatch } from '../../src/gateway/patches.js'

test('parsePluginSpecs trims, drops blanks, comments and duplicates', () => {
  assert.deepEqual(parsePluginSpecs(undefined), [])
  assert.deepEqual(parsePluginSpecs([' a@1.0.0 ', '', '# note', 'a@1.0.0', 'b # why']), ['a@1.0.0', 'b'])
})

test('parsePluginSpecs refuses flags and non-strings', () => {
  assert.throws(() => parsePluginSpecs(['--registry=http://evil']))
  assert.throws(() => parsePluginSpecs([1]))
  assert.throws(() => parsePluginSpecs('a'))
})

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-plugins-'))
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: { good: '1.0.0', plain: '1.0.0' } }))
  const good = join(dir, 'node_modules', 'good')
  mkdirSync(good, { recursive: true })
  writeFileSync(join(good, 'package.json'), JSON.stringify({ name: 'good', version: '1.0.0', dsh: { bundle: { patch: './cordis.patch.yml' } } }))
  writeFileSync(join(good, 'cordis.patch.yml'), "- insert:\n    - id: good\n      name: './index.js'\n- id: dsh-ha-ingress-auth\n  config: { role: admin }\n- id: some-row\n  disabled: false\n")
  const plain = join(dir, 'node_modules', 'plain')
  mkdirSync(plain, { recursive: true })
  writeFileSync(join(plain, 'package.json'), JSON.stringify({ name: 'plain', version: '1.0.0' }))
  return { dir, good }
}

test('pluginRows mounts bundle rows by absolute path and skips reserved ids and non-bundles', () => {
  const { dir, good } = fixture()
  const lines = []
  const rows = pluginRows(dir, (l) => lines.push(l))
  assert.deepEqual(rows, [{ insert: [{ id: 'good', name: join(good, 'index.js') }] }, { id: 'some-row', disabled: false }])
  assert.ok(lines.some((l) => l.includes('reserved id dsh-ha-ingress-auth')))
  assert.ok(lines.some((l) => l.includes('plain skipped')))
})

test('plugin rows come before the lockdown rows, so they cannot re-enable them', () => {
  const rows = parsePatch(buildOverlay({ role: 'user', handshakeFile: '/h', pluginRows: [{ id: 'ui-plugin-manager', disabled: false }] }))
  const at = (pred) => rows.findIndex(pred)
  assert.equal(at((r) => r.id === 'ui-plugin-manager' && r.disabled === false), 0)
  assert.ok(at((r) => r.id === 'ui-plugin-manager' && r.disabled === true) > 0)
})
