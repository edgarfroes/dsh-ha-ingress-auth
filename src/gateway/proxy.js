// HTTP and WebSocket forwarding from the ingress side to one user's dsh child.

import { request as httpRequest } from 'node:http'
import { connect } from 'node:net'
import { resolve as resolvePath, sep } from 'node:path'

/** Request headers never forwarded to a child: identity and proxy plumbing
 * (the child must not see HA credentials) and every browser cookie (the child
 * gets only its own session cookie from the gateway's jar). */
const DROP_REQUEST_HEADERS = new Set([
  'cookie', 'host', 'origin', 'referer', 'connection', 'keep-alive', 'proxy-connection',
  'x-remote-user-id', 'x-remote-user-name', 'x-remote-user-display-name',
  'x-ingress-path', 'x-hass-source', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto',
  'x-supervisor-token', 'x-hassio-key', 'authorization',
])

/**
 * Headers for the child: loopback Host/Origin (dsh's trust fence accepts
 * those), the child's cookie, and whatever else the browser sent.
 * @param {import('node:http').IncomingHttpHeaders} headers
 * @param {{ port: number, cookie: string }} child
 * @param {{ upgrade?: boolean }} [opts]
 */
export function childRequestHeaders(headers, child, opts = {}) {
  /** @type {Record<string, string | string[]>} */
  const out = {}
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || DROP_REQUEST_HEADERS.has(name)) continue
    if (!opts.upgrade && (name === 'upgrade')) continue
    out[name] = value
  }
  const authority = `127.0.0.1:${child.port}`
  out.host = authority
  if (headers.origin !== undefined) out.origin = `http://${authority}`
  // The gateway has already checked where the request came from; a
  // same-origin iframe request is never cross-site, but be explicit.
  if (out['sec-fetch-site'] === 'cross-site') delete out['sec-fetch-site']
  out.cookie = child.cookie
  if (opts.upgrade) out.connection = 'Upgrade'
  return out
}

/** Response headers never passed back to the browser. */
const DROP_RESPONSE_HEADERS = new Set(['set-cookie', 'connection', 'keep-alive'])

/**
 * Paths a non-admin may not call even though their UI never offers them.
 * Unary dsh calls are `POST api/<namespace>/<method>`.
 */
export const DEFAULT_USER_DENIED_PATHS = Object.freeze([
  /^\/api\/credentials\/(set|unset)$/,
  /^\/api\/llm\/discoverModels$/,
  /^\/api\/agentPresets\/(copy|deletePreset|openDirectory)$/,
  /^\/api\/settings\/(openSettingsDocument|openAgentPresetDirectory)$/,
  /^\/api\/pluginManager\//,
  /^\/api\/plugin-manager\//,
  /^\/api\/cordis\//,
  /^\/api\/dynamicCordisRunner\/(invoke|getClientCode|define|run|stop|undefine)$/,
  /^\/api\/terminal\//,
])

/** Settings writes are allowed for non-admins only on their own preference
 * sections; every other namespace is shared configuration. */
export const SETTINGS_WRITE_PATH = /^\/api\/settings\/(mutate|update|replace)$/

/**
 * @param {string} body raw request body of a settings write
 * @param {Iterable<string>} preferenceRows
 * @returns {string | undefined} a reason when denied
 */
export function settingsWriteDenial(body, preferenceRows) {
  let ns
  try { ns = JSON.parse(body)?.payload?.args?.ns } catch { return 'malformed settings write' }
  if (typeof ns !== 'string') return 'malformed settings write'
  return new Set(preferenceRows).has(ns) ? undefined : `settings "${ns}" can be changed by Home Assistant administrators only`
}

/**
 * Undo Home Assistant ingress's query re-encoding for dsh's combined plugin
 * URLs. dsh loads client bundles as `plugins/??@a/client.js,@b/client.js&rev=…`
 * (a query that itself starts with `?`). Supervisor and Core forward HTTP
 * queries as parsed parameters (aiohttp `params=request.query`), which turns
 * that first, value-less parameter into `?@a/client.js%2C@b/client.js=` or a
 * fully percent-encoded form; dsh then answers 404. Other queries are left alone.
 * @param {string} url request path + query
 */
