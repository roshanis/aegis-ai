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
      ["Rowan Ellis", ["reviewer"]],
      ["Jordan Lee", ["reviewer"]],
      ["Aubrey Kim", ["auditor"]],
    ]);
    expect(sandbox.personas.every((p) => p.title)).toBe(true);
  });

  it("seeds an inventory that shows every state, through the real rules", async () => {
    const views = await gov.listAssetViews(await as("Aubrey Kim"));
    expect(views.map((v) => [v.asset.name, v.asset.state, v.openCase?.state ?? null, v.clearance.cleared])).toEqual([
      ["Prior-auth clinical summarizer", "active", null, true],
      ["Meeting-notes summarizer", "active", null, true],
      ["Call transcription API", "registered", null, false],
      ["Claims triage agent", "paused", "draft", false],
      ["Provider fraud-scoring model", "registered", null, false],
      ["Member benefits chat assistant", "registered", "in_review", false],
    ]);
    const transcription = views.find((v) => v.asset.name === "Call transcription API")!;
    expect(transcription.clearance).toMatchObject({
      cleared: false,
      reason: "L-01 Vendor contract AI addendum has no evidence or exception; P-01 Vendor risk assessment has no evidence or exception",
    });
    expect(await withTenant(pglite, sandbox.tenantId, verifyAuditChain)).toBeNull();
  });

  it("leaves each persona something to do", async () => {
    const views = async (name: string) => gov.listAssetViews(await as(name));
    const chat = async (name: string) => (await views(name)).find((v) => v.asset.name === "Member benefits chat assistant")!;

    const riley = await views("Riley Park");
    expect(riley.filter((v) => v.actions.openCase.length > 0).map((v) => [v.asset.name, v.actions.openCase])).toEqual([
      ["Claims triage agent", ["submit"]],
    ]);

    const jordan = await chat("Jordan Lee");
    expect(jordan.assurance.reviews.filter((r) => r.actions.includes("sign")).map((r) => [r.domain, r.uncoveredGates])).toEqual([
      ["legal", []],
      ["responsible-ai", ["R-01"]],
    ]);

    const avery = await chat("Avery Brooks");
    expect(avery.assurance.readiness).toMatchObject({ canApprove: false, approvalBlockers: ["legal:pending", "responsible-ai:pending"] });
    expect(avery.assurance.controls.find((c) => c.id === "R-01")?.exception).toMatchObject({
      state: "requested",
      actions: ["approve", "reject"],
    });
    expect((await chat("Riley Park")).assurance.controls.find((c) => c.id === "R-01")?.exception?.actions).toEqual([]);
  });

  it("records the conditional approval's conditions and the evidence that met them", async () => {
    const summarizer = (await gov.listAssetViews(await as("Aubrey Kim"))).find(
      (v) => v.asset.name === "Prior-auth clinical summarizer",
    )!;
    expect(summarizer.assurance.conditions.map((c) => [c.due, c.state, c.evidence.length])).toEqual([
      ["before_use", "met", 1],
      ["ongoing", "open", 0],
    ]);
    expect(summarizer.assurance.controls.filter((c) => c.enforcement === "gate").every((c) => c.covered)).toBe(true);
  });

  it("dates all seeded history, evidence included, in the past", async () => {
    const auditor = await as("Aubrey Kim");
    for (const view of await gov.listAssetViews(auditor)) {
      const history = await gov.assetHistory(auditor, view.asset.id);
      expect(history.every((e) => e.at < now), view.asset.name).toBe(true);
      const evidence = view.assurance.controls.flatMap((c) => c.evidence);
      expect(evidence.every((e) => e.addedAt < now), view.asset.name).toBe(true);
    }
  });

  it("offers personas only while the sandbox is live, and never for a real tenant", async () => {
    expect(await sandboxPersonas(db, sandbox.tenantId, now)).toHaveLength(6);
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

    expect(await sandboxPersonas(db, second.tenantId, afterFirstExpires)).toHaveLength(6);
    expect(await withTenant(pglite, second.tenantId, verifyAuditChain)).toBeNull();
    await expect(pglite.exec(`DELETE FROM audit_events WHERE tenant_id = '${second.tenantId}'`)).rejects.toThrow(
      /append-only/,
    );
  });
});
