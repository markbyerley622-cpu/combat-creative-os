import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  retries: 0,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:3100',
    trace: 'retain-on-failure',
  },
  webServer: [
    {
      // `pnpm start -- -p 3100` is unreliable on this workspace's pnpm
      // version (a literal "--" token reaches `next start` and breaks its
      // arg parsing) — invoking `next start` directly avoids that.
      command: 'pnpm build && npx next start -p 3100',
      url: 'http://127.0.0.1:3100',
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      env: { NEXT_PUBLIC_API_BASE_URL: 'http://127.0.0.1:4100' },
    },
    {
      // In-memory-backed apps/api instance (no Postgres/Temporal available in
      // this environment) — see apps/api/src/dev-fake-server.ts's doc comment.
      command: 'pnpm --filter api run dev:fake',
      url: 'http://127.0.0.1:4100/health',
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      env: { PORT: '4100' },
    },
  ],
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
