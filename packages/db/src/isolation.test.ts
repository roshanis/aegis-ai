import { PGlite } from "@electric-sql/pglite";
import { tenantId } from "@aegis/domain";
import { beforeAll, describe, expect, it } from "vitest";
import { migrate } from "./migrate";
import { verifyAuditChain, withTenant } from "./tenant";

const A = tenantId("00000000-0000-4000-8000-00000000000a");
const B = tenantId("00000000-0000-4000-8000-00000000000b");
const userA = "00000000-0000-4000-8000-0000000000a1";
const userB = "00000000-0000-4000-8000-0000000000b1";

let db: PGlite;

async function seedTenant(id: string, slug: string, user: string) {
  // Provisioning runs as the owner role, outside tenant scope.
  await db.query("INSERT INTO tenants (id, slug, name) VALUES ($1, $2, $2)", [id, slug]);
  await db.query(
    "INSERT INTO users (id, tenant_id, email, display_name, roles) VALUES ($1, $2, $3, 'Req', '{requester}')",
    [user, id, `${slug}@example.test`],
  );
  await db.query("INSERT INTO policy_packs (tenant_id, pack_id, version, content) VALUES ($1, 'p', '1.0.0', '{}')", [id]);
}

const insertCase = (caseId: string, tenant: string, owner: string) =>
  `INSERT INTO cases (id, tenant_id, kind, title, state, owner_id, pack_id, pack_version)
   VALUES ('${caseId}', '${tenant}', 'initiative', 't', 'intake_draft', '${owner}', 'p', '1.0.0')`;

const audit = (tenant: string, action: string) =>
  `INSERT INTO audit_events (tenant_id, actor_kind, actor_id, action, at)
   VALUES ('${tenant}', 'system', 'test', '${action}', '2026-09-24T12:00:00Z')`;

beforeAll(async () => {
  db = new PGlite();
  expect(await migrate(db)).toEqual(["0001_tenancy.sql", "0002_audit_log.sql"]);
  expect(await migrate(db)).toEqual([]);
  await seedTenant(A, "tenant-a", userA);
  await seedTenant(B, "tenant-b", userB);
});

describe("tenant isolation", () => {
  it("shows each tenant only its own rows", async () => {
    await withTenant(db, A, (tx) => tx.exec(insertCase("00000000-0000-4000-8000-0000000000c1", A, userA)));
    await withTenant(db, B, (tx) => tx.exec(insertCase("00000000-0000-4000-8000-0000000000c2", B, userB)));

    const seenByA = await withTenant(db, A, (tx) => tx.query<{ id: string }>("SELECT id FROM cases"));
    expect(seenByA.rows.map((r) => r.id)).toEqual(["00000000-0000-4000-8000-0000000000c1"]);
    const tenantsSeenByB = await withTenant(db, B, (tx) => tx.query<{ slug: string }>("SELECT slug FROM tenants"));
    expect(tenantsSeenByB.rows).toEqual([{ slug: "tenant-b" }]);
  });

  it("refuses writes into another tenant", async () => {
    await expect(
      withTenant(db, A, (tx) => tx.exec(insertCase("00000000-0000-4000-8000-0000000000c3", B, userB))),
    ).rejects.toThrow(/row-level security/);
  });

  it("cannot update or delete another tenant's rows", async () => {
    const updated = await withTenant(db, A, (tx) =>
      tx.query("UPDATE cases SET title = 'hijacked' WHERE tenant_id = $1 RETURNING id", [B]),
    );
    expect(updated.rows).toEqual([]);
    const deleted = await withTenant(db, A, (tx) => tx.query("DELETE FROM users WHERE tenant_id = $1 RETURNING id", [B]));
    expect(deleted.rows).toEqual([]);
  });

  it("returns nothing when no tenant is set", async () => {
    await db.exec("BEGIN; SET LOCAL ROLE aegis_app;");
    const rows = await db.query("SELECT id FROM cases");
    await db.exec("COMMIT");
    expect(rows.rows).toEqual([]);
  });

  it("does not let the app role create tenants", async () => {
    await expect(
      withTenant(db, A, (tx) => tx.exec("INSERT INTO tenants (id, slug, name) VALUES (gen_random_uuid(), 'evil', 'x')")),
    ).rejects.toThrow(/permission denied/);
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

  it("rejects updates and deletes, even from the owner role", async () => {
    await expect(withTenant(db, A, (tx) => tx.exec("UPDATE audit_events SET reason = 'x'"))).rejects.toThrow();
    await expect(db.exec("UPDATE audit_events SET reason = 'x'")).rejects.toThrow(/append-only/);
    await expect(db.exec("DELETE FROM audit_events")).rejects.toThrow(/append-only/);
  });

  it("detects tampering that bypasses the triggers", async () => {
    await db.exec(`
      ALTER TABLE audit_events DISABLE TRIGGER audit_events_no_update;
      UPDATE audit_events SET reason = 'rewritten' WHERE id = (SELECT min(id) FROM audit_events WHERE tenant_id = '${A}');
      ALTER TABLE audit_events ENABLE TRIGGER audit_events_no_update;`);
    expect(await withTenant(db, A, verifyAuditChain)).not.toBeNull();
    expect(await withTenant(db, B, verifyAuditChain)).toBeNull();
  });
});
