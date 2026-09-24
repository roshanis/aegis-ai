import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { Connection } from "./connection";

const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations/", import.meta.url));

/** Apply pending SQL migrations in filename order, each in its own transaction. */
export async function migrate(db: Connection): Promise<string[]> {
  await db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);
  const { rows } = await db.query<{ name: string }>("SELECT name FROM schema_migrations");
  const applied = new Set(rows.map((r) => r.name));
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();

  const ran: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = await readFile(MIGRATIONS_DIR + file, "utf8");
    await db.exec("BEGIN");
    try {
      await db.exec(sql);
      await db.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
      await db.exec("COMMIT");
    } catch (error) {
      await db.exec("ROLLBACK");
      throw new Error(`migration ${file} failed: ${(error as Error).message}`);
    }
    ran.push(file);
  }
  return ran;
}
