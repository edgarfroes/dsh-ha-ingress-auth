// E2E against the fake-ingress stack (e2e/compose.yaml, or local processes).
import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: 'e2e/tests',
  workers: 1,
  fullyParallel: false,
  timeout: 120_000,
  expect: { timeout: 20_000 },
  retries: 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: process.env.FAKE_HA_URL ?? 'http://127.0.0.1:8080',
    viewport: { width: 1280, height: 860 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
})
