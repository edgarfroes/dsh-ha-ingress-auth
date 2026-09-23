// A stand-in for the parts of Home Assistant the app talks to, for E2E tests
// that must run anywhere (CI included) without a real Supervisor:
//
//   :8080  ingress  /api/hassio_ingress/<token>/…  → gateway, with X-Remote-User-*
//                   taken from a test login cookie (Supervisor's contract: the
//                   browser's own X-Remote-* headers are dropped)
//          panel    /panel  an iframe around the ingress URL, like HA's sidebar panel
//          login    /login?user=<username>  /logout
//          core ws  /core/websocket  auth + config/auth/list (Supervisor's Core proxy)
//          control  POST /__test/users  replace the user list (role changes, deletions)
//   :8081  stub LLM  OpenAI-compatible /v1/models and /v1/chat/completions
//
// All data is synthetic. Nothing here reads the environment it runs in beyond
// the variables below.

import { createServer, request as httpRequest } from 'node:http'
import { connect } from 'node:net'
import { WebSocketServer } from 'ws'

const GATEWAY = new URL(process.env.GATEWAY_URL ?? 'http://127.0.0.1:8099')
const INGRESS_TOKEN = process.env.INGRESS_TOKEN ?? 'e2e-ingress-token'
const CORE_TOKEN = process.env.CORE_TOKEN ?? 'e2e-supervisor-token'
const PORT = Number(process.env.PORT ?? 8080)
const LLM_PORT = Number(process.env.LLM_PORT ?? 8081)
const LISTEN = process.env.LISTEN ?? '0.0.0.0'

/** Synthetic HA users (the shape of Core's config/auth/list). */
let users = [
  { id: 'a0000000000000000000000000000001', username: 'owner', name: 'Owner Admin', is_owner: true, is_active: true, system_generated: false, group_ids: ['system-admin'] },
  { id: 'a0000000000000000000000000000002', username: 'admin2', name: 'Second Admin', is_owner: false, is_active: true, system_generated: false, group_ids: ['system-admin'] },
  { id: 'b0000000000000000000000000000001', username: 'alice', name: 'Alice', is_owner: false, is_active: true, system_generated: false, group_ids: ['system-users'] },
  { id: 'b0000000000000000000000000000002', username: 'bob', name: 'Bob', is_owner: false, is_active: true, system_generated: false, group_ids: ['system-users'] },
  { id: 'c0000000000000000000000000000001', username: 'reader', name: 'Read Only', is_owner: false, is_active: true, system_generated: false, group_ids: ['system-read-only'] },
  { id: 'd0000000000000000000000000000001', username: 'supervisor', name: 'Supervisor', is_owner: false, is_active: true, system_generated: true, group_ids: ['system-admin'] },
]

const INGRESS_PREFIX = `/api/hassio_ingress/${INGRESS_TOKEN}`

function cookieUser(req) {
  const header = req.headers.cookie ?? ''
  const match = /(?:^|;\s*)fake_ha_user=([^;]+)/.exec(header)
  if (!match) return undefined
  return users.find((u) => u.username === decodeURIComponent(match[1]))
}

function ingressHeaders(req, user) {
  const headers = { ...req.headers }
  for (const name of Object.keys(headers)) {
    if (name.startsWith('x-remote-user-') || name === 'x-supervisor-token' || name === 'x-hassio-key') delete headers[name]
  }
  headers['x-remote-user-id'] = user.id
  if (user.username) headers['x-remote-user-name'] = user.username
  if (user.name) headers['x-remote-user-display-name'] = user.name
  headers['x-ingress-path'] = INGRESS_PREFIX
  headers['x-hass-source'] = 'core.ingress'
  headers['x-forwarded-for'] = req.socket.remoteAddress ?? ''
  headers.host = GATEWAY.host
  return headers
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (c) => { body += c })
    req.on('end', () => resolve(body))
  })
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://fake-ha')
  if (url.pathname === '/login') {
    const username = url.searchParams.get('user') ?? ''
    res.writeHead(302, { 'set-cookie': `fake_ha_user=${encodeURIComponent(username)}; Path=/; HttpOnly; SameSite=Strict`, location: '/panel' })
    res.end()
    return
  }
  if (url.pathname === '/logout') {
    res.writeHead(302, { 'set-cookie': 'fake_ha_user=; Path=/; Max-Age=0', location: '/' })
    res.end()
    return
  }
  if (url.pathname === '/panel') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(`<!doctype html><title>Home Assistant (fake)</title><style>html,body,iframe{margin:0;border:0;width:100%;height:100%}</style>
<iframe id="panel" title="DeepSeek Harness" src="${INGRESS_PREFIX}/" allow="clipboard-read; clipboard-write"></iframe>`)
    return
  }
  if (url.pathname === '/__test/users') {
    if (req.method === 'POST') users = JSON.parse(await readBody(req))
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(users))
    return
  }
  if (url.pathname === '/health') { res.writeHead(200); res.end('ok'); return }
  if (url.pathname === INGRESS_PREFIX || url.pathname.startsWith(`${INGRESS_PREFIX}/`)) {
    const user = cookieUser(req)
    if (!user) { res.writeHead(401); res.end('401: Unauthorized'); return }
    const path = (req.url ?? '/').slice(INGRESS_PREFIX.length) || '/'
    const upstream = httpRequest({ host: GATEWAY.hostname, port: GATEWAY.port, method: req.method, path, headers: ingressHeaders(req, user) }, (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers)
      up.pipe(res)
    })
    upstream.on('error', (e) => { if (!res.headersSent) { res.writeHead(502); res.end(String(e)) } })
    req.pipe(upstream)
    return
  }
  res.writeHead(404)
  res.end('not found')
})

