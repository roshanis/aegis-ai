import { PGlite } from "@electric-sql/pglite";
import { tenantId } from "@aegis/domain";
import { beforeAll, describe, expect, it } from "vitest";
import { appendAudit, sha256Hex, verifyAuditChain } from "./audit";
import { serialized } from "./database";
import { migrate } from "./migrate";
import { withTenant } from "./tenant";

const A = tenantId("00000000-0000-4000-8000-00000000000a");
const B = tenantId("00000000-0000-4000-8000-00000000000b");
const userA = "00000000-0000-4000-8000-0000000000a1";
const userB = "00000000-0000-4000-8000-0000000000b1";
const assetA = "00000000-0000-4000-8000-0000000000e1";
const assetB = "00000000-0000-4000-8000-0000000000e2";
const at = new Date("2026-09-24T12:00:00Z");

let db: PGlite;

async function seedTenant(id: string, slug: string, user: string, asset: string) {
  // Provisioning runs as the owner role, outside tenant scope.
  await db.query("INSERT INTO tenants (id, slug, name) VALUES ($1, $2, $2)", [id, slug]);
  await db.query(
    "INSERT INTO users (id, tenant_id, email, display_name, roles) VALUES ($1, $2, $3, 'Req', '{requester}')",
    [user, id, `${slug}@example.test`],
  );
  await db.query("INSERT INTO policy_packs (tenant_id, pack_id, version, content) VALUES ($1, 'p', '1.0.0', '{}')", [id]);
  await db.query("INSERT INTO assets (id, tenant_id, kind, name, owner_id) VALUES ($1, $2, 'ai_system', 'Bot', $3)", [
    asset,
    id,
    user,
  ]);
}

const insertCase = (caseId: string, tenant: string, asset: string, owner: string, decidedAt = "NULL") =>
  `INSERT INTO cases (id, tenant_id, asset_id, kind, trigger, state, owner_id, pack_id, pack_version, decided_at)
   VALUES ('${caseId}', '${tenant}', '${asset}', 'risk_review', 'initial', 'draft', '${owner}', 'p', '1.0.0', ${decidedAt})`;

const audit = (tenant: string, action: string) =>
  `INSERT INTO audit_events (tenant_id, actor_kind, actor_id, action, at)
   VALUES ('${tenant}', 'system', 'test', '${action}', '2026-09-24T12:00:00Z')`;

beforeAll(async () => {
  db = new PGlite();
  expect(await migrate(db)).toEqual([
    "0001_tenancy.sql",
    "0002_registry.sql",
    "0003_audit_log.sql",
    "0004_sandbox.sql",
    "0005_governance_core.sql",
    "0006_agents.sql",
    "0007_case_numbers.sql",
    "0008_audit_chain_order.sql",
    "0009_token_controls.sql",
  ]);
  expect(await migrate(db)).toEqual([]);
  await seedTenant(A, "tenant-a", userA, assetA);
  await seedTenant(B, "tenant-b", userB, assetB);
});

describe("migrations", () => {
  it("refuses to run when an applied migration has changed", async () => {
    const where = "WHERE name = '0001_tenancy.sql'";
    const { rows } = await db.query<{ checksum: string }>(`SELECT checksum FROM schema_migrations ${where}`);
    await db.exec(`UPDATE schema_migrations SET checksum = 'stale' ${where}`);
    await expect(migrate(db)).rejects.toThrow(/0001_tenancy.sql was edited after it was applied/);
    await db.query(`UPDATE schema_migrations SET checksum = $1 ${where}`, [rows[0]!.checksum]);
    expect(await migrate(db)).toEqual([]);
  });
});

