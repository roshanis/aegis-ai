import "server-only";
import { createGovernance, type Governance } from "@aegis/core";
import { pooled, serialized, type Database } from "@aegis/db";

/**
 * DATABASE_URL selects Postgres (shared, dedicated or customer-hosted).
 * Without it, a local PGlite directory, so development needs no services.
 * Migrations run before the server starts (`pnpm db:migrate`).
 */
const cache = globalThis as unknown as { aegisDatabase?: Promise<Database> };

async function open(): Promise<Database> {
  const url = process.env.DATABASE_URL;
  if (url) {
    const { default: pg } = await import("pg");
    return pooled(new pg.Pool({ connectionString: url }));
  }
  const { PGlite } = await import("@electric-sql/pglite");
  return serialized(new PGlite(process.env.AEGIS_PGLITE_DIR ?? ".data/pglite"));
}

export function database(): Promise<Database> {
  cache.aegisDatabase ??= open();
  return cache.aegisDatabase;
}

export async function governance(): Promise<Governance> {
  return createGovernance(await database());
}
