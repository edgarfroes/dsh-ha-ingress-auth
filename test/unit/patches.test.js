import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parsePatch, dumpPatch, splitRows, applyAdminChange, mergeForAdmin, JsExpression } from '../../src/gateway/patches.js'

test('round-trips !!js expressions without evaluating them', () => {
  const text = "- id: hmr\n  disabled: !!js '!ctx.get(''profileContext'')'\n"
  const rows = parsePatch(text)
  assert.ok(rows[0].disabled instanceof JsExpression)
  assert.equal(rows[0].disabled.source, "!ctx.get('profileContext')")
  const again = parsePatch(dumpPatch(rows))
  assert.equal(again[0].disabled.source, "!ctx.get('profileContext')")
})

test('empty and bracket-only patches parse to []', () => {
  assert.deepEqual(parsePatch('# comment\n[]\n'), [])
  assert.deepEqual(parsePatch(''), [])
  assert.throws(() => parsePatch('a: 1\n'))
})

test('splitRows keeps preference rows personal and everything else shared', () => {
  const rows = [
    { id: 'ui-theme', config: { preference: 'dark' } },
    { id: 'llm-pi-ai', config: { providers: {} } },
    { id: 'something-new', config: {} },
    { insert: [{ id: 'x', name: 'y' }] },
  ]
  const { preference, shared } = splitRows(rows)
  assert.deepEqual(preference.map((r) => r.id), ['ui-theme'])
  assert.equal(shared.length, 3)
})

test('applyAdminChange merges edits from two admins without undoing each other', () => {
  const store = [{ id: 'a', config: { v: 1 } }, { id: 'b', config: { v: 1 } }]
  // Admin 1 changes a; admin 2 (whose snapshot is still the old store) changes b.
  const r1 = applyAdminChange(store, store, [{ id: 'a', config: { v: 2 } }, { id: 'b', config: { v: 1 } }])
  assert.ok(r1.changed)
  const r2 = applyAdminChange(r1.rows, store, [{ id: 'a', config: { v: 1 } }, { id: 'b', config: { v: 3 } }])
  assert.deepEqual(r2.rows, [{ id: 'a', config: { v: 2 } }, { id: 'b', config: { v: 3 } }])
})

test('applyAdminChange removes a row the admin reset', () => {
  const store = [{ id: 'a', config: { v: 1 } }, { id: 'b', config: { v: 1 } }]
  const r = applyAdminChange(store, store, [{ id: 'b', config: { v: 1 } }])
  assert.deepEqual(r.rows, [{ id: 'b', config: { v: 1 } }])
  assert.ok(r.changed)
  assert.equal(applyAdminChange(store, store, store).changed, false)
})

test('mergeForAdmin keeps the admin preferences and replaces shared rows', () => {
  const own = [{ id: 'ui-theme', config: { preference: 'dark' } }, { id: 'llm-pi-ai', config: { old: true } }]
  const store = [{ id: 'llm-pi-ai', config: { new: true } }]
  assert.deepEqual(mergeForAdmin(own, store), [own[0], store[0]])
})
