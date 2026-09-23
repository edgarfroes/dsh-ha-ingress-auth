#!/usr/bin/env node
// dsh-ha-gateway: entry point of the Home Assistant app.

import { existsSync, readFileSync, mkdirSync, chmodSync, chownSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { Layout } from './layout.js'
import { UserDirectory, fetchUsersOverWebSocket } from './roles.js'
import { ChildManager, UidMap } from './children.js'
import { SharedConfig } from './shared-config.js'
import { buildOverlay } from './overlays.js'
import { createGatewayServer, archiveDeletedUsers } from './server.js'
import { isBusy } from './busy.js'

const { values } = parseArgs({
  options: {
    data: { type: 'string', default: process.env.DSH_HA_DATA ?? '/data' },
    port: { type: 'string', default: process.env.DSH_HA_PORT ?? '8099' },
    host: { type: 'string', default: '0.0.0.0' },
    'trusted-peer': { type: 'string', multiple: true },
    'core-ws': { type: 'string', default: process.env.DSH_HA_CORE_WS ?? 'ws://supervisor/core/websocket' },
    'dsh-bin': { type: 'string', default: process.env.DSH_HA_DSH_BIN },
    'no-isolate': { type: 'boolean', default: false },
    'admin-uid': { type: 'string', default: '20000' },
    'first-user-uid': { type: 'string', default: '20001' },
  },
})

const log = (line) => process.stdout.write(`${new Date().toISOString()} ${line}\n`)

function findDshBin() {
  if (values['dsh-bin']) return values['dsh-bin']
  let dir = dirname(fileURLToPath(import.meta.url))
  for (;;) {
    const candidate = join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
    if (existsSync(candidate)) return candidate
    const parent = dirname(dir)
    if (parent === dir) throw new Error('cannot find @deepseek-ai/dsh; pass --dsh-bin')
    dir = parent
  }
}

/** App options set in the Home Assistant UI (`/data/options.json`). */
function readOptions(dataRoot) {
  const file = join(dataRoot, 'options.json')
  if (!existsSync(file)) return {}
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return {} }
}

const layout = new Layout(values.data)
const options = readOptions(values.data)
const envNumber = (name) => (process.env[name] !== undefined && process.env[name] !== '' && Number.isFinite(Number(process.env[name])) ? Number(process.env[name]) : undefined)
const idleMinutes = envNumber('DSH_HA_IDLE_MINUTES') ?? (Number.isFinite(options.idle_timeout_minutes) ? options.idle_timeout_minutes : 30)
const cullIntervalMs = envNumber('DSH_HA_CULL_INTERVAL_MS') ?? 30000
const archiveIntervalMs = envNumber('DSH_HA_ARCHIVE_INTERVAL_MS') ?? 5 * 60000
const userTools = Array.isArray(options.user_tools) && options.user_tools.length > 0 ? options.user_tools : undefined
const trustedPeers = values['trusted-peer'] ?? (process.env.DSH_HA_TRUSTED_PEERS?.split(',') ?? ['172.30.32.2'])
const isolate = !values['no-isolate'] && typeof process.getuid === 'function' && process.getuid() === 0
const token = process.env.SUPERVISOR_TOKEN

for (const dir of [layout.dataRoot, layout.sharedRoot, layout.usersRoot, layout.runtimeRoot]) mkdirSync(dir, { recursive: true })
// users/ is traversable but not listable: a user's process cannot enumerate
// other HA user ids.
chmodSync(layout.usersRoot, 0o711)
chmodSync(layout.runtimeRoot, 0o755)
mkdirSync(join(layout.runtimeRoot, 'overlays'), { recursive: true, mode: 0o755 })
mkdirSync(layout.adminRoot, { recursive: true })
if (isolate) {
  // Admin processes run as one uid and keep the shared credentials file here;
  // non-admin uids cannot enter it.
  chmodSync(layout.sharedRoot, 0o711)
  chownSync(layout.adminRoot, Number(values['admin-uid']), Number(values['admin-uid']))
  chmodSync(layout.adminRoot, 0o700)
}

if (!token) log('[gateway] SUPERVISOR_TOKEN is not set: every user will be refused until it is (homeassistant_api: true)')

const directory = new UserDirectory({
  fetchUsers: () => {
    if (!token) return Promise.reject(new Error('SUPERVISOR_TOKEN missing'))
    return fetchUsersOverWebSocket({ url: values['core-ws'], token })
  },
})

const uids = isolate ? new UidMap({ file: layout.uids, adminUid: Number(values['admin-uid']), firstUserUid: Number(values['first-user-uid']) }) : undefined
const dshBin = findDshBin()

// Variables a child may inherit. Everything else — above all SUPERVISOR_TOKEN,
// which acts as Home Assistant's admin-level Supervisor user — is dropped.
const PASS_ENV = ['PATH', 'LANG', 'LC_ALL', 'TZ', 'NODE_OPTIONS', 'NODE_EXTRA_CA_CERTS', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY']

/** @type {SharedConfig} */
let shared
const children = new ChildManager({
  layout,
  isolate,
  uids,
  log,
  dshCommand: [process.execPath, dshBin],
  buildOverlay: (child, handshakeFile) => buildOverlay({
    role: child.role,
    handshakeFile,
    identity: { role: child.role },
    sharedCredentialsFile: layout.sharedCredentials,
    documentsDirectory: layout.user(child.key).workspace,
    userTools,
  }),
  prepare: (child) => (child.role === 'admin' ? shared.prepareAdmin(child) : shared.prepareUser(child)),
  childEnv: (child) => {
    const paths = layout.user(child.key)
    const env = {}
    for (const name of PASS_ENV) if (process.env[name] !== undefined) env[name] = process.env[name]
    env.HOME = paths.home
    env.DSH_HOME = paths.home
    if (child.role === 'user') Object.assign(env, shared.credentialEnv())
    return env
  },
})

shared = new SharedConfig({
  layout,
  log,
  children: () => children.children.values(),
  onCredentialsChanged: () => {
    log('[gateway] shared credentials changed; non-admin processes restart when idle')
    children.restartUsersWhenIdle()
  },
})

const server = createGatewayServer({ trustedPeers, directory, children, layout, log })
server.listen(Number(values.port), values.host, () => {
  log(`[gateway] listening on ${values.host}:${values.port}; trusted ingress peers: ${trustedPeers.join(', ')}; uid isolation: ${isolate ? 'on' : 'off'}; idle timeout for non-admins: ${idleMinutes} min`)
})

const timers = [
  setInterval(() => { shared.tick().catch((error) => log(`[gateway] sync failed: ${error.message}`)) }, 2000),
  setInterval(() => {
    children.cull({ idleMs: idleMinutes * 60000, isBusy }).catch((error) => log(`[gateway] cull failed: ${error.message}`))
  }, cullIntervalMs),
  setInterval(() => {
    archiveDeletedUsers({ directory, children, layout, log }).catch((error) => log(`[gateway] archive check failed: ${error.message}`))
  }, archiveIntervalMs),
]

let stopping = false
async function shutdown(signal) {
  if (stopping) return
  stopping = true
  log(`[gateway] ${signal}: stopping`)
  for (const t of timers) clearInterval(t)
  server.close()
  await children.stopAll()
  process.exit(0)
}
process.on('SIGTERM', () => { shutdown('SIGTERM') })
process.on('SIGINT', () => { shutdown('SIGINT') })
