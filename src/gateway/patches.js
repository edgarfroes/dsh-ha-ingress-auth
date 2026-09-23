// Reading and writing dsh patch files (top-level YAML arrays of loader rows),
// and the row classification the gateway relies on.

import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, chmodSync, chownSync } from 'node:fs'
import { dirname } from 'node:path'
import yaml from 'js-yaml'

/** `!!js` expressions are kept as opaque tagged scalars so a round trip never
 * evaluates or loses them. */
class JsExpression {
  constructor(source) { this.source = source }
}

const JsType = new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  resolve: (data) => typeof data === 'string',
  construct: (data) => new JsExpression(data),
  instanceOf: JsExpression,
  represent: (value) => value.source,
})

export const PATCH_SCHEMA = yaml.DEFAULT_SCHEMA.extend([JsType])

/** Rows whose values belong to one person (Settings → General preferences).
 * Every other row is shared, admin-owned configuration. Unknown rows default to
 * shared, so a row added by a later dsh release never leaks write access. */
export const DEFAULT_PREFERENCE_ROWS = Object.freeze([
  'ui-theme',
  'locale',
  'ui-chat',
  'ui-conversation',
  'ui-settings-general',
  'ui-settings', // developer tools switch
])

/** @param {string} text @returns {any[]} */
export function parsePatch(text) {
  const doc = yaml.load(text, { schema: PATCH_SCHEMA })
  if (doc === undefined || doc === null) return []
  if (!Array.isArray(doc)) throw new Error('patch file is not a YAML array')
  return doc
}

/** @param {any[]} rows @param {string} [header] */
export function dumpPatch(rows, header = '') {
  const body = rows.length === 0 ? '[]\n' : yaml.dump(rows, { schema: PATCH_SCHEMA, lineWidth: -1, noRefs: true })
  return header + body
}

/** @param {string} path */
export function readPatchFile(path) {
  if (!existsSync(path)) return []
  return parsePatch(readFileSync(path, 'utf8'))
}

/**
 * Atomically replace a file, optionally setting mode and owner.
 * @param {string} path @param {string} text
 * @param {{ mode?: number, uid?: number, gid?: number }} [opts]
 */
export function writeFileAtomic(path, text, opts = {}) {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.gw-${process.pid}-${Date.now()}.tmp`
  writeFileSync(tmp, text, { mode: opts.mode ?? 0o644 })
  if (opts.mode !== undefined) chmodSync(tmp, opts.mode)
  if (opts.uid !== undefined && opts.gid !== undefined) {
    try { chownSync(tmp, opts.uid, opts.gid) } catch { /* not root (dev): ignore */ }
  }
  renameSync(tmp, path)
}

/** Stable key for a patch entry: its `id`, or its JSON for id-less entries
 * such as `insert:` lists. */
export function rowKey(row) {
  if (row && typeof row === 'object' && typeof row.id === 'string') return `id:${row.id}`
  return `json:${stableStringify(row)}`
}

export function stableStringify(value) {
  if (value instanceof JsExpression) return JSON.stringify({ '!!js': value.source })
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

/**
 * Split a profile patch into preference rows and shared (admin) rows.
 * @param {any[]} rows @param {Iterable<string>} preferenceRows
 */
export function splitRows(rows, preferenceRows = DEFAULT_PREFERENCE_ROWS) {
  const prefs = new Set(preferenceRows)
  const preference = []
  const shared = []
  for (const row of rows) {
    if (row && typeof row === 'object' && typeof row.id === 'string' && prefs.has(row.id)) preference.push(row)
    else shared.push(row)
  }
  return { preference, shared }
}

/** @param {any[]} rows @returns {Map<string, any>} */
export function indexRows(rows) {
  const map = new Map()
  for (const row of rows) map.set(rowKey(row), row)
  return map
}

/**
 * Apply the change one admin made (their previous shared rows → their current
 * shared rows) onto the shared store. Rows the admin did not touch keep the
 * store's value, so two admins editing different rows never undo each other.
 * @param {any[]} store @param {any[]} before @param {any[]} after
 * @returns {{ rows: any[], changed: boolean }}
 */
export function applyAdminChange(store, before, after) {
  const s = indexRows(store)
  const b = indexRows(before)
  const a = indexRows(after)
  let changed = false
  for (const [key, row] of a) {
    const prev = b.get(key)
    if (prev === undefined || stableStringify(prev) !== stableStringify(row)) {
      const cur = s.get(key)
      if (cur === undefined || stableStringify(cur) !== stableStringify(row)) {
        s.set(key, row)
        changed = true
      }
    }
  }
  for (const key of b.keys()) {
    if (!a.has(key) && s.has(key)) {
      s.delete(key)
      changed = true
    }
  }
  return { rows: [...s.values()], changed }
}

/**
 * Rebuild one admin's profile patch: their own preference rows plus the shared
 * store, in that order.
 * @param {any[]} own @param {any[]} store @param {Iterable<string>} preferenceRows
 */
export function mergeForAdmin(own, store, preferenceRows = DEFAULT_PREFERENCE_ROWS) {
  const { preference } = splitRows(own, preferenceRows)
  return [...preference, ...store]
}

export const PROFILE_PATCH_HEADER = `# Your patch layer for this dsh profile, applied after every bundle layer:
# a top-level YAML array of loader patch entries (id-targeted config
# overrides, disables, and insert lists; \`!!js\` expressions allowed).
# Shared rows here are kept in sync across Home Assistant admins by the
# dsh-ha-ingress-auth gateway.
`

export const HOME_PATCH_HEADER = `# Managed by the dsh-ha-ingress-auth gateway: shared configuration set by
# Home Assistant admins. Edits here are overwritten.
`

export { JsExpression }