describe("tenant isolation", () => {
  it("shows each tenant only its own rows", async () => {
    await withTenant(db, A, (tx) => tx.exec(insertCase("00000000-0000-4000-8000-0000000000c1", A, assetA, userA)));
    await withTenant(db, B, (tx) => tx.exec(insertCase("00000000-0000-4000-8000-0000000000c2", B, assetB, userB)));

    const seenByA = await withTenant(db, A, (tx) => tx.query<{ id: string }>("SELECT id FROM cases"));
    expect(seenByA.rows.map((r) => r.id)).toEqual(["00000000-0000-4000-8000-0000000000c1"]);
    const tenantsSeenByB = await withTenant(db, B, (tx) => tx.query<{ slug: string }>("SELECT slug FROM tenants"));
    expect(tenantsSeenByB.rows).toEqual([{ slug: "tenant-b" }]);
  });

  it("refuses writes into another tenant", async () => {
    await expect(
      withTenant(db, A, (tx) => tx.exec(insertCase("00000000-0000-4000-8000-0000000000c3", B, assetB, userB))),
    ).rejects.toThrow(/row-level security/);
  });

  it("refuses a case that points at another tenant's asset", async () => {
    await expect(
      withTenant(db, A, (tx) => tx.exec(insertCase("00000000-0000-4000-8000-0000000000c4", A, assetB, userA))),
    ).rejects.toThrow(/foreign key/);
  });

  it("cannot update or delete another tenant's rows", async () => {
    const updated = await withTenant(db, A, (tx) =>
      tx.query("UPDATE assets SET name = 'hijacked' WHERE tenant_id = $1 RETURNING id", [B]),
    );
    expect(updated.rows).toEqual([]);
    const deleted = await withTenant(db, A, (tx) => tx.query("DELETE FROM users WHERE tenant_id = $1 RETURNING id", [B]));
    expect(deleted.rows).toEqual([]);
  });

  it("returns nothing when no tenant is set", async () => {
    await db.exec("BEGIN; SET LOCAL ROLE aegis_app;");
    const rows = await db.query("SELECT id FROM assets");
    await db.exec("COMMIT");
    expect(rows.rows).toEqual([]);
  });

  it("forces row-level security on every table that carries a tenant_id", async () => {
    const { rows } = await db.query<{ table: string; rls: boolean; forced: boolean }>(`
      SELECT c.relname AS table, c.relrowsecurity AS rls, c.relforcerowsecurity AS forced
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped
      WHERE c.relkind = 'r'
      ORDER BY c.relname`);
    expect(rows.map((r) => r.table)).toEqual(
      expect.arrayContaining(["agent_evals", "agent_runs", "agent_settings", "model_connections", "tenant_keys"]),
    );
    expect(rows.filter((r) => !r.rls || !r.forced).map((r) => r.table)).toEqual([]);
  });

  it("never lets the app role replace or remove a tenant's data key", async () => {
    await db.query("INSERT INTO tenant_keys (tenant_id, kek_id, wrapped_key, created_at) VALUES ($1, 'k', 'w', now())", [A]);
    await expect(withTenant(db, A, (tx) => tx.exec("UPDATE tenant_keys SET wrapped_key = 'x'"))).rejects.toThrow(
      /permission denied/,
    );
    await expect(withTenant(db, A, (tx) => tx.exec("DELETE FROM tenant_keys"))).rejects.toThrow(/permission denied/);
    const seenByB = await withTenant(db, B, (tx) => tx.query("SELECT * FROM tenant_keys"));
    expect(seenByB.rows).toEqual([]);
  });

  it("does not let the app role create tenants", async () => {
    await expect(
      withTenant(db, A, (tx) => tx.exec("INSERT INTO tenants (id, slug, name) VALUES (gen_random_uuid(), 'evil', 'x')")),
    ).rejects.toThrow(/permission denied/);
  });
});

