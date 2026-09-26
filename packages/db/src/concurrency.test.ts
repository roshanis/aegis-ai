import { randomBytes } from "node:crypto";
import { tenantId } from "@aegis/domain";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appendAudit, verifyAuditChain } from "./audit";
import type { Connection } from "./connection";
import { pooled, type Database } from "./database";
import { migrate } from "./migrate";
import { withTenant } from "./tenant";

/**
 * Concurrent writers need a real Postgres: PGlite runs one call at a time.
 * Set AEGIS_TEST_DATABASE_URL to a connection that may create databases;
 * CI sets AEGIS_REQUIRE_POSTGRES so these can never be skipped there.
 */
const adminUrl = process.env.AEGIS_TEST_DATABASE_URL;
if (!adminUrl && process.env.AEGIS_REQUIRE_POSTGRES === "1") {
  throw new Error("AEGIS_TEST_DATABASE_URL is required when AEGIS_REQUIRE_POSTGRES=1");
}

const T = tenantId("00000000-0000-4000-8000-0000000000d0");
const at = new Date("2026-09-26T12:00:00Z");

describe.skipIf(!adminUrl)("audit log under concurrent writers", () => {
  const name = `aegis_db_${Date.now()}_${randomBytes(3).toString("hex")}`;
  let pool: pg.Pool;
  let db: Database;

  const owner = <T>(fn: (conn: Connection) => Promise<T>) => db.run(fn);

  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${name}`);
    await admin.end();
    const url = new URL(adminUrl!);
    url.pathname = `/${name}`;
    pool = new pg.Pool({ connectionString: url.toString(), max: 8 });
    db = pooled(pool);
    await owner(async (conn) => {
      await migrate(conn);
      await conn.query("INSERT INTO tenants (id, slug, name) VALUES ($1, 'payer-d', 'Payer D')", [T]);
    });
  });

  afterAll(async () => {
    await pool?.end();
    const admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.end();
  });

  const event = (tx: Connection, action: string) => appendAudit(tx, { actorKind: "system", actorId: "test", action, at });

  /** Wait until some session is blocked on an advisory lock, so the interleaving below is certain. */
  async function blockedOnAdvisoryLock() {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const { rows } = await pool.query("SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND NOT granted");
      if (rows.length > 0) return;
      if (Date.now() > deadline) throw new Error("no writer ever waited for the chain lock");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  it("stays verifiable when one transaction's events straddle another's", async () => {
    // A request writes two events in one transaction; a background job writes
    // one while the request is still open. The job's row is inserted in the
    // middle, but it must join the chain after the request's second event.
    let job: Promise<void> | undefined;
    await db.run((conn) =>
      withTenant(conn, T, async (tx) => {
        await event(tx, "request.first");
        job = db.run((other) => withTenant(other, T, (tx2) => event(tx2, "job.only")));
        await blockedOnAdvisoryLock();
        await event(tx, "request.second");
      }),
    );
    await job;

    const { rows } = await db.run((conn) =>
      withTenant(conn, T, (tx) => tx.query<{ action: string }>("SELECT action FROM audit_events ORDER BY id")),
    );
    expect(rows.map((r) => r.action)).toEqual(["request.first", "request.second", "job.only"]);
    expect(await db.run((conn) => withTenant(conn, T, verifyAuditChain))).toBeNull();
  });

  it("keeps many concurrent writers on one unforked chain", async () => {
    await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        db.run((conn) =>
          withTenant(conn, T, async (tx) => {
            await event(tx, `burst.${i}.a`);
            await event(tx, `burst.${i}.b`);
          }),
        ),
      ),
    );
    const chain = await db.run((conn) =>
      withTenant(conn, T, (tx) =>
        tx.query<{ n: number; distinct_prev: number }>(
          "SELECT count(*)::int AS n, count(DISTINCT prev_hash)::int AS distinct_prev FROM audit_events",
        ),
      ),
    );
    // Every event but the first names a different predecessor: no two events share one.
    expect(chain.rows[0]).toEqual({ n: 27, distinct_prev: 26 });
    expect(await db.run((conn) => withTenant(conn, T, verifyAuditChain))).toBeNull();
  });
});
