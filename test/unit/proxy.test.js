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
  // yarl form (Supervisor and Core): characters kept, '=' appended.
  assert.equal(restoreComboQuery('/plugins/??@deepseek-ai/a/client.js,@deepseek-ai/b/client.js=&rev=2ee1'), raw)
  assert.equal(restoreComboQuery('/plugins/??@deepseek-ai/a/client.js='), '/plugins/??@deepseek-ai/a/client.js')
  // Never outside /plugins/, never decoding.
  assert.equal(restoreComboQuery('/api/file?%3Fx%26path%3D%2Fetc%2Fhosts&path=%2Fdata'), '/api/file?%3Fx%26path%3D%2Fetc%2Fhosts&path=%2Fdata')
  assert.equal(restoreComboQuery('/api/file??x=&path=%2Fdata'), '/api/file??x=&path=%2Fdata')
  assert.equal(restoreComboQuery('/'), '/')
})

test('api/file: an encoded separator cannot smuggle a second path past the check', () => {
  const root = '/data/users/u1'
  const smuggled = '/api/file?%3Fx%26path%3D%2Fproc%2Fself%2Fenviron&path=%2Fdata%2Fusers%2Fu1%2Fa.txt'
  // What is checked is what is forwarded; dsh reads the first raw `path`,
  // which here is the user's own file.
  assert.equal(restoreComboQuery(smuggled), smuggled)
  assert.equal(userRequestDenial(smuggled, root), undefined)
  assert.equal(new URL(smuggled, 'http://x').searchParams.getAll('path').length, 1)
  assert.match(userRequestDenial('/api/file?path=%2Fdata%2Fusers%2Fu1%2Fa&path=%2Fproc%2Fself%2Fenviron', root), /exactly one/)
  assert.match(userRequestDenial('/api/file?path=/proc/self/environ', root), /outside/)
  assert.match(userRequestDenial('/api/workspaceFiles/read', root), /administrators/)
  assert.match(userRequestDenial('/api/directoryPicker/list', root), /administrators/)
})
