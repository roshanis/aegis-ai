import { defineConfig, devices } from "@playwright/test";

const PORT = 3200;
const IDP_PORT = 3201;
/** Set to run against Postgres, where agent jobs run on DBOS; otherwise a throwaway PGlite directory. */
const DATABASE_URL = process.env.E2E_DATABASE_URL;

const database: Record<string, string> = DATABASE_URL ? { DATABASE_URL } : { AEGIS_PGLITE_DIR: ".data/e2e" };

/** Builds and starts the console beside a mock sign-in provider, then walks it in Chromium. */
export default defineConfig({
  testDir: "e2e",
  testMatch: "*.spec.ts",
  timeout: 90_000,
  reporter: process.env.CI ? [["github"], ["list"]] : "list",
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "retain-on-failure",
    // A preinstalled Chromium, when this machine has one that does not match Playwright's own.
    ...(process.env.PLAYWRIGHT_CHROMIUM_PATH ? { launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH } } : {}),
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      command: "tsx e2e/mock-idp.ts",
      url: `http://localhost:${IDP_PORT}/.well-known/openid-configuration`,
      timeout: 30_000,
      reuseExistingServer: false,
      env: { MOCK_IDP_PORT: String(IDP_PORT) },
    },
    {
      // The SSO tenant is seeded on the platform connection before the server holds the database.
      command: "pnpm build && tsx e2e/seed-sso.ts && pnpm start",
      url: `http://localhost:${PORT}`,
      timeout: 240_000,
      reuseExistingServer: false,
      env: {
        PORT: String(PORT),
        ...database,
        AEGIS_SESSION_SECRET: "e2e-only-secret-not-for-production-use",
        // 32 bytes, base64. For tests only.
        AEGIS_MASTER_KEY: "ZTJlLW9ubHktbWFzdGVyLWtleS0zMi1ieXRlcyEhISE=",
        AEGIS_PUBLIC_URL: `http://localhost:${PORT}`,
        // The mock provider speaks plain http on this machine.
        AEGIS_SSO_ALLOW_HTTP: "1",
        MOCK_IDP_PORT: String(IDP_PORT),
        NEXT_TELEMETRY_DISABLED: "1",
        // Redraft at once, so the e2e flow does not wait out the settle time.
        AEGIS_DRAFT_SETTLE_MS: "0",
        // Every test opens a sandbox from the same address.
        AEGIS_SANDBOXES_PER_CLIENT_HOUR: "1000",
      },
    },
  ],
});
