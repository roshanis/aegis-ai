import { randomUUID } from "node:crypto";
import { withTenant, type Database } from "@aegis/db";
import { tenantId, userId, type HumanPrincipal, type Role, type SystemPrincipal, type TenantId } from "@aegis/domain";
import { healthcareAiPack } from "@aegis/frameworks";
import { createGovernance } from "./governance";
import { provisionTenant, purgeTenant } from "./provision";

/**
 * A sandbox is a real tenant for one visitor, seeded with a small payer's
 * AI inventory so every screen has something to show. It runs on the same
 * rules and audit log as any tenant, and is purged when it expires.
 */

export const SANDBOX_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

export interface Persona {
  readonly userId: string;
  readonly displayName: string;
  readonly title: string | null;
  readonly roles: readonly Role[];
}

type Field = (typeof healthcareAiPack.questions)[number]["field"];
const FIELDS = healthcareAiPack.questions.map((q) => q.field);
const yesTo = (...yes: Field[]) => Object.fromEntries(FIELDS.map((f) => [f, yes.includes(f)]));

/** Create and seed a sandbox tenant; the returned personas are who the visitor can act as. */
export async function createSandbox(
  db: Database,
  now: Date = new Date(),
): Promise<{ tenantId: TenantId; personas: Persona[] }> {
  const id = randomUUID();
  const mail = (name: string) => `${name}@${id.slice(0, 8)}.sandbox.aegis`;
  // Seed two weeks of history so the timeline reads like real use.
  let clock = now.getTime() - 14 * 24 * HOUR;
  const tick = () => new Date((clock += 3 * HOUR + 17 * 60 * 1000));

  const { tenantId: tenant, adminId } = await db.run((conn) =>
    provisionTenant(
      conn,
      {
        tenant: {
          id,
          slug: `sandbox-${id.slice(0, 8)}`,
          name: "Northwind Health Plan",
          sandboxExpiresAt: new Date(now.getTime() + SANDBOX_LIFETIME_MS),
        },
        admin: { email: mail("ada"), displayName: "Ada Morgan", title: "AI platform admin" },
        packs: [healthcareAiPack],
      },
      tick(),
    ),
  );

  const gov = createGovernance(db, { now: tick });
  const principal = (uid: string, displayName: string, roles: Role[]): HumanPrincipal => ({
    kind: "human",
    tenantId: tenant,
    userId: userId(uid),
    displayName,
    roles,
    reviewDomains: [],
  });
  const admin = principal(adminId, "Ada Morgan", ["admin"]);
  const add = async (displayName: string, title: string, roles: Role[]) =>
    principal(
      await gov.addUser(admin, { email: mail(displayName.split(" ")[0]!.toLowerCase()), displayName, title, roles }),
      displayName,
      roles,
    );
  const riley = await add("Riley Park", "Product owner, utilization management", ["requester"]);
  const avery = await add("Avery Brooks", "AI governance lead", ["approver"]);
  await add("Aubrey Kim", "Internal audit", ["auditor"]);
  const monitor: SystemPrincipal = { kind: "system", tenantId: tenant, job: "drift-monitor" };

  async function review(name: string, kind: "ai_system" | "agent" | "vendor_model", answers: Record<string, boolean>) {
    const asset = await gov.registerAsset(riley, { kind, name });
    const draft = await gov.openCase(riley, { assetId: asset.id });
    const { case: submitted } = await gov.submitCase(riley, draft.id, answers);
    return { assetId: asset.id, caseId: submitted.id };
  }

  // In use, with conditions.
  const summarizer = await review(
    "Prior-auth clinical summarizer",
    "ai_system",
    yesTo("phi", "humanInLoop", "vendorHosted"),
  );
  await gov.actOnCase(
    avery,
    summarizer.caseId,
    "conditionally_approve",
    "Keep PHI inside our Azure tenant, and re-validate summaries against nurse review every quarter.",
  );
  await gov.actOnAsset(admin, summarizer.assetId, "activate");

  // Fast-laned: low risk, under the pre-approved policy.
  const notes = await review("Meeting-notes summarizer", "vendor_model", yesTo());
  await gov.actOnAsset(admin, notes.assetId, "activate");

  // Paused by monitoring; an incident review waits on its owner.
  const agent = await review("Claims triage agent", "agent", yesTo("careCoverageInfluence", "phi", "individualImpact"));
  await gov.actOnCase(avery, agent.caseId, "approve", "Approved for a two-region pilot with weekly denial-rate reporting.");
  await gov.actOnAsset(admin, agent.assetId, "activate");
  await gov.actOnAsset(monitor, agent.assetId, "pause", "Denial rate drifted 14% above the pilot baseline.");
  await gov.openCase(admin, { assetId: agent.assetId, trigger: "incident" });

  // Rejected, so not cleared for use.
  const fraud = await review(
    "Provider fraud-scoring model",
    "vendor_model",
    yesTo("phi", "vendorHosted", "individualImpact", "humanInLoop"),
  );
  await gov.actOnCase(
    avery,
    fraud.caseId,
    "reject",
    "Providers get no explanation of their scores. Resubmit with reason codes and an appeal path.",
  );

  // Waiting on the approver.
  await review("Member benefits chat assistant", "ai_system", yesTo("memberFacing", "individualImpact", "humanInLoop"));

  return { tenantId: tenant, personas: await sandboxPersonas(db, tenant, now) };
}

/**
 * The people a visitor may switch between. Empty unless the tenant is a
 * live sandbox, so switching identity is impossible anywhere else.
 */
export async function sandboxPersonas(db: Database, tenant: TenantId, now: Date = new Date()): Promise<Persona[]> {
  return db.run((conn) =>
    withTenant(conn, tenant, async (tx) => {
      const live = await tx.query("SELECT 1 FROM tenants WHERE sandbox_expires_at > $1", [now.toISOString()]);
      if (live.rows.length === 0) return [];
      const { rows } = await tx.query<{ id: string; display_name: string; title: string | null; roles: Role[] }>(
        "SELECT id, display_name, title, roles FROM users ORDER BY created_at, id",
      );
      return rows.map((r) => ({ userId: r.id, displayName: r.display_name, title: r.title, roles: r.roles }));
    }),
  );
}

/** Purge every sandbox that has expired; returns how many were removed. Runs on the platform database. */
export async function purgeExpiredSandboxes(db: Database, now: Date = new Date()): Promise<number> {
  return db.run(async (conn) => {
    const { rows } = await conn.query<{ id: string }>(
      "SELECT id FROM tenants WHERE sandbox_expires_at IS NOT NULL AND sandbox_expires_at <= $1",
      [now.toISOString()],
    );
    for (const row of rows) await purgeTenant(conn, tenantId(row.id));
    return rows.length;
  });
}