export function restoreComboQuery(url) {
  const i = url.indexOf('?')
  if (i < 0) return url
  const parts = url.slice(i + 1).split('&')
  let first
  try { first = decodeURIComponent(parts[0].replace(/\+/g, ' ')) } catch { return url }
  if (!first.startsWith('?')) return url
  if (first.endsWith('=')) first = first.slice(0, -1)
  parts[0] = first
  return `${url.slice(0, i)}?${parts.join('&')}`
}

/**
 * Decide whether a non-admin request is allowed.
 * @param {string} rawUrl request URL (path + query) as the child would see it
 * @param {string} userRoot the user's data directory
 * @param {readonly RegExp[]} denied
 * @returns {string | undefined} a reason when denied
 */
export function userRequestDenial(rawUrl, userRoot, denied = DEFAULT_USER_DENIED_PATHS) {
  let url
  try { url = new URL(rawUrl, 'http://child.invalid') } catch { return 'bad request URL' }
  const path = url.pathname
  for (const re of denied) if (re.test(path)) return `${path} is available to Home Assistant administrators only`
  if (path === '/api/file') {
    // dsh serves any absolute path its process can read here; confine it.
    const target = url.searchParams.get('path')
    if (!target) return 'missing path'
    const full = resolvePath(target)
    const root = resolvePath(userRoot)
    if (full !== root && !full.startsWith(root + sep)) return 'file outside your own folder'
  }
  return undefined
}

/**
 * Forward one HTTP request.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {{ port: number, cookie: string }} child
 * @param {{ onDone?: () => void }} [hooks]
 */
export function forwardHttp(req, res, child, hooks = {}, body = undefined) {
  const upstream = httpRequest({
    host: '127.0.0.1',
    port: child.port,
    method: req.method,
    path: restoreComboQuery(req.url ?? '/'),
    headers: childRequestHeaders(req.headers, child),
  }, (up) => {
    /** @type {Record<string, string | string[]>} */
    const headers = {}
    for (const [name, value] of Object.entries(up.headers)) {
      if (value === undefined || DROP_RESPONSE_HEADERS.has(name)) continue
      headers[name] = value
    }
    res.writeHead(up.statusCode ?? 502, up.statusMessage, headers)
    up.pipe(res)
    up.on('end', () => hooks.onDone?.())
  })
  upstream.on('error', (error) => {
    hooks.onDone?.()
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
      res.end(`dsh is not reachable: ${error.message}\n`)
    } else res.destroy(error)
  })
  req.on('aborted', () => upstream.destroy())
  if (body !== undefined) upstream.end(body)
  else req.pipe(upstream)
}

/** Read a small request body. @param {import('node:http').IncomingMessage} req */
export function readSmallBody(req, limit = 1 << 20) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (c) => {
      size += c.length
      if (size > limit) { reject(new Error('request body too large')); req.destroy(); return }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

/**
 * Forward one WebSocket upgrade by splicing sockets after rewriting the
 * request head.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:stream').Duplex} socket
 * @param {Buffer} head
 * @param {{ port: number, cookie: string }} child
 * @param {{ onClose?: () => void, onActivity?: () => void }} [hooks]
 */
export function forwardUpgrade(req, socket, head, child, hooks = {}) {
  const upstream = connect(child.port, '127.0.0.1')
  let closed = false
  const close = () => {
    if (closed) return
    closed = true
    socket.destroy()
    upstream.destroy()
    hooks.onClose?.()
  }
  upstream.on('connect', () => {
    const headers = childRequestHeaders(req.headers, child, { upgrade: true })
    let text = `${req.method} ${req.url} HTTP/1.1\r\n`
    for (const [name, value] of Object.entries(headers)) {
      for (const v of Array.isArray(value) ? value : [value]) text += `${name}: ${v}\r\n`
    }
    upstream.write(`${text}\r\n`)
    if (head && head.length) upstream.write(head)
    upstream.pipe(socket)
    socket.pipe(upstream)
  })
  if (hooks.onActivity) {
    socket.on('data', hooks.onActivity)
    upstream.on('data', hooks.onActivity)
  }
  upstream.on('error', close)
  socket.on('error', close)
  upstream.on('close', close)
  socket.on('close', close)
}
