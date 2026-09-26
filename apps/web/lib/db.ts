import "server-only";
import type { Governance } from "@aegis/core";
import type { Database } from "@aegis/db";
import { runtime } from "./runtime";

/**
 * DATABASE_URL selects Postgres (shared, dedicated or customer-hosted).
 * Without it, a local PGlite directory, so development needs no services.
 * Migrations run before the server starts (`pnpm db:migrate`).
 */
export async function database(): Promise<Database> {
  return (await runtime()).db;
}

export async function governance(): Promise<Governance> {
  return (await runtime()).gov;
}
