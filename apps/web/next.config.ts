import type { NextConfig } from "next";

const config: NextConfig = {
  // Workspace packages ship TypeScript source.
  transpilePackages: ["@aegis/core", "@aegis/db", "@aegis/domain", "@aegis/frameworks"],
  // Loaded at runtime by Node: PGlite reads its WebAssembly from disk.
  serverExternalPackages: ["@electric-sql/pglite", "pg"],
};

export default config;
