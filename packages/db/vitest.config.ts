import { defineConfig } from "vitest/config";

// Each in-process Postgres (PGlite) boots and migrates from scratch, which
// can take several seconds while every package's tests run at once.
export default defineConfig({ test: { testTimeout: 30_000, hookTimeout: 30_000 } });
