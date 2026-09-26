import type { NextConfig } from "next";

const config: NextConfig = {
  // Don't write AGENTS.md or CLAUDE.md into the app on `next dev`.
  agentRules: false,
  // Workspace packages ship TypeScript source.
  transpilePackages: ["@aegis/agents", "@aegis/core", "@aegis/db", "@aegis/domain", "@aegis/frameworks", "@aegis/workflows"],
  // Loaded at runtime by Node: PGlite reads its WebAssembly from disk, and
  // DBOS and the Agents SDK keep process-wide state that must exist once.
  serverExternalPackages: [
    "@electric-sql/pglite",
    "pg",
    "@dbos-inc/dbos-sdk",
    "@openai/agents-core",
    "@openai/agents-openai",
    "openai",
  ],
};

export default config;
