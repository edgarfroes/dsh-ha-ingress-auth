// Where everything lives under the app's data directory (`/data` in the
// Home Assistant app, included in HA backups).
//
//   shared/admin/credentials.yaml  API keys and grants; the admin uid owns shared/admin (0700)
//   shared/admin-rows.yml     shared configuration rows written by admins
//   users/<id>/home           DSH_HOME of that user's dsh process
//   users/<id>/workspace      its working directory
//   runtime/overlays/<id>.patch.yml, runtime/uids.json, runtime/snapshots/
//   archive/<id>-<time>       data of HA users that were deleted

import { join } from 'node:path'

export class Layout {
  /** @param {string} dataRoot */
  constructor(dataRoot) {
    this.dataRoot = dataRoot
    this.sharedRoot = join(dataRoot, 'shared')
    this.usersRoot = join(dataRoot, 'users')
    this.runtimeRoot = join(dataRoot, 'runtime')
    this.archiveRoot = join(dataRoot, 'archive')
    this.adminRoot = join(this.sharedRoot, 'admin')
    this.sharedCredentials = join(this.adminRoot, 'credentials.yaml')
    this.sharedRows = join(this.sharedRoot, 'admin-rows.yml')
    this.uids = join(this.runtimeRoot, 'uids.json')
  }

  /** @param {string} key */
  user(key) {
    const root = join(this.usersRoot, key)
    const home = join(root, 'home')
    return {
      root,
      home,
      workspace: join(root, 'workspace'),
      profilePatch: join(home, 'profiles', 'web', 'cordis.patch.yml'),
      homePatch: join(home, 'cordis.patch.yml'),
      credentials: join(home, '.credentials.yaml'),
      handshake: join(home, '.dsh-ha-handshake.json'),
    }
  }

  /** @param {string} key */
  overlay(key) { return join(this.runtimeRoot, 'overlays', `${key}.patch.yml`) }

  /** @param {string} key */
  snapshot(key) { return join(this.runtimeRoot, 'snapshots', `${key}.json`) }
}
