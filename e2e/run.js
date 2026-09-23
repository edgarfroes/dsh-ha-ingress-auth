// Build and start the fake-ingress stack, run the Playwright suite against it,
// then tear it down. Used locally and in CI:  npm run e2e  [-- --keep]
import { execSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const keep = process.argv.includes('--keep')
const compose = `docker compose -f ${join(root, 'e2e', 'compose.yaml')}`
const sh = (cmd) => execSync(cmd, { cwd: root, stdio: 'inherit' })

sh('node scripts/app-context.js')
sh(`${compose} down -v --remove-orphans`)
sh(`${compose} up -d --build`)

const env = {
  ...process.env,
  FAKE_HA_URL: 'http://127.0.0.1:18080',
  STUB_LLM_URL: 'http://172.30.32.2:8081/v1',
  E2E_DIRECT_GATEWAY_URL: 'http://127.0.0.1:18099',
  E2E_APP_EXEC: `${compose} exec -T app`,
  E2E_RESTART_CMD: `${compose} restart app`,
  E2E_GATEWAY_LOG_CMD: `${compose} logs --no-color app`,
  E2E_SHORT_IDLE: '1',
}

// Wait for the fake HA to answer.
for (let i = 0; ; i++) {
  try { if ((await fetch('http://127.0.0.1:18080/health')).ok) break } catch { /* not yet */ }
  if (i > 120) throw new Error('fake HA did not start')
  await new Promise((r) => setTimeout(r, 1000))
}

const result = spawnSync('npx', ['playwright', 'test', ...process.argv.slice(2).filter((a) => a !== '--keep')], { cwd: root, env, stdio: 'inherit' })
if (result.status !== 0) spawnSync('sh', ['-c', `${compose} logs --no-color app | tail -200`], { stdio: 'inherit' })
if (!keep) sh(`${compose} down -v --remove-orphans`)
process.exit(result.status ?? 1)
