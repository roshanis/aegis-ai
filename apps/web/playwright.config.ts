import { defineConfig, devices } from "@playwright/test";

const PORT = 3200;
/** Set to run against Postgres, where agent jobs run on DBOS; otherwise a throwaway PGlite directory. */
const DATABASE_URL = process.env.E2E_DATABASE_URL;

/** Builds and starts the console, then walks it in Chromium. */
export default defineConfig({
  testDir: "e2e",
  timeout: 90_000,
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
      ...(DATABASE_URL ? { DATABASE_URL } : { AEGIS_PGLITE_DIR: ".data/e2e" }),
      AEGIS_SESSION_SECRET: "e2e-only-secret-not-for-production-use",
      // 32 bytes, base64. For tests only.
      AEGIS_MASTER_KEY: "ZTJlLW9ubHktbWFzdGVyLWtleS0zMi1ieXRlcyEhISE=",
      NEXT_TELEMETRY_DISABLED: "1",
    },
  },
});
