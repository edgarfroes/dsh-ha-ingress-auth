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

/** Settings → General rows non-admins do not get: Work details and Performance
 * & usage (ui-chat) and Developer tools (ui-settings-general). The rows carry
 * no ids; each is matched by its component's row class as a direct child of
 * the public `settings.general.item` slot, which wraps all General rows. Those class names come from dsh's build and are
 * stable for a pinned version; the E2E suite fails if an upgrade changes them. */
export const USER_HIDDEN_GENERAL_ROWS = Object.freeze(['_2XZxNq_row', 'Pt1bsG_row'])

/**
 * Page script that switches the session list to "In one list" once per
 * browser, before dsh boots. dsh keeps that view in localStorage
 * (`dsh.workspace.view.v5`, whole-state JSON) and writes its own default on the
 * first visit, so "only when absent" would miss existing users: a marker key
 * records that the default was applied, and from then on the user's own
 * choice stands.
 * @param {string} mode dsh group-by id: 'flat' (In one list), 'workspace', 'workspace-tree'
 */
export function groupingDefaultScript(mode) {
  const m = JSON.stringify(mode)
  return `(function(){try{var F='dsh-ha.grouping-default.v1',K='dsh.workspace.view.v5';if(localStorage.getItem(F))return;var s={};try{s=JSON.parse(localStorage.getItem(K)||'{}')||{}}catch(e){}var d={groupBy:'workspace',orderBy:'updated',groupExpansion:{},sessionOrderByAccount:{},archivedFilter:'default'};for(var k in d)if(!(k in s))s[k]=d[k];s.groupBy=${m};localStorage.setItem(K,JSON.stringify(s));localStorage.setItem(F,'1')}catch(e){}})()`
}

export function hiddenRowsStyle(classes) {
  if (classes.length === 0) return ''
  return `${classes.map((c) => `[data-slot="settings.general.item"] > [class~="${c}"]`).join(',')}{display:none!important}`
}

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
    hiddenGeneralRows: Array.isArray(raw.hiddenGeneralRows)
      ? raw.hiddenGeneralRows.filter((c) => typeof c === 'string' && /^[\w-]+$/.test(c))
      : role === 'user' ? [...USER_HIDDEN_GENERAL_ROWS] : [],
    // Non-admins just chat: their session list starts as "In one list".
    defaultGrouping: ['flat', 'workspace', 'workspace-tree'].includes(raw.defaultGrouping)
      ? raw.defaultGrouping
      : raw.defaultGrouping === undefined && role === 'user' ? 'flat' : undefined,
  }
}

/**
 * Build the guard used for non-admin children. An entry ending in `*` (for
 * example `mcp__firecrawl__*`) allows every tool with that name prefix; other
 * entries match exactly. Anything unmatched is denied: an allow-list fails
 * safe.
 * @param {readonly string[]} allowed
 * @returns {(execution: { name: string }) => string | undefined}
 */
export function makeUserToolGuard(allowed) {
  const exact = new Set()
  const prefixes = []
  for (const entry of allowed) {
    if (typeof entry !== 'string') continue
    if (entry.endsWith('*')) prefixes.push(entry.slice(0, -1))
    else exact.add(entry)
  }
  return (execution) => {
    if (exact.has(execution.name)) return undefined
    for (const prefix of prefixes) {
      if (execution.name.startsWith(prefix)) return undefined
    }
    return `The tool "${execution.name}" is available to Home Assistant administrators only.`
  }
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

  if (config.hiddenGeneralRows.length > 0) {
    const text = hiddenRowsStyle(config.hiddenGeneralRows)
    ctx.on('webserver/index-inject', (table) => {
      table.push({ kind: 'style', text })
    })
  }

  if (config.defaultGrouping) {
    const text = groupingDefaultScript(config.defaultGrouping)
    ctx.on('webserver/index-inject', (table) => {
      table.push({ kind: 'script', placement: 'head', text })
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
