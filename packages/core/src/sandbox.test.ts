import { PGlite } from "@electric-sql/pglite";
import { serialized, verifyAuditChain, withTenant, type Database } from "@aegis/db";
import { migrate } from "@aegis/db/migrate";
import type { TenantId } from "@aegis/domain";
import { healthcareAiPack } from "@aegis/frameworks";
import { beforeAll, describe, expect, it } from "vitest";
import { createGovernance, type Governance } from "./governance";
import { provisionTenant } from "./provision";
import { SANDBOX_LIFETIME_MS, createSandbox, purgeExpiredSandboxes, sandboxPersonas, type Persona } from "./sandbox";

const now = new Date("2026-09-24T12:00:00Z");
let pglite: PGlite;
let db: Database;
let gov: Governance;
let sandbox: { tenantId: TenantId; personas: Persona[] };

const as = async (name: string) => {
  const persona = sandbox.personas.find((p) => p.displayName === name)!;
  return (await gov.principal(sandbox.tenantId, persona.userId))!;
};

beforeAll(async () => {
  pglite = new PGlite();
  await migrate(pglite);
  db = serialized(pglite);
  gov = createGovernance(db, { now: () => now });
  sandbox = await createSandbox(db, now);
});

describe("sandbox", () => {
  it("gives the visitor one persona per role, with job titles", () => {
    expect(sandbox.personas.map((p) => [p.displayName, p.roles])).toEqual([
      ["Ada Morgan", ["admin"]],
      ["Riley Park", ["requester"]],
      ["Avery Brooks", ["approver"]],
      ["Aubrey Kim", ["auditor"]],
    ]);
    expect(sandbox.personas.every((p) => p.title)).toBe(true);
  });

  it("seeds an inventory that shows every state, through the real rules", async () => {
    const views = await gov.listAssetViews(await as("Aubrey Kim"));
    expect(views.map((v) => [v.asset.name, v.asset.state, v.openCase?.state ?? null, v.clearance.cleared])).toEqual([
      ["Prior-auth clinical summarizer", "active", null, true],
      ["Meeting-notes summarizer", "active", null, true],
      ["Claims triage agent", "paused", "draft", false],
      ["Provider fraud-scoring model", "registered", null, false],
      ["Member benefits chat assistant", "registered", "in_review", false],
    ]);
    expect(await withTenant(pglite, sandbox.tenantId, verifyAuditChain)).toBeNull();
  });

  it("leaves each persona something to do", async () => {
    const todo = async (name: string) =>
      (await gov.listAssetViews(await as(name)))
        .filter((v) => v.actions.openCase.length > 0)
        .map((v) => [v.asset.name, v.actions.openCase]);
    expect(await todo("Riley Park")).toEqual([["Claims triage agent", ["submit"]]]);
    expect(await todo("Avery Brooks")).toEqual([
      ["Member benefits chat assistant", ["approve", "conditionally_approve", "reject"]],
    ]);
  });

  it("dates the seeded history in the past", async () => {
    const [first] = await gov.listAssetViews(await as("Aubrey Kim"));
    const history = await gov.assetHistory(await as("Aubrey Kim"), first!.asset.id);
    expect(history.every((e) => e.at < now)).toBe(true);
  });

  it("offers personas only while the sandbox is live, and never for a real tenant", async () => {
    expect(await sandboxPersonas(db, sandbox.tenantId, now)).toHaveLength(4);
    const expired = new Date(now.getTime() + SANDBOX_LIFETIME_MS + 1);
    expect(await sandboxPersonas(db, sandbox.tenantId, expired)).toEqual([]);

    const { tenantId: real } = await db.run((conn) =>
      provisionTenant(conn, {
        tenant: { id: "00000000-0000-4000-8000-0000000000aa", slug: "real-payer", name: "Real payer" },
        admin: { email: "admin@real.test", displayName: "Admin" },
        packs: [healthcareAiPack],
      }),
    );
    expect(await sandboxPersonas(db, real, now)).toEqual([]);
  });

  it("purges expired sandboxes completely and leaves other tenants intact", async () => {
    const second = await createSandbox(db, new Date(now.getTime() + 60_000));
    const afterFirstExpires = new Date(now.getTime() + SANDBOX_LIFETIME_MS + 1);
    expect(await purgeExpiredSandboxes(db, afterFirstExpires)).toBe(1);

    const counts = await pglite.query<{ table: string; n: number }>(`
      SELECT 'tenants' AS table, count(*)::int AS n FROM tenants WHERE id = '${sandbox.tenantId}'
      UNION ALL SELECT 'audit_events', count(*)::int FROM audit_events WHERE tenant_id = '${sandbox.tenantId}'
      UNION ALL SELECT 'assets', count(*)::int FROM assets WHERE tenant_id = '${sandbox.tenantId}'`);
    expect(counts.rows.every((r) => r.n === 0)).toBe(true);

    expect(await sandboxPersonas(db, second.tenantId, afterFirstExpires)).toHaveLength(4);
    expect(await withTenant(pglite, second.tenantId, verifyAuditChain)).toBeNull();
    await expect(pglite.exec(`DELETE FROM audit_events WHERE tenant_id = '${second.tenantId}'`)).rejects.toThrow(
      /append-only/,
    );
  });
});
