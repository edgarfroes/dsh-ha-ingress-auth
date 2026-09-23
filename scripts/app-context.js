// Copy the plugin and gateway into the app's Docker build context
// (app/dsh_ha_ingress_auth/plugin/). Home Assistant builds an app from its own
// folder only, so the sources must sit next to its Dockerfile.
import { cpSync, rmSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(root, 'app', 'dsh_ha_ingress_auth', 'plugin')
rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })
for (const item of ['src', 'package.json', 'LICENSE']) cpSync(join(root, item), join(out, item), { recursive: true })
console.log(`app build context ready: ${out}`)
