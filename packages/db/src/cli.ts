/**
 * Apply pending migrations. DATABASE_URL selects Postgres (connect as the
 * owner role); without it, a PGlite directory for local development
 * (AEGIS_PGLITE_DIR, default .data/pglite).
 */
import { mkdir } from "node:fs/promises";
import type { Connection } from "./connection";
import { migrate } from "./migrate";

async function run(): Promise<string[]> {
  const url = process.env.DATABASE_URL;
  if (url) {
    const { default: pg } = await import("pg");
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    try {
      const conn: Connection = {
        query: (text, params) => client.query(text, params) as never,
        exec: (text) => client.query(text),
      };
      return await migrate(conn);
    } finally {
      await client.end();
    }
  }
  const { PGlite } = await import("@electric-sql/pglite");
  const dir = process.env.AEGIS_PGLITE_DIR ?? ".data/pglite";
  await mkdir(dir, { recursive: true });
  const db = new PGlite(dir);
  try {
    return await migrate(db);
  } finally {
    await db.close();
  }
}

const ran = await run();
console.log(ran.length > 0 ? `applied ${ran.join(", ")}` : "database is up to date");
