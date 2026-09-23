import { test } from 'node:test'
import assert from 'node:assert/strict'
import { roleOf, UserDirectory } from '../../src/gateway/roles.js'

const policy = { adminGroup: 'system-admin', userGroups: ['system-users'] }

test('roleOf maps HA groups', () => {
  assert.equal(roleOf({ id: '1', group_ids: ['system-admin'] }, policy), 'admin')
  assert.equal(roleOf({ id: '2', group_ids: ['system-users'] }, policy), 'user')
  assert.equal(roleOf({ id: '3', group_ids: ['system-read-only'] }, policy), 'denied')
  assert.equal(roleOf({ id: '4', group_ids: ['system-admin'], is_active: false }, policy), 'denied')
  assert.equal(roleOf({ id: '5', group_ids: ['system-admin'], system_generated: true }, policy), 'denied')
  assert.equal(roleOf(undefined, policy), 'denied')
})

test('UserDirectory caches, refreshes on unknown ids, and survives a failed refresh', async () => {
  let calls = 0
  let fail = false
  let list = [{ id: 'a', group_ids: ['system-admin'] }]
  let now = 0
  const dir = new UserDirectory({ fetchUsers: async () => { calls++; if (fail) throw new Error('down'); return list }, ttlMs: 1000, now: () => now })
  assert.equal((await dir.resolve('a')).role, 'admin')
  assert.equal((await dir.resolve('a')).role, 'admin')
  assert.equal(calls, 1)
  list = [...list, { id: 'b', group_ids: ['system-users'] }]
  assert.equal((await dir.resolve('b')).role, 'user')
  assert.equal(calls, 2)
  fail = true
  now = 5000
  assert.equal((await dir.resolve('a')).role, 'admin')
})
