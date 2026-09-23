// One `dsh web` process per Home Assistant user.

import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { existsSync, mkdirSync, readFileSync, rmSync, chownSync, chmodSync, renameSync, statSync, lstatSync, lchownSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { writeFileAtomic } from './patches.js'

/** Directory-safe key for an HA user id (HA ids are hex, but never trust input). */
export function userKey(userId) {
  if (typeof userId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(userId)) throw new Error('invalid user id')
  return userId
}

export function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.unref()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = /** @type {import('node:net').AddressInfo} */ (srv.address())
      srv.close(() => resolve(port))
    })
  })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Short, still unambiguous label for logs (HA ids are 32 hex chars). */
export function tagOf(key) {
  return key.length > 12 ? `${key.slice(0, 6)}…${key.slice(-4)}` : key
}

/** Recursively change the owner of a directory tree (no symlink following).
 * Files the gateway itself manages there (the home patch) stay root-owned. */
export function chownTree(root, uid) {
  const stack = [root]
  while (stack.length) {
    const path = stack.pop()
    const st = lstatSync(path)
    if (st.uid !== 0 || path === root || st.isDirectory()) lchownSync(path, uid, uid)
    if (st.isDirectory()) for (const name of readdirSync(path)) stack.push(join(path, name))
  }
}

