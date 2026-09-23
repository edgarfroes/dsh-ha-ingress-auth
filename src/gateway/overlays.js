// The `--patch` overlay each child boots with. It is the last layer, so its
// rows win over anything in the child's own profile or home patch; that is
// where everything security-relevant goes.

import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { dumpPatch } from './patches.js'

export const HOST_PLUGIN_PATH = fileURLToPath(new URL('../plugin/host.js', import.meta.url))

/** Rows a non-admin child does not load. Each id is a row the shipped web-app
 * bundle mounts; `disabled: true` is the same mechanism the bundle itself uses. */
export const DEFAULT_USER_DISABLED_ROWS = Object.freeze([
  'ui-settings-models', // Settings → Models (+ onboarding cells)
  'ui-settings-plugins', // Settings → Plugins
  'ui-settings-shell', //   plugin cards inside Settings → Plugins
  'ui-settings-agent-loop',
  'ui-settings-subagent',
  'ui-settings-web-search',
  'ui-settings-plugin-inventory',
  'ui-plugin-manager', // sidebar "Plugins" page
  'plugin-manager', // host-side package installs
  'ui-settings-account', // DeepSeek platform account
  'ui-permission', // Settings → General → Permission and the /permission picker
  'ui-sidebar-terminal', // the sidebar terminal is a shell
  'terminal-controller', //   and its host side
  'workspace-files', // file preview reads any path the process can read
  'ui-sidebar-files', //   its sidebar panel
  'ui-sidebar-documentpreview', //   and document preview
  'office-to-pdf', //   which converts host files for that preview
  'directory-picker', // browsing host folders to add workspaces
  'ui-deliverables', // lists files the agent wrote; needs file preview
])

/** Language packs every child loads, whatever its role. Each is a client
 * plugin package installed in the app runtime; dsh serves its browser bundle
 * and lists the language in Settings → General → Language, where each user
 * picks their own (the `locale` row stays a per-user preference). */
export const LANGUAGE_PACKS = Object.freeze(['dsh-locale-pt-br'])

const requireHere = createRequire(import.meta.url)

/**
 * Loader rows for the installed language packs. dsh resolves a bare row name
 * from the overlay file's own directory, where no packages are installed, so
 * each row names the package entry by absolute path (as the host plugin row
 * does); dsh finds the package, and its client bundle, from there. A pack that
 * is not installed is left out.
 * @param {readonly string[]} [packs]
 * @param {(name: string) => string} [resolve]
 */
export function languagePackRows(packs = LANGUAGE_PACKS, resolve = (name) => requireHere.resolve(name)) {
  const rows = []
  for (const name of packs) {
    let entry
    try { entry = resolve(name) } catch { continue }
    rows.push({ id: name, name: entry })
  }
  return rows
}

/**
 * @param {{
 *   role: 'admin' | 'user',
 *   handshakeFile: string,
 *   identity?: { name?: string, role: string },
 *   sharedCredentialsFile?: string,
 *   documentsDirectory?: string,
 *   userDisabledRows?: readonly string[],
 *   userTools?: readonly string[],
 *   mcpServers?: readonly { serverName: string, url: string }[],
 *   extraRows?: any[],
 *   languagePackRows?: { id: string, name: string }[],
 * }} opts
 */
