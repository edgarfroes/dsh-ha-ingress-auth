// The ingress-facing HTTP server: identity, role, per-user child, forwarding.

import { createServer } from 'node:http'
import { readdirSync, existsSync } from 'node:fs'
import { forwardHttp, forwardUpgrade, userRequestDenial, SETTINGS_WRITE_PATH, settingsWriteDenial, readSmallBody } from './proxy.js'
import { DEFAULT_PREFERENCE_ROWS } from './patches.js'
import { archiveUser, tagOf } from './children.js'

/** `::ffff:172.30.32.2` → `172.30.32.2` */
export function normalizeAddress(address) {
  if (!address) return ''
  return address.startsWith('::ffff:') ? address.slice(7) : address
}

/**
 * Identity of an ingress request, or why it is refused. Supervisor strips any
 * X-Remote-User-* header the browser sends and sets its own, so the headers
 * are trustworthy only on connections from Supervisor's ingress address.
 * @param {import('node:http').IncomingMessage} req @param {readonly string[]} trustedPeers
 * @returns {{ ok: true, userId: string, name?: string } | { ok: false, status: number, reason: string }}
 */
export function ingressIdentity(req, trustedPeers) {
  const peer = normalizeAddress(req.socket.remoteAddress)
  if (!trustedPeers.includes(peer)) return { ok: false, status: 403, reason: 'Requests are accepted only through Home Assistant ingress.' }
  const id = req.headers['x-remote-user-id']
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) {
    return { ok: false, status: 401, reason: 'No Home Assistant user on this request. Open DeepSeek Harness from the Home Assistant sidebar.' }
  }
  const name = req.headers['x-remote-user-display-name'] ?? req.headers['x-remote-user-name']
  return { ok: true, userId: id, name: typeof name === 'string' ? name : undefined }
}

function page(res, status, title, text) {
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
  res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<body style="font-family:system-ui,sans-serif;max-width:36rem;margin:15vh auto;padding:0 1rem;color:#444"><h1 style="font-size:1.3rem">${esc(title)}</h1><p>${esc(text)}</p></body>`)
}

function wantsJson(req) {
  return (req.url ?? '').startsWith('/api/') || (req.headers.accept ?? '').includes('application/json')
}

/**
 * @param {{
 *   trustedPeers: readonly string[],
 *   directory: import('./roles.js').UserDirectory,
 *   children: import('./children.js').ChildManager,
 *   layout: import('./layout.js').Layout,
 *   log: (line: string) => void,
 *   deniedPaths?: readonly RegExp[],
 *   preferenceRows?: readonly string[],
 * }} deps
 */
export function createGatewayServer(deps) {
  const { trustedPeers, directory, children, layout, log } = deps

  /** Shared front half of HTTP and upgrade handling. */
  async function admit(req) {
    const identity = ingressIdentity(req, trustedPeers)
    if (!identity.ok) return identity
    let resolved
    try {
      resolved = await directory.resolve(identity.userId)
    } catch (error) {
      log(`[gateway] user lookup failed: ${error.message}`)
      return { ok: false, status: 503, reason: 'Could not reach Home Assistant to check your account. Try again in a moment.' }
    }
    if (resolved.role === 'denied') {
      return { ok: false, status: 403, reason: 'Your Home Assistant account does not have access to DeepSeek Harness.' }
    }
    const role = resolved.role
    if (role === 'user') {
      const reason = userRequestDenial(req.url ?? '/', layout.user(identity.userId).root, deps.deniedPaths)
      if (reason) return { ok: false, status: 403, reason }
    }
    let child
    try {
      child = await children.ensure(identity.userId, role)
    } catch (error) {
      return { ok: false, status: 502, reason: `DeepSeek Harness failed to start: ${error.message}` }
    }
    return { ok: true, child, role, userId: identity.userId }
  }

  const server = createServer(async (req, res) => {
    if (req.url === '/_dsh_ha/health') {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('ok\n')
      return
    }
    const result = await admit(req)
    if (!result.ok) {
      if (wantsJson(req)) {
        res.writeHead(result.status, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: result.reason }))
      } else page(res, result.status, 'DeepSeek Harness', result.reason)
      return
    }
    const child = result.child
    children.touch(child)
    let body
    if (result.role === 'user' && req.method === 'POST' && SETTINGS_WRITE_PATH.test(new URL(req.url ?? '/', 'http://x').pathname)) {
      try { body = await readSmallBody(req) } catch (error) {
        res.writeHead(413, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: error.message }))
        return
      }
      const reason = settingsWriteDenial(body.toString('utf8'), deps.preferenceRows ?? DEFAULT_PREFERENCE_ROWS)
      if (reason) {
        res.writeHead(403, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: reason }))
        return
      }
    }
    forwardHttp(req, res, child, { onDone: () => children.touch(child) }, body)
  })

  server.on('upgrade', async (req, socket, head) => {
    socket.on('error', () => {})
    const result = await admit(req)
    if (!result.ok) {
      socket.end(`HTTP/1.1 ${result.status} Refused\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
      return
    }
    const child = result.child
    child.connections += 1
    children.touch(child)
    forwardUpgrade(req, socket, head, child, {
      onActivity: () => children.touch(child),
      onClose: () => { child.connections = Math.max(0, child.connections - 1); children.touch(child) },
    })
  })

  return server
}

/**
 * Archive the data of HA users that no longer exist.
 * @param {{ directory: import('./roles.js').UserDirectory, children: import('./children.js').ChildManager, layout: import('./layout.js').Layout, log: (l: string) => void }} deps
 */
export async function archiveDeletedUsers({ directory, children, layout, log }) {
  if (!existsSync(layout.usersRoot)) return []
  const users = await directory.list({ force: true })
  // Never act on an empty or failed listing.
  if (!users || users.size === 0) return []
  const archived = []
  for (const key of readdirSync(layout.usersRoot)) {
    if (users.has(key)) continue
    await children.stop(key)
    const to = archiveUser(layout, key)
    if (to) {
      archived.push(to)
      log(`[gateway] Home Assistant user ${tagOf(key)} no longer exists; archived their data to ${to}`)
    }
  }
  return archived
}