describe("registry", () => {
  it("allows one open case per asset", async () => {
    await expect(
      withTenant(db, A, (tx) => tx.exec(insertCase("00000000-0000-4000-8000-0000000000c5", A, assetA, userA))),
    ).rejects.toThrow(/cases_one_open_per_asset/);
    await withTenant(db, A, async (tx) => {
      await tx.exec("UPDATE cases SET state = 'rejected', decided_at = now() WHERE id = '00000000-0000-4000-8000-0000000000c1'");
      await tx.exec(insertCase("00000000-0000-4000-8000-0000000000c5", A, assetA, userA));
    });
  });

  it("lets the app delete notes but never edit them", async () => {
    const note = "00000000-0000-4000-8000-0000000000f1";
    await withTenant(db, A, (tx) =>
      tx.query("INSERT INTO notes (id, tenant_id, asset_id, author_id, body) VALUES ($1, $2, $3, $4, 'x')", [
        note,
        A,
        assetA,
        userA,
      ]),
    );
    await expect(withTenant(db, A, (tx) => tx.exec("UPDATE notes SET body = 'y'"))).rejects.toThrow(/permission denied/);
    const deleted = await withTenant(db, A, (tx) => tx.query("DELETE FROM notes WHERE id = $1 RETURNING id", [note]));
    expect(deleted.rows).toHaveLength(1);
  });
});

describe("audit log", () => {
  it("chains each tenant's events and verifies clean", async () => {
    await withTenant(db, A, async (tx) => {
      await tx.exec(audit(A, "submit"));
      await tx.exec(audit(A, "triage"));
    });
    await withTenant(db, B, (tx) => tx.exec(audit(B, "submit")));

    const rows = await withTenant(db, A, (tx) =>
      tx.query<{ prev_hash: string | null; hash: string }>("SELECT prev_hash, hash FROM audit_events ORDER BY id"),
    );
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows[0]!.prev_hash).toBeNull();
    expect(rows.rows[1]!.prev_hash).toBe(rows.rows[0]!.hash);
    expect(await withTenant(db, A, verifyAuditChain)).toBeNull();
    expect(await withTenant(db, B, verifyAuditChain)).toBeNull();
  });

  it("keeps a note's hash, not its text, and stays valid after the note is erased", async () => {
    const note = { id: "00000000-0000-4000-8000-0000000000f2", body: "Member Jane Doe asked for an exception" };
    await withTenant(db, A, async (tx) => {
      await tx.query("INSERT INTO notes (id, tenant_id, asset_id, author_id, body) VALUES ($1, $2, $3, $4, $5)", [
        note.id,
        A,
        assetA,
        userA,
        note.body,
      ]);
      await appendAudit(tx, { assetId: assetA, actorKind: "human", actorId: userA, action: "asset.pause", note, at });
    });
    const stored = await withTenant(db, A, (tx) =>
      tx.query<Record<string, unknown>>("SELECT * FROM audit_events WHERE note_id = $1", [note.id]),
    );
    expect(stored.rows[0]!.note_sha256).toBe(sha256Hex(note.body));
    expect(JSON.stringify(stored.rows)).not.toContain("Jane");

    await withTenant(db, A, (tx) => tx.query("DELETE FROM notes WHERE id = $1", [note.id]));
    expect(await withTenant(db, A, verifyAuditChain)).toBeNull();
  });

  it("rejects updates and deletes, even from the owner role", async () => {
    await expect(withTenant(db, A, (tx) => tx.exec("UPDATE audit_events SET action = 'x'"))).rejects.toThrow();
    await expect(db.exec("UPDATE audit_events SET action = 'x'")).rejects.toThrow(/append-only/);
    await expect(db.exec("DELETE FROM audit_events")).rejects.toThrow(/append-only/);
  });

  it("detects tampering that bypasses the triggers", async () => {
    await db.exec(`
      ALTER TABLE audit_events DISABLE TRIGGER audit_events_no_update;
      UPDATE audit_events SET action = 'rewritten' WHERE id = (SELECT min(id) FROM audit_events WHERE tenant_id = '${A}');
      ALTER TABLE audit_events ENABLE TRIGGER audit_events_no_update;`);
    expect(await withTenant(db, A, verifyAuditChain)).not.toBeNull();
    expect(await withTenant(db, B, verifyAuditChain)).toBeNull();
  });
});

