import { defineConfig, devices } from "@playwright/test";

const PORT = 3200;

/** Builds and starts the console on a throwaway PGlite database, then walks it in Chromium. */
export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  reporter: process.env.CI ? [["github"], ["list"]] : "list",
  use: { baseURL: `http://localhost:${PORT}`, trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "pnpm build && pnpm start",
    url: `http://localhost:${PORT}`,
    timeout: 240_000,
    reuseExistingServer: false,
    env: {
      PORT: String(PORT),
      AEGIS_PGLITE_DIR: ".data/e2e",
      AEGIS_SESSION_SECRET: "e2e-only-secret-not-for-production-use",
      NEXT_TELEMETRY_DISABLED: "1",
    },
  },
});
