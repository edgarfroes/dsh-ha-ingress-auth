// dsh-ha-ingress-auth host plugin.
//
// Loaded into every per-user `dsh web` child that the gateway spawns, through
// the role overlay the gateway generates (`--patch <runtime>/<role>.patch.yml`).
// It uses only documented dsh extension points:
//   - `webserver/index-inject` rows (a `global` row) to mark the page as owning
//     its Host, so the Settings screens persist behind a non-loopback proxy;
//   - `connection.authenticatedUrl()` to hand the gateway a launch URL, so the
//     browser never holds a dsh credential;
//   - `ctx.tools.guard()` to deny every tool outside an allow-list for
//     non-admin children.

import { writeFileSync, renameSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export const name = 'dsh-ha-ingress-auth'

export const inject = ['webServer', 'connection']

/** Tools a non-admin child may run. Anything else, including tools added by a
 * later dsh release, is denied: an allow-list fails safe. */
export const DEFAULT_USER_TOOLS = Object.freeze([
  'ask_user_question',
  'web_search',
  'web_fetch',
  'todo_write',
  'create_goal',
  'get_goal',
  'update_goal',
  'exit_plan_mode',
  'present',
])

/** Hide every Settings nav cell after the first (General). The anchor is the
 * `settings.header` slot, a public slot name, not a generated class. */
export const GENERAL_ONLY_STYLE = 'nav:has([data-slot="settings.header"]) button:not(:first-child){display:none!important}'

/**
 * Normalise the row config. The loader passes it verbatim; there is no schema
 * dependency so the plugin needs nothing beyond the running dsh.
 * @param {Record<string, unknown>} [raw]
 */
export function resolveConfig(raw = {}) {
  const role = raw.role === 'admin' ? 'admin' : 'user'
  const userTools = Array.isArray(raw.userTools)
    ? raw.userTools.filter((t) => typeof t === 'string')
    : [...DEFAULT_USER_TOOLS]
  return {
    role,
    handshakeFile: typeof raw.handshakeFile === 'string' ? raw.handshakeFile : undefined,
    ownsHost: raw.ownsHost !== false,
    userTools,
    identity: typeof raw.identity === 'object' && raw.identity !== null ? raw.identity : undefined,
    // Non-admins keep Settings → General only. dsh builds the Settings nav
    // from every registered section, so the Agent presets section (which ships
    // in the same plugin as the new-chat preset picker) is hidden by style.
    generalSettingsOnly: raw.generalSettingsOnly === undefined ? role === 'user' : raw.generalSettingsOnly === true,
  }
}

/**
 * Build the guard used for non-admin children.
 * @param {readonly string[]} allowed
 * @returns {(execution: { name: string }) => string | undefined}
 */
export function makeUserToolGuard(allowed) {
  const set = new Set(allowed)
  return (execution) => set.has(execution.name)
    ? undefined
    : `The tool "${execution.name}" is available to Home Assistant administrators only.`
}

function writeAtomic(path, text) {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, text, { mode: 0o600 })
  renameSync(tmp, path)
}

/**
 * @param {any} ctx - Cordis context.
 * @param {Record<string, unknown>} rawConfig
 */
export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)
  const log = ctx.logger ? ctx.logger(name) : console

  if (config.ownsHost) {
    // Each child is only ever reached through the gateway by the one HA user it
    // belongs to, so the page does own this Host.
    ctx.on('webserver/index-inject', (table) => {
      table.push({ kind: 'global', name: '__DSH_TRANSPORT__', value: { ownsHost: true } })
    })
  }

  if (config.generalSettingsOnly) {
    ctx.on('webserver/index-inject', (table) => {
      table.push({ kind: 'style', text: GENERAL_ONLY_STYLE })
    })
  }

  if (config.identity) {
    const identity = config.identity
    ctx.on('webserver/index-inject', (table) => {
      table.push({ kind: 'global', name: '__DSH_HA_IDENTITY__', value: identity })
    })
  }

  if (config.handshakeFile) {
    const file = config.handshakeFile
    ctx.effect(() => {
      // The web server listens on activation; wait a tick so `port` is set.
      const timer = setTimeout(() => {
        try {
          const port = ctx.webServer.port
          const url = ctx.connection.authenticatedUrl(`http://127.0.0.1:${port}/`)
          writeAtomic(file, `${JSON.stringify({ url, port, pid: process.pid })}\n`)
        } catch (error) {
          log.warn?.(`handshake failed: ${error instanceof Error ? error.message : String(error)}`)
        }
      }, 0)
      return () => clearTimeout(timer)
    })
  }

  if (config.role === 'user') {
    const guard = makeUserToolGuard(config.userTools)
    ctx.inject(['tools'], (toolsCtx) => {
      toolsCtx.effect(() => toolsCtx.tools.guard(guard))
    })
  }
}