describe("connections", () => {
  it("runs concurrent calls on one connection one at a time, each in its own tenant", async () => {
    const database = serialized(db);
    const slugs = await Promise.all(
      [A, B, A, B].map((tenant) =>
        database.run((conn) =>
          withTenant(conn, tenant, async (tx) => {
            const { rows } = await tx.query<{ slug: string }>("SELECT slug FROM tenants");
            await tx.query("SELECT pg_sleep(0.01)");
            return rows.map((r) => r.slug);
          }),
        ),
      ),
    );
    expect(slugs).toEqual([["tenant-a"], ["tenant-b"], ["tenant-a"], ["tenant-b"]]);
  });

  it("keeps serving after a call fails", async () => {
    const database = serialized(db);
    const failed = database.run((conn) => withTenant(conn, A, (tx) => tx.exec("SELECT * FROM missing_table")));
    const next = database.run((conn) => withTenant(conn, A, (tx) => tx.query("SELECT 1 AS ok")));
    await expect(failed).rejects.toThrow(/missing_table/);
    expect((await next).rows).toEqual([{ ok: 1 }]);
  });
});

describe("purging a tenant", () => {
  const C = "00000000-0000-4000-8000-00000000000c";

  it("deletes only the audit rows of the tenant named for this transaction", async () => {
    await db.query("INSERT INTO tenants (id, slug, name) VALUES ($1, 'sandbox-c', 'C')", [C]);
    await withTenant(db, tenantId(C), (tx) => tx.exec(audit(C, "tenant.provision")));

    await db.exec("BEGIN");
    await db.query("SELECT set_config('app.purge_tenant', $1, true)", [C]);
    await expect(db.exec(`DELETE FROM audit_events WHERE tenant_id = '${A}'`)).rejects.toThrow(/append-only/);
    await db.exec("ROLLBACK");

    await db.exec("BEGIN");
    await db.query("SELECT set_config('app.purge_tenant', $1, true)", [C]);
    const purged = await db.query(`DELETE FROM audit_events WHERE tenant_id = '${C}' RETURNING id`);
    await db.exec("COMMIT");
    expect(purged.rows).toHaveLength(1);

    await expect(db.exec(`DELETE FROM audit_events WHERE tenant_id = '${B}'`)).rejects.toThrow(/append-only/);
    expect(await withTenant(db, B, verifyAuditChain)).toBeNull();
  });
});

