// Shared, admin-owned configuration across per-user dsh processes.
//
// dsh saves Settings into the profile patch of the process that edited them
// (`$DSH_HOME/profiles/web/cordis.patch.yml`). This module:
//   - keeps one store of the shared rows (everything except personal
//     preference rows), fed by changes admins make in their own processes;
//   - copies the store into every other admin's profile patch;
//   - writes the store as the home patch (`$DSH_HOME/cordis.patch.yml`) of every
//     non-admin process. dsh ranks the home patch above the profile patch and
//     refuses Settings writes it would override, so non-admins cannot change
//     shared configuration, and HMR applies store changes live.

import { existsSync, readFileSync, statSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import yaml from 'js-yaml'
// The same writer lock dsh's config editor holds while it rewrites a profile
// patch, so the gateway and dsh never overwrite each other's edits.
import { withFileLock } from '@deepseek-ai/dsh-atomic-write'
import {
  DEFAULT_PREFERENCE_ROWS, HOME_PATCH_HEADER, PROFILE_PATCH_HEADER,
  applyAdminChange, dumpPatch, mergeForAdmin, readPatchFile, splitRows, stableStringify, writeFileAtomic,
} from './patches.js'
import { tagOf } from './children.js'

export class SharedConfig {
  /**
   * @param {{
   *   layout: import('./layout.js').Layout,
   *   children: () => Iterable<import('./children.js').Child>,
   *   log: (line: string) => void,
   *   preferenceRows?: readonly string[],
   *   onCredentialsChanged?: () => void,
   * }} opts
   */
  constructor(opts) {
    this.opts = opts
    this.layout = opts.layout
    this.preferenceRows = opts.preferenceRows ?? DEFAULT_PREFERENCE_ROWS
    this.store = readPatchFile(this.layout.sharedRows)
    /** Shared rows each admin's patch held after our last sync. @type {Map<string, any[]>} */
    this.snapshots = new Map()
    this.fileStamp = this.stamp(this.layout.sharedCredentials)
    this.refsStamp = JSON.stringify(this.credentialEnv())
  }

  stamp(path) {
    try { const s = statSync(path); return `${s.mtimeMs}:${s.size}` } catch { return 'missing' }
  }

  saveStore() {
    writeFileAtomic(this.layout.sharedRows, dumpPatch(this.store, '# Shared dsh configuration (rows written by Home Assistant admins).\n'), { mode: 0o600 })
  }

  /** Before a non-admin process starts. @param {import('./children.js').Child} child */
  prepareUser(child) {
    this.writeHomePatch(child.key)
  }

  /** Before an admin process starts. @param {import('./children.js').Child} child */
  async prepareAdmin(child) {
    // A promoted user's managed home patch would outrank (and refuse) their
    // admin edits; admins get the shared rows in their profile patch instead.
    rmSync(this.layout.user(child.key).homePatch, { force: true })
    // A brand-new admin has no profile yet; dsh creates it on first boot and
    // the next sync tick fills in the shared rows.
    await this.withProfileLock(child, (own) => { this.writeAdminPatch(child, own) })
  }

  /**
   * Run `fn` with the admin's current profile rows while holding dsh's profile
   * writer lock. Skipped when the profile does not exist yet.
   * @param {import('./children.js').Child} child @param {(own: any[]) => void} fn
   */
  async withProfileLock(child, fn) {
    const { profilePatch } = this.layout.user(child.key)
    if (!existsSync(profilePatch)) return
    const manifest = join(dirname(profilePatch), 'package.json')
    await withFileLock(manifest, async () => { fn(readPatchFile(profilePatch)) }, { waitMs: 5000 })
  }

  /** @param {string} key */
  writeHomePatch(key) {
    const { homePatch } = this.layout.user(key)
    writeFileAtomic(homePatch, dumpPatch(this.store, HOME_PATCH_HEADER), { mode: 0o644, uid: 0, gid: 0 })
  }

  /** @param {import('./children.js').Child} child @param {any[]} own */
  writeAdminPatch(child, own) {
    const { profilePatch } = this.layout.user(child.key)
    const merged = mergeForAdmin(own, this.store, this.preferenceRows)
    if (stableStringify(merged) !== stableStringify(own)) {
      writeFileAtomic(profilePatch, dumpPatch(merged, PROFILE_PATCH_HEADER), { mode: 0o600, uid: child.uid, gid: child.uid })
    }
    this.snapshots.set(child.key, this.store)
  }

  /** One sync pass. Called on a short interval; never runs twice at once. */
  async tick() {
    if (this.ticking) return
    this.ticking = true
    try { await this.syncOnce() } finally { this.ticking = false }
  }

  async syncOnce() {
    const children = [...this.opts.children()]
    let changed = false
    for (const child of children) {
      if (child.role !== 'admin' || !child.cookie) continue
      try {
        await this.withProfileLock(child, (own) => {
          const current = splitRows(own, this.preferenceRows).shared
          const before = this.snapshots.get(child.key)
          if (before === undefined) {
            if (this.store.length === 0 && current.length > 0) {
              // First admin with existing configuration seeds the store.
              this.store = current
              changed = true
              this.snapshots.set(child.key, current)
            } else {
              this.writeAdminPatch(child, own)
            }
            return
          }
          const result = applyAdminChange(this.store, before, current)
          this.snapshots.set(child.key, current)
          if (result.changed) {
            this.store = result.rows
            changed = true
            this.opts.log(`[gateway] shared configuration updated by an admin (${tagOf(child.key)})`)
          }
        })
      } catch (error) {
        this.opts.log(`[gateway] cannot sync the profile of ${tagOf(child.key)}: ${error.message}`)
      }
    }
    if (changed) {
      this.saveStore()
      for (const child of children) {
        if (!child.cookie) continue
        if (child.role === 'user') this.writeHomePatch(child.key)
        else {
          try {
            await this.withProfileLock(child, (own) => { this.writeAdminPatch(child, own) })
          } catch (error) {
            this.opts.log(`[gateway] cannot update the profile of ${tagOf(child.key)}: ${error.message}`)
          }
        }
      }
    }
    // Only a change of API keys matters to non-admin processes; the file also
    // holds grant records that change on their own.
    const stamp = this.stamp(this.layout.sharedCredentials)
    if (stamp !== this.fileStamp) {
      this.fileStamp = stamp
      const refs = JSON.stringify(this.credentialEnv())
      if (refs !== this.refsStamp) {
        this.refsStamp = refs
        this.opts.onCredentialsChanged?.()
      }
    }
  }

  /** Credential values (`refs`) to hand a non-admin process as environment
   * variables. dsh reads the environment layer first and reports it read-only. */
  credentialEnv() {
    const file = this.layout.sharedCredentials
    if (!existsSync(file)) return {}
    try {
      const doc = yaml.load(readFileSync(file, 'utf8'))
      const refs = doc && typeof doc === 'object' ? doc.refs : undefined
      const env = {}
      if (refs && typeof refs === 'object') {
        for (const [name, value] of Object.entries(refs)) {
          if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && typeof value === 'string' && value !== '') env[name] = value
        }
      }
      return env
    } catch (error) {
      this.opts.log(`[gateway] cannot read shared credentials: ${error.message}`)
      return {}
    }
  }
}
