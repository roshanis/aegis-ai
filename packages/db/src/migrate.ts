import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Connection } from "./connection";

const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations/", import.meta.url));

/**
 * Apply pending SQL migrations in filename order, each in its own
 * transaction. A migration that changed after it was applied is an error:
 * fix forward with a new migration instead.
 */
export async function migrate(db: Connection, options: { readonly through?: string } = {}): Promise<string[]> {
  await db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name text PRIMARY KEY,
    checksum text NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);
  const { rows } = await db.query<{ name: string; checksum: string }>("SELECT name, checksum FROM schema_migrations");
  const applied = new Map(rows.map((r) => [r.name, r.checksum]));
  const files = (await readdir(MIGRATIONS_DIR))
    .filter((f) => f.endsWith(".sql") && (options.through === undefined || f <= options.through))
    .sort();

  const ran: string[] = [];
  for (const file of files) {
    const sql = await readFile(join(MIGRATIONS_DIR, file), "utf8");
    const checksum = createHash("sha256").update(sql).digest("hex");
    const recorded = applied.get(file);
    if (recorded !== undefined) {
      if (recorded !== checksum) throw new Error(`migration ${file} was edited after it was applied`);
      continue;
    }
    await db.exec("BEGIN");
    try {
      await db.exec(sql);
      await db.query("INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)", [file, checksum]);
      await db.exec("COMMIT");
    } catch (error) {
      await db.exec("ROLLBACK");
      throw new Error(`migration ${file} failed: ${(error as Error).message}`);
    }
    ran.push(file);
  }
  return ran;
}