/** Redact launch tokens from child output before it reaches the app log. */
export function redact(line) {
  return line.replace(/([?&]token=)[^\s&"']+/g, '$1<redacted>')
}

/**
 * Persistent uid allocation. Admin children share one uid (they share the
 * admin credentials file, which dsh requires to be owner-only); every
 * non-admin HA user gets their own.
 */
export class UidMap {
  /** @param {{ file: string, adminUid: number, firstUserUid: number }} opts */
  constructor({ file, adminUid, firstUserUid }) {
    this.file = file
    this.adminUid = adminUid
    this.firstUserUid = firstUserUid
    this.map = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {}
  }

  /** @param {string} key @param {'admin'|'user'} role */
  uidFor(key, role) {
    if (role === 'admin') return this.adminUid
    if (this.map[key] === undefined) {
      const used = Object.values(this.map)
      this.map[key] = used.length === 0 ? this.firstUserUid : Math.max(...used) + 1
      writeFileAtomic(this.file, `${JSON.stringify(this.map, null, 2)}\n`, { mode: 0o600 })
    }
    return this.map[key]
  }
}

/**
 * @typedef {{
 *   key: string, userId: string, role: 'admin'|'user', uid?: number, port?: number,
 *   proc?: import('node:child_process').ChildProcess, cookie?: string,
 *   ready?: Promise<Child>, lastActivity: number, connections: number,
 *   restartWhenIdle: boolean, stopping: boolean, exited?: Promise<void>,
 * }} Child
 */

export class ChildManager {
  /**
   * @param {{
   *   layout: import('./layout.js').Layout,
   *   dshCommand: string[],
   *   uids?: UidMap,
   *   isolate: boolean,
   *   buildOverlay: (child: Child, handshakeFile: string) => string,
   *   prepare?: (child: Child) => Promise<void> | void,
   *   childEnv: (child: Child) => Record<string, string>,
   *   log: (line: string) => void,
   *   startTimeoutMs?: number,
   *   now?: () => number,
   * }} opts
   */
  constructor(opts) {
    this.opts = opts
    /** @type {Map<string, Child>} */
    this.children = new Map()
    /** @type {Map<string, Promise<unknown>>} */
    this.locks = new Map()
    this.now = opts.now ?? Date.now
  }

  /** @param {string} userId */
  get(userId) { return this.children.get(userKey(userId)) }

  /**
   * Running child for a user, started or restarted as needed. Calls for the
   * same user are serialized, so a burst of requests during a role change can
   * never start two processes for one user.
   * @param {string} userId @param {'admin'|'user'} role @returns {Promise<Child>}
   */
  async ensure(userId, role) {
    const key = userKey(userId)
    const previous = this.locks.get(key) ?? Promise.resolve()
    const run = previous.catch(() => {}).then(() => this.ensureLocked(key, userId, role))
    const tail = run.catch(() => {})
    this.locks.set(key, tail)
    tail.then(() => { if (this.locks.get(key) === tail) this.locks.delete(key) })
    const child = await run
    child.lastActivity = this.now()
    return child
  }

  /** @param {string} key @param {string} userId @param {'admin'|'user'} role */
  async ensureLocked(key, userId, role) {
    let child = this.children.get(key)
    if (child && child.role !== role) {
      this.opts.log(`[gateway] role of ${tagOf(key)} changed ${child.role} -> ${role}; restarting its process`)
      await this.stop(key)
      child = undefined
    }
    if (!child) {
      child = { key, userId, role, lastActivity: this.now(), connections: 0, restartWhenIdle: false, stopping: false }
      this.children.set(key, child)
      const current = child
      child.ready = this.start(child).catch(async (error) => {
        this.opts.log(`[gateway] start of ${tagOf(key)} failed: ${error instanceof Error ? error.message : String(error)}`)
        await this.stop(key, current)
        throw error
      })
    }
    return /** @type {Promise<Child>} */ (child.ready)
  }

  /** @param {Child} child */
  async start(child) {
    const { layout, isolate, uids } = this.opts
    const paths = layout.user(child.key)
    for (const dir of [paths.root, paths.home, paths.workspace]) mkdirSync(dir, { recursive: true })
    if (isolate && uids) {
      child.uid = uids.uidFor(child.key, child.role)
      // A role change moves the user to another uid (admins share one); hand
      // their whole folder over before the process starts.
      if (statSync(paths.root).uid !== child.uid) {
        this.opts.log(`[gateway] giving the data of ${tagOf(child.key)} to uid ${child.uid}`)
        chownTree(paths.root, child.uid)
      }
      for (const dir of [paths.root, paths.home, paths.workspace]) {
        chownSync(dir, child.uid, child.uid)
        chmodSync(dir, 0o700)
      }
    }
    rmSync(paths.handshake, { force: true })
    const overlay = layout.overlay(child.key)
    writeFileAtomic(overlay, this.opts.buildOverlay(child, paths.handshake), { mode: 0o644 })
    await this.opts.prepare?.(child)

    child.port = await freePort()
    const [cmd, ...baseArgs] = this.opts.dshCommand
    const args = [...baseArgs, '--profile', 'web', '--patch', overlay, '--no-open', '--host', '127.0.0.1', '--port', String(child.port)]
    const proc = spawn(cmd, args, {
      cwd: paths.workspace,
      env: this.opts.childEnv(child),
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(isolate && child.uid !== undefined ? { uid: child.uid, gid: child.uid } : {}),
    })
    child.proc = proc
    child.exited = new Promise((resolve) => proc.once('exit', () => resolve()))
    const tag = `[dsh:${tagOf(child.key)}:${child.role}]`
    for (const stream of [proc.stdout, proc.stderr]) {
      let buf = ''
      stream.setEncoding('utf8')
      stream.on('data', (chunk) => {
        buf += chunk
        let i
        while ((i = buf.indexOf('\n')) >= 0) {
          this.opts.log(`${tag} ${redact(buf.slice(0, i))}`)
          buf = buf.slice(i + 1)
        }
      })
    }
    proc.once('exit', (code, signal) => {
      this.opts.log(`${tag} exited (${signal ?? code})`)
      if (this.children.get(child.key) === child) this.children.delete(child.key)
    })

    const deadline = this.now() + (this.opts.startTimeoutMs ?? 90000)
    let handshake
    while (!handshake) {
      if (proc.exitCode !== null || proc.signalCode !== null) throw new Error('dsh exited during startup')
      if (this.now() > deadline) throw new Error('dsh did not become ready in time')
      if (existsSync(paths.handshake)) {
        try { handshake = JSON.parse(readFileSync(paths.handshake, 'utf8')) } catch { /* partial write */ }
        // Only this process's own handshake counts.
        if (handshake && handshake.port !== child.port) handshake = undefined
      }
      if (!handshake) await sleep(200)
    }
    child.cookie = await exchangeLaunchUrl(handshake.url)
    this.opts.log(`${tag} ready on 127.0.0.1:${child.port}`)
    return child
  }

  /** @param {string} key @param {Child} [expected] */
  async stop(key, expected) {
    const child = this.children.get(key)
    if (!child || (expected && child !== expected)) return
    child.stopping = true
    this.children.delete(key)
    const proc = child.proc
    if (proc && proc.exitCode === null && proc.signalCode === null) {
      proc.kill('SIGTERM')
      const killer = setTimeout(() => proc.kill('SIGKILL'), 10000)
      await child.exited
      clearTimeout(killer)
    }
  }

  async stopAll() {
    await Promise.all([...this.children.keys()].map((k) => this.stop(k)))
  }

  /** @param {Child} child */
  touch(child) { child.lastActivity = this.now() }

  /** Mark every non-admin child to restart once idle (new credentials). */
  restartUsersWhenIdle() {
    for (const child of this.children.values()) if (child.role === 'user') child.restartWhenIdle = true
  }

  /**
   * Stop children that are idle. Admin children are never culled (they may run
   * scheduled work); non-admin children stop after `idleMs` with no open
   * connection and no traffic, and never while `isBusy` says a turn is running.
   * @param {{ idleMs: number, restartQuietMs?: number, isBusy?: (child: Child) => Promise<boolean> }} policy
   */
  async cull({ idleMs, restartQuietMs = 10000, isBusy }) {
    const now = this.now()
    for (const child of [...this.children.values()]) {
      if (child.role !== 'user' || child.connections > 0 || !child.cookie) continue
      const quiet = now - child.lastActivity
      const due = (idleMs > 0 && quiet >= idleMs) || (child.restartWhenIdle && quiet >= restartQuietMs)
      if (!due) continue
      if (isBusy && await isBusy(child)) continue
      this.opts.log(`[gateway] stopping idle process of ${tagOf(child.key)}${child.restartWhenIdle ? ' (settings changed)' : ''}`)
      await this.stop(child.key, child)
    }
  }
}

/**
 * Follow a dsh launch URL once and keep the session cookie it sets. The
 * browser never sees this cookie: the gateway adds it to proxied requests.
 * @param {string} url
 */
export async function exchangeLaunchUrl(url) {
  const res = await fetch(url, { redirect: 'manual' })
  const cookies = res.headers.getSetCookie?.() ?? []
  const pair = cookies.map((c) => c.split(';')[0]).find((c) => c.startsWith('dsh-auth-'))
  if (!pair) throw new Error(`dsh launch URL returned no session cookie (HTTP ${res.status})`)
  return pair
}

/**
 * Move a deleted user's data aside instead of deleting it.
 * @param {import('./layout.js').Layout} layout @param {string} key
 */
export function archiveUser(layout, key) {
  const from = layout.user(key).root
  if (!existsSync(from)) return undefined
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const to = join(layout.archiveRoot, `${key}-${stamp}`)
  mkdirSync(layout.archiveRoot, { recursive: true })
  renameSync(from, to)
  return to
}