describe("case numbers", () => {
  it("numbers existing cases per tenant, in the order they were opened, when the migration arrives", async () => {
    const old = new PGlite();
    await migrate(old, { through: "0006_agents.sql" });
    const seed = async (tenant: string, slug: string, user: string, asset: string, cases: [string, string][]) => {
      await old.query("INSERT INTO tenants (id, slug, name) VALUES ($1, $2, $2)", [tenant, slug]);
      await old.query("INSERT INTO users (id, tenant_id, email, display_name) VALUES ($1, $2, $3, 'Req')", [user, tenant, `${slug}@x.test`]);
      await old.query("INSERT INTO policy_packs (tenant_id, pack_id, version, content) VALUES ($1, 'p', '1.0.0', '{}')", [tenant]);
      await old.query("INSERT INTO assets (id, tenant_id, kind, name, owner_id) VALUES ($1, $2, 'ai_system', 'Bot', $3)", [asset, tenant, user]);
      for (const [id, created] of cases) {
        await old.query(
          `INSERT INTO cases (id, tenant_id, asset_id, kind, trigger, state, owner_id, pack_id, pack_version, decided_at, created_at)
           VALUES ($1, $2, $3, 'risk_review', 'initial', 'approved', $4, 'p', '1.0.0', $5, $5)`,
          [id, tenant, asset, user, created],
        );
      }
    };
    await seed(A, "tenant-a", userA, assetA, [
      ["00000000-0000-4000-8000-0000000000f2", "2026-02-01T00:00:00Z"],
      ["00000000-0000-4000-8000-0000000000f1", "2026-01-01T00:00:00Z"],
    ]);
    await seed(B, "tenant-b", userB, assetB, [["00000000-0000-4000-8000-0000000000f3", "2026-03-01T00:00:00Z"]]);
    expect(await migrate(old, { through: "0007_case_numbers.sql" })).toEqual(["0007_case_numbers.sql"]);
    const { rows } = await old.query<{ id: string; number: number }>("SELECT id, number FROM cases ORDER BY id");
    expect(rows.map((r) => [r.id.slice(-2), r.number])).toEqual([
      ["f1", 1],
      ["f2", 2],
      ["f3", 1],
    ]);
    await old.close();
  });

  it("counts up within each tenant, and never changes", async () => {
    const n = async (tenant: typeof A, caseId: string) =>
      withTenant(db, tenant, async (tx) => {
        const { rows } = await tx.query<{ number: number }>("SELECT number FROM cases WHERE id = $1", [caseId]);
        return rows[0]!.number;
      });
    const before = await withTenant(db, A, async (tx) => (await tx.query<{ n: number }>("SELECT count(*)::int AS n FROM cases")).rows[0]!.n);
    const first = "00000000-0000-4000-8000-0000000000d1";
    const second = "00000000-0000-4000-8000-0000000000d2";
    const other = "00000000-0000-4000-8000-0000000000d3";
    await withTenant(db, A, (tx) => tx.exec(insertCase(first, A, assetA, userA, "now()")));
    await withTenant(db, A, (tx) => tx.exec(insertCase(second, A, assetA, userA, "now()")));
    const bBefore = await withTenant(db, B, async (tx) => (await tx.query<{ n: number }>("SELECT count(*)::int AS n FROM cases")).rows[0]!.n);
    await withTenant(db, B, (tx) => tx.exec(insertCase(other, B, assetB, userB, "now()")));
    expect(await n(A, first)).toBe(before + 1);
    expect(await n(A, second)).toBe(before + 2);
    expect(await n(B, other)).toBe(bBefore + 1);
    await expect(withTenant(db, A, (tx) => tx.exec(`UPDATE cases SET number = 99 WHERE id = '${first}'`))).rejects.toThrow(
      /a case number cannot change/,
    );
  });
});

describe("audit chain order", () => {
  it("keeps chains written before the fix verified, and extends them in id order", async () => {
    const old = new PGlite();
    await migrate(old, { through: "0007_case_numbers.sql" });
    await old.query("INSERT INTO tenants (id, slug, name) VALUES ($1, 'tenant-a', 'A')", [A]);
    await withTenant(old, A, async (tx) => {
      await tx.exec(audit(A, "before.1"));
      await tx.exec(audit(A, "before.2"));
    });
    expect(await migrate(old)).toEqual(["0008_audit_chain_order.sql", "0009_token_controls.sql"]);
    await withTenant(old, A, async (tx) => {
      await tx.exec(audit(A, "after.1"));
      await tx.exec(audit(A, "after.2"));
    });
    const { rows } = await withTenant(old, A, (tx) =>
      tx.query<{ action: string; prev_hash: string | null; hash: string }>("SELECT action, prev_hash, hash FROM audit_events ORDER BY id"),
    );
    expect(rows.map((r) => r.action)).toEqual(["before.1", "before.2", "after.1", "after.2"]);
    expect(rows.slice(1).map((r) => r.prev_hash)).toEqual(rows.slice(0, -1).map((r) => r.hash));
    expect(await withTenant(old, A, verifyAuditChain)).toBeNull();
    await old.close();
  });
});
