import { defineConfig, devices } from '@playwright/test';

// Its own port, so a `npm run dev` on 8787 never answers for the built server.
const PORT = 8790;

/** One e2e over the built app: `npm run build` first — this serves `server/dist`, not sources. */
export default defineConfig({
  testDir: 'e2e',
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'node server/dist/index.js',
    url: `http://localhost:${PORT}/`,
    env: { PORT: String(PORT) },
    reuseExistingServer: !process.env.CI,
  },
});