// WebSocket through ingress: splice sockets after rewriting the head.
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '/', 'http://fake-ha')
  if (url.pathname === '/core/websocket') {
    coreWss.handleUpgrade(req, socket, head, (ws) => coreWss.emit('connection', ws, req))
    return
  }
  const user = cookieUser(req)
  if (!user || !url.pathname.startsWith(`${INGRESS_PREFIX}/`)) { socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n'); return }
  const path = (req.url ?? '/').slice(INGRESS_PREFIX.length) || '/'
  const upstream = connect(Number(GATEWAY.port), GATEWAY.hostname, () => {
    let text = `${req.method} ${path} HTTP/1.1\r\n`
    for (const [k, v] of Object.entries(ingressHeaders(req, user))) {
      for (const one of Array.isArray(v) ? v : [v]) text += `${k}: ${one}\r\n`
    }
    upstream.write(`${text}\r\n`)
    if (head?.length) upstream.write(head)
    upstream.pipe(socket)
    socket.pipe(upstream)
  })
  const close = () => { socket.destroy(); upstream.destroy() }
  upstream.on('error', close)
  socket.on('error', close)
})

// Core WebSocket API (only what the app uses).
const coreWss = new WebSocketServer({ noServer: true })
coreWss.on('connection', (ws) => {
  let authed = false
  ws.send(JSON.stringify({ type: 'auth_required', ha_version: '2026.9.3' }))
  ws.on('message', (data) => {
    const msg = JSON.parse(String(data))
    if (msg.type === 'auth') {
      authed = msg.access_token === CORE_TOKEN
      ws.send(JSON.stringify({ type: authed ? 'auth_ok' : 'auth_invalid', ha_version: '2026.9.3' }))
      if (!authed) ws.close()
      return
    }
    if (!authed) return
    if (msg.type === 'config/auth/list') ws.send(JSON.stringify({ id: msg.id, type: 'result', success: true, result: users }))
    else ws.send(JSON.stringify({ id: msg.id, type: 'result', success: false, error: { code: 'unknown_command' } }))
  })
})

server.listen(PORT, LISTEN, () => console.log(`fake-ha on ${LISTEN}:${PORT} → gateway ${GATEWAY.href}`))

// ---------------------------------------------------------------------------
// Stub LLM: deterministic, zero tokens.
//   message contains TOOL:<name> <json-args>  → one tool call to <name>
//   after a tool result                        → "tool result: <first 200 chars>"
//   otherwise                                  → "stub reply: <last user text>"

function lastUserText(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role !== 'user') continue
    if (typeof m.content === 'string') return m.content
    if (Array.isArray(m.content)) return m.content.filter((p) => p.type === 'text').map((p) => p.text).join(' ')
  }
  return ''
}

function contentText(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map((p) => p.text ?? '').join(' ')
  return ''
}

function plan(body) {
  const messages = body.messages ?? []
  const last = messages[messages.length - 1]
  if (last?.role === 'tool') return { text: `tool result: ${contentText(last.content).slice(0, 200)}` }
  const text = lastUserText(messages)
  const match = /TOOL:([a-z_]+)\s+(\{.*\})/s.exec(text)
  if (match) return { tool: { name: match[1], args: match[2] } }
  return { text: `stub reply: ${text.replace(/\s+/g, ' ').trim().slice(0, 200)}` }
}

const llm = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://llm')
  if (req.method === 'GET' && url.pathname.endsWith('/models')) {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ object: 'list', data: [{ id: 'stub-model', object: 'model', owned_by: 'e2e' }] }))
    return
  }
  if (req.method === 'POST' && url.pathname.endsWith('/chat/completions')) {
    const body = JSON.parse(await readBody(req) || '{}')
    const p = plan(body)
    const id = `chatcmpl-${Date.now()}`
    const base = { id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: body.model ?? 'stub-model' }
    const usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
    if (!body.stream) {
      const message = p.tool
        ? { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: p.tool.name, arguments: p.tool.args } }] }
        : { role: 'assistant', content: p.text }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ...base, object: 'chat.completion', choices: [{ index: 0, message, finish_reason: p.tool ? 'tool_calls' : 'stop' }], usage }))
      return
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
    const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`)
    if (p.tool) {
      send({ ...base, choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: p.tool.name, arguments: '' } }] }, finish_reason: null }] })
      send({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: p.tool.args } }] }, finish_reason: null }] })
      send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage })
    } else {
      send({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] })
      for (const piece of p.text.match(/.{1,40}/gs) ?? []) send({ ...base, choices: [{ index: 0, delta: { content: piece }, finish_reason: null }] })
      send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage })
    }
    res.end('data: [DONE]\n\n')
    return
  }
  res.writeHead(404)
  res.end()
})
llm.listen(LLM_PORT, LISTEN, () => console.log(`stub LLM on ${LISTEN}:${LLM_PORT}`))
