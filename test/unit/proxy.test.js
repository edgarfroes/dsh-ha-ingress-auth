import { test } from 'node:test'
import assert from 'node:assert/strict'
import { childRequestHeaders, userRequestDenial, settingsWriteDenial, restoreComboQuery } from '../../src/gateway/proxy.js'
import { ingressIdentity } from '../../src/gateway/server.js'
import { DEFAULT_PREFERENCE_ROWS } from '../../src/gateway/patches.js'

test('child headers: loopback authority, only the child cookie, no HA identity', () => {
  const out = childRequestHeaders({
    host: 'ha.example:8123', origin: 'https://ha.example:8123', cookie: 'ingress_session=secret; dsh-auth-x=forged',
    'x-remote-user-id': 'u', 'x-ingress-path': '/api/hassio_ingress/t', 'sec-fetch-site': 'cross-site', accept: 'text/html',
  }, { port: 4000, cookie: 'dsh-auth-real=1' })
  assert.equal(out.host, '127.0.0.1:4000')
  assert.equal(out.origin, 'http://127.0.0.1:4000')
  assert.equal(out.cookie, 'dsh-auth-real=1')
  assert.equal(out['x-remote-user-id'], undefined)
  assert.equal(out['x-ingress-path'], undefined)
  assert.equal(out['sec-fetch-site'], undefined)
  assert.equal(out.accept, 'text/html')
})

test('user denials: admin-only calls and files outside the user folder', () => {
  const root = '/data/users/u1'
  assert.match(userRequestDenial('/api/credentials/set', root), /administrators/)
  assert.match(userRequestDenial('/api/dynamicCordisRunner/invoke', root), /administrators/)
  assert.equal(userRequestDenial('/api/session/list', root), undefined)
  assert.equal(userRequestDenial('/api/file?path=/data/users/u1/workspace/a.txt', root), undefined)
  assert.match(userRequestDenial('/api/file?path=/data/shared/credentials.yaml', root), /outside/)
  assert.match(userRequestDenial('/api/file?path=/data/users/u1/../u2/home/x', root), /outside/)
  assert.match(userRequestDenial('/api/file?path=/data/users/u10/x', root), /outside/)
})

test('settings writes: preference namespaces only', () => {
  const body = (ns) => JSON.stringify({ type: 'client-request', payload: { args: { ns, ops: [] } } })
  assert.equal(settingsWriteDenial(body('ui-theme'), DEFAULT_PREFERENCE_ROWS), undefined)
  assert.match(settingsWriteDenial(body('llm-pi-ai'), DEFAULT_PREFERENCE_ROWS), /administrators/)
  assert.match(settingsWriteDenial('not json', DEFAULT_PREFERENCE_ROWS), /malformed/)
})

test('ingress identity: trusted peer and a user id are both required', () => {
  const req = (addr, headers) => ({ socket: { remoteAddress: addr }, headers })
  assert.equal(ingressIdentity(req('::ffff:172.30.32.2', { 'x-remote-user-id': 'abc' }), ['172.30.32.2']).ok, true)
  assert.equal(ingressIdentity(req('172.30.32.9', { 'x-remote-user-id': 'abc' }), ['172.30.32.2']).status, 403)
  assert.equal(ingressIdentity(req('172.30.32.2', {}), ['172.30.32.2']).status, 401)
  assert.equal(ingressIdentity(req('172.30.32.2', { 'x-remote-user-id': '../x' }), ['172.30.32.2']).status, 401)
})

test('combined plugin URLs survive Home Assistant query re-encoding', () => {
  const raw = '/plugins/??@deepseek-ai/a/client.js,@deepseek-ai/b/client.js&rev=2ee1'
  assert.equal(restoreComboQuery(raw), raw)
  // aiohttp/yarl form (Supervisor and Core): ',' encoded, '=' appended.
  assert.equal(restoreComboQuery('/plugins/??@deepseek-ai/a/client.js%2C@deepseek-ai/b/client.js=&rev=2ee1'), raw)
  // application/x-www-form-urlencoded form.
  const form = `/plugins/?${new URLSearchParams([['?@deepseek-ai/a/client.js,@deepseek-ai/b/client.js', ''], ['rev', '2ee1']])}`
  assert.equal(restoreComboQuery(form), raw)
  assert.equal(restoreComboQuery('/api/file?path=%2Fdata%2Fx'), '/api/file?path=%2Fdata%2Fx')
  assert.equal(restoreComboQuery('/'), '/')
})
