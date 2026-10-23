// Extra dsh plugins from the `plugins` app option. The gateway installs them
// once at startup into one shared directory, then mounts each package's bundle
// patch in every child's overlay, with the package's relative rows turned into
// absolute paths (as the language pack rows are).

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { parsePatch } from './patches.js'

/** Row ids the gateway owns; a plugin's patch may not insert or override them. */
export const RESERVED_ROW_IDS = Object.freeze(['dsh-ha-ingress-auth', 'credentials', 'workspace-controller', 'ui-settings'])

/**
 * Parse the `plugins` app option: a list of npm package specs (a registry
 * name with an optional version, a git address or a tarball URL). Blank items
 * and `#` comments are ignored; duplicates are dropped.
 * @param {unknown} raw
 * @returns {string[]}
 * @throws on a non-string entry or a spec that looks like a command-line flag
 */
export function parsePluginSpecs(raw) {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) throw new Error('expected a list of package specs')
  const specs = []
  for (const entry of raw) {
    if (typeof entry !== 'string') throw new Error(`each plugins entry must be a package spec, got ${typeof entry}`)
    const spec = entry.split(/\s#/, 1)[0].trim()
    if (spec === '' || spec.startsWith('#')) continue
    if (spec.startsWith('-') || /\s/.test(spec)) throw new Error(`not a package spec: ${JSON.stringify(spec)}`)
    if (!specs.includes(spec)) specs.push(spec)
  }
  return specs
}

/**
 * Install exactly `specs` into `dir` with npm, dropping packages no longer
 * listed. Dependency install scripts do not run, and peer dependencies (dsh
 * and cordis) are not installed: the plugin must share dsh's own copies.
 * @param {{ specs: readonly string[], dir: string, npm?: string, timeoutMs?: number }} opts
 * @returns {{ ok: true } | { ok: false, error: string }}
 */
export function installPlugins({ specs, dir, npm = 'npm', timeoutMs = 10 * 60000 }) {
  rmSync(dir, { recursive: true, force: true })
  if (specs.length === 0) return { ok: true }
  mkdirSync(dir, { recursive: true })
  chmodSync(dir, 0o755)
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'dsh-ha-plugins', private: true, dependencies: {} }, null, 2) + '\n')
  const args = ['install', '--save', '--ignore-scripts', '--legacy-peer-deps', '--no-audit', '--no-fund', '--omit=dev', '--', ...specs]
  const run = spawnSync(npm, args, { cwd: dir, encoding: 'utf8', timeout: timeoutMs })
  if (run.error) return { ok: false, error: run.error.message }
  if (run.status !== 0) return { ok: false, error: (run.stderr || run.stdout || `npm exited ${run.status}`).trim().split('\n').slice(-5).join('\n') }
  return { ok: true }
}

const rowIds = (row) => [row?.id, ...(Array.isArray(row?.insert) ? row.insert.map((entry) => entry?.id) : [])].filter(Boolean)

/**
 * Overlay rows for every package installed in `dir`: each package's
 * `dsh.bundle.patch`, with `./` and `../` row names made absolute and bare
 * names resolved from the package when it has them. A package without a
 * bundle patch, or a row touching a reserved id, is skipped and reported.
 * @param {string} dir
 * @param {(line: string) => void} [log]
 * @returns {any[]}
 */
export function pluginRows(dir, log = () => {}) {
  const manifest = join(dir, 'package.json')
  if (!existsSync(manifest)) return []
  const names = Object.keys(JSON.parse(readFileSync(manifest, 'utf8')).dependencies ?? {})
  const rows = []
  for (const name of names) {
    const pkgDir = join(dir, 'node_modules', name)
    let pkg
    try { pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) } catch {
      log(`[gateway] plugin ${name} skipped: not installed`)
      continue
    }
    const patch = pkg?.dsh?.bundle?.patch
    if (typeof patch !== 'string') {
      log(`[gateway] plugin ${name} skipped: not a dsh plugin bundle (no dsh.bundle.patch)`)
      continue
    }
    const patchFile = resolve(pkgDir, patch)
    const requireFromPkg = createRequire(join(pkgDir, 'package.json'))
    const fixName = (entry) => {
      if (!entry || typeof entry.name !== 'string' || isAbsolute(entry.name)) return entry
      if (entry.name.startsWith('./') || entry.name.startsWith('../')) return { ...entry, name: resolve(dirname(patchFile), entry.name) }
      try { return { ...entry, name: requireFromPkg.resolve(entry.name) } } catch { return entry }
    }
    let own
    try { own = parsePatch(readFileSync(patchFile, 'utf8')) } catch (error) {
      log(`[gateway] plugin ${name} skipped: bad bundle patch: ${error instanceof Error ? error.message : String(error)}`)
      continue
    }
    for (const row of own) {
      const reserved = rowIds(row).filter((id) => RESERVED_ROW_IDS.includes(id))
      if (reserved.length > 0) {
        log(`[gateway] plugin ${name}: row for reserved id ${reserved.join(', ')} ignored`)
        continue
      }
      rows.push(Array.isArray(row.insert) ? { ...row, insert: row.insert.map(fixName) } : fixName(row))
    }
    log(`[gateway] plugin ${name}@${pkg.version} mounted`)
  }
  return rows
}