export function buildOverlay(opts) {
  const pluginConfig = {
    role: opts.role,
    handshakeFile: opts.handshakeFile,
    ownsHost: true,
  }
  if (opts.identity) pluginConfig.identity = opts.identity
  if (opts.role === 'user' && opts.userTools) pluginConfig.userTools = [...opts.userTools]

  const rows = [
    { insert: [{ id: 'dsh-ha-ingress-auth', name: HOST_PLUGIN_PATH, config: pluginConfig }, ...(opts.languagePackRows ?? languagePackRows())] },
    // One dsh-mcp-client entry per configured remote MCP server. This overlay
    // is the last layer, so every role gets them; an unreachable server only
    // logs a warning (failOnStartupError defaults to false).
    ...buildMcpRows(opts.mcpServers),
  ]
  if (opts.documentsDirectory) {
    // dsh creates the first workspace under the OS "Documents" folder; keep it
    // inside this user's own data directory instead.
    rows.push({
      id: 'workspace-controller',
      name: '@deepseek-ai/dsh-api-workspace-controller',
      config: { documentsDirectory: opts.documentsDirectory },
    })
  }
  if (opts.role === 'admin') {
    if (opts.sharedCredentialsFile) {
      rows.push({
        id: 'credentials',
        name: '@deepseek-ai/dsh-credentials-local',
        config: { path: opts.sharedCredentialsFile },
      })
    }
  } else {
    for (const id of opts.userDisabledRows ?? DEFAULT_USER_DISABLED_ROWS) rows.push({ id, disabled: true })
    // Developer tools stay off for non-admins; the switch is hidden (host.js)
    // and this overlay outranks anything the user saves.
    rows.push({ id: 'ui-settings', name: '@deepseek-ai/dsh-client-ui-settings', config: { enabled: false } })
  }
  for (const row of opts.extraRows ?? []) rows.push(row)
  return dumpPatch(rows, '# Generated by the dsh-ha-ingress-auth gateway for each child launch.\n')
}

/** dsh-mcp-client requires this exact shape for the tool namespace. */
const MCP_SERVER_NAME_RE = /^[A-Za-z0-9_-]{1,32}$/
const MCP_URL_RE = /^https?:\/\/\S+$/

/**
 * Parse the `mcp_servers` app option: the add-on config UI collects it as a
 * repeatable name/URL pair, so entries arrive as `{ name, url }` objects. A
 * comma-separated `name=url` string (or a list of such strings) is accepted
 * too; `#` comments and empty string items ignored.
 * @param {unknown} raw
 * @returns {{ serverName: string, url: string }[]}
 * @throws on a malformed entry, a bad server name, or a duplicate name
 */
export function parseMcpServers(raw) {
  let entries
  if (raw === undefined || raw === null) entries = []
  else if (Array.isArray(raw)) entries = raw
  else if (typeof raw === 'string' && raw.trim() === '') entries = []
  else if (typeof raw === 'string') entries = raw.split(/[\n,]+/)
  else throw new Error('expected a list of servers or comma-separated "name=url" entries')
  const servers = []
  const seen = new Set()
  const add = (serverName, url, what) => {
    if (!MCP_SERVER_NAME_RE.test(serverName) || !MCP_URL_RE.test(url)) {
      throw new Error(`expected a name ([A-Za-z0-9_-]{1,32}) and an http(s) url in ${what}`)
    }
    if (seen.has(serverName)) throw new Error(`duplicate server name "${serverName}"`)
    seen.add(serverName)
    servers.push({ serverName, url })
  }
  for (const entry of entries) {
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      add(
        typeof entry.name === 'string' ? entry.name.trim() : '',
        typeof entry.url === 'string' ? entry.url.trim() : '',
        JSON.stringify(entry),
      )
      continue
    }
    if (typeof entry !== 'string') {
      throw new Error(`each mcp_servers entry must be a name/url pair or a "name=url" string, got ${typeof entry}`)
    }
    const text = entry.split('#', 1)[0].trim()
    if (text === '') continue
    const eq = text.indexOf('=')
    add(eq === -1 ? '' : text.slice(0, eq).trim(), eq === -1 ? '' : text.slice(eq + 1).trim(), JSON.stringify(text))
  }
  return servers
}

/**
 * One dsh-mcp-client plugin entry per configured server. `name` is a package
 * specifier resolved by the dsh launcher against the app image's node_modules.
 * @param {readonly { serverName: string, url: string }[]} [servers]
 * @returns {any[]}
 */
export function buildMcpRows(servers) {
  return (servers ?? []).map(({ serverName, url }) => ({
    insert: [{
      id: `mcp-${serverName}`,
      name: '@deepseek-ai/dsh-mcp-client',
      config: { serverName, transport: 'streamable-http', url },
    }],
  }))
}
