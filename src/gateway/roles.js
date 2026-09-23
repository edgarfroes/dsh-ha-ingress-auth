// Home Assistant user directory: who is an admin.
//
// Supervisor's ingress headers carry the user id but no role. The role comes
// from Core's `config/auth/list` WebSocket command (admin-only), reached through
// Supervisor's Core proxy with the app's SUPERVISOR_TOKEN. The app therefore
// needs `homeassistant_api: true`.

/** @typedef {{ id: string, name?: string, username?: string, is_owner?: boolean, is_active?: boolean, system_generated?: boolean, group_ids?: string[] }} HaUser */
/** @typedef {'admin' | 'user' | 'denied'} Role */

/**
 * List users over the Core WebSocket API.
 * @param {{ url: string, token: string, timeoutMs?: number, WebSocketImpl?: typeof WebSocket }} opts
 * @returns {Promise<HaUser[]>}
 */
export function fetchUsersOverWebSocket({ url, token, timeoutMs = 10000, WebSocketImpl = globalThis.WebSocket }) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocketImpl(url)
    const timer = setTimeout(() => { finish(new Error('HA users lookup timed out')) }, timeoutMs)
    let done = false
    const finish = (error, value) => {
      if (done) return
      done = true
      clearTimeout(timer)
      try { ws.close() } catch { /* ignore */ }
      if (error) reject(error)
      else resolve(value)
    }
    ws.addEventListener('error', () => finish(new Error('HA users lookup: WebSocket error')))
    ws.addEventListener('close', () => finish(new Error('HA users lookup: WebSocket closed')))
    ws.addEventListener('message', (event) => {
      let msg
      try { msg = JSON.parse(typeof event.data === 'string' ? event.data : event.data.toString()) } catch { return }
      if (msg.type === 'auth_required') ws.send(JSON.stringify({ type: 'auth', access_token: token }))
      else if (msg.type === 'auth_invalid') finish(new Error('HA users lookup: auth_invalid'))
      else if (msg.type === 'auth_ok') ws.send(JSON.stringify({ id: 1, type: 'config/auth/list' }))
      else if (msg.type === 'result' && msg.id === 1) {
        if (msg.success && Array.isArray(msg.result)) finish(undefined, msg.result)
        else finish(new Error(`HA users lookup failed: ${msg.error?.code ?? 'unknown'}`))
      }
    })
  })
}

/**
 * Map an HA user to a role.
 * @param {HaUser | undefined} user
 * @param {{ adminGroup: string, userGroups: readonly string[] }} policy
 * @returns {Role}
 */
export function roleOf(user, policy) {
  if (!user || user.is_active === false || user.system_generated) return 'denied'
  const groups = user.group_ids ?? []
  if (groups.includes(policy.adminGroup)) return 'admin'
  if (groups.some((g) => policy.userGroups.includes(g))) return 'user'
  return 'denied'
}

export class UserDirectory {
  /**
   * @param {{ fetchUsers: () => Promise<HaUser[]>, ttlMs?: number, adminGroup?: string, userGroups?: string[], now?: () => number }} opts
   */
  constructor({ fetchUsers, ttlMs = 60000, adminGroup = 'system-admin', userGroups = ['system-users'], now = Date.now }) {
    this.fetchUsers = fetchUsers
    this.ttlMs = ttlMs
    this.policy = { adminGroup, userGroups }
    this.now = now
    /** @type {Map<string, HaUser> | undefined} */
    this.users = undefined
    this.fetchedAt = 0
    /** @type {Promise<Map<string, HaUser>> | undefined} */
    this.inflight = undefined
  }

  async refresh() {
    if (!this.inflight) {
      this.inflight = this.fetchUsers()
        .then((list) => {
          this.users = new Map(list.map((u) => [u.id, u]))
          this.fetchedAt = this.now()
          return this.users
        })
        .finally(() => { this.inflight = undefined })
    }
    return this.inflight
  }

  /** Users from cache, refreshed when stale.
   * @param {{ force?: boolean }} [opts] */
  async list(opts = {}) {
    if (opts.force || !this.users || this.now() - this.fetchedAt > this.ttlMs) {
      try {
        await this.refresh()
      } catch (error) {
        // Keep serving the last good answer when HA is briefly unreachable.
        if (!this.users) throw error
      }
    }
    return /** @type {Map<string, HaUser>} */ (this.users)
  }

  /** Role for one user id. An unknown id forces one refresh (a user created
   * since the last lookup).
   * @param {string} userId @returns {Promise<{ role: Role, user?: HaUser }>} */
  async resolve(userId) {
    let users = await this.list()
    if (!users.has(userId)) users = await this.list({ force: true })
    const user = users.get(userId)
    return { role: roleOf(user, this.policy), user }
  }
}
