import { randomUUID } from "node:crypto";
import { withTenant, type Database } from "@aegis/db";
import { draftMemo, tenantId, userId, type HumanPrincipal, type Role, type SystemPrincipal, type TenantId } from "@aegis/domain";
import { healthcareAiPack } from "@aegis/frameworks";
import { createGovernance } from "./governance";
import { inlineJobs } from "./jobs";
import { provisionTenant, purgeTenant } from "./provision";

/**
 * A sandbox is a real tenant for one visitor, seeded with a small payer's
 * AI inventory so every screen has something to show. It runs on the same
 * rules and audit log as any tenant, and is purged when it expires. Its
 * agents run on the scripted model, which has no AI in it and sends
 * nothing anywhere; an admin can connect OpenAI instead.
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
  const tick = () => new Date((clock += 37 * 60 * 1000));

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

  // Seeding waits for each draft and evaluation, so the history reads in order.
  const jobs = inlineJobs(() => gov.agentRuntime, {
    holdUntilIdle: true,
    onError: (error) => {
      throw error;
    },
  });
  const gov = createGovernance(db, { now: tick, jobs });
  const principal = (uid: string, displayName: string, roles: Role[], reviewDomains: string[] = []): HumanPrincipal => ({
    kind: "human",
    tenantId: tenant,
    userId: userId(uid),
    displayName,
    roles,
    reviewDomains,
  });
  const admin = principal(adminId, "Ada Morgan", ["admin"]);
  const add = async (displayName: string, title: string, roles: Role[], reviewDomains: string[] = []) =>
    principal(
      await gov.addUser(admin, {
        email: mail(displayName.split(" ")[0]!.toLowerCase()),
        displayName,
        title,
        roles,
        reviewDomains,
      }),
      displayName,
      roles,
      reviewDomains,
    );
  const riley = await add("Riley Park", "Product owner, utilization management", ["requester"]);
  const avery = await add("Avery Brooks", "AI governance lead", ["approver"]);
  const rowan = await add("Rowan Ellis", "Privacy, security and data reviewer", ["reviewer"], [
    "privacy-hipaa",
    "security",
    "data-governance",
    "tech-architecture",
  ]);
  const jordan = await add("Jordan Lee", "Legal, clinical and responsible-AI reviewer", ["reviewer"], [
    "legal",
    "procurement",
    "clinical-safety",
    "responsible-ai",
  ]);
  await add("Aubrey Kim", "Internal audit", ["auditor"]);
  const monitor: SystemPrincipal = { kind: "system", tenantId: tenant, job: "drift-monitor" };

  // Ada connects the scripted model, both agents pass their golden sets, and she turns them on.
  await gov.connectModel(admin, { provider: "scripted", model: "scripted" });
  for (const agent of ["intake", "review-drafter"]) await gov.startEval(admin, agent);
  await jobs.idle();
  for (const agent of ["intake", "review-drafter"]) await gov.setAgentEnabled(admin, agent, true);

  async function review(
    name: string,
    kind: "ai_system" | "agent" | "vendor_model",
    answers: Record<string, boolean>,
    description?: string,
  ) {
    const asset = await gov.registerAsset(riley, { kind, name });
    const draft = await gov.openCase(riley, { assetId: asset.id });
    const suggested = description ? await gov.suggestIntake(riley, description) : null;
    const { case: submitted } = await gov.submitCase(riley, draft.id, answers, suggested ? { suggestionRunId: suggested.runId } : {});
    await jobs.idle();
    return { assetId: asset.id, caseId: submitted.id };
  }

  /** Riley evidences the gate controls, except any listed. */
  async function evidence(assetId: string, except: string[] = []) {
    const { assurance } = await gov.getAsset(riley, assetId);
    for (const control of assurance.controls) {
      if (control.enforcement !== "gate" || control.covered || except.includes(control.id)) continue;
      await gov.addEvidence(riley, {
        assetId,
        controlId: control.id,
        kind: "link",
        title: control.requiredEvidence,
        url: `https://northwind.sharepoint.example/governance/${control.id.toLowerCase()}`,
      });
    }
    // Each piece of evidence sends its domain's draft back to the drafter.
    await jobs.idle();
  }

  /** Each reviewer signs the open reviews they can sign, from the drafter's memo, except any listed. */
  async function sign(assetId: string, except: string[] = [], proposals: Record<string, string[]> = {}) {
    for (const reviewer of [rowan, jordan]) {
      const { assurance } = await gov.getAsset(reviewer, assetId);
      for (const r of assurance.reviews) {
        if (!r.actions.includes("sign") || except.includes(r.domain)) continue;
        await gov.reviewDomain(reviewer, r.caseId, r.domain, "sign", {
          expectedRevision: r.revision,
          ...(r.draft.content ? { note: draftMemo(r.draft.content) } : {}),
          ...(proposals[r.domain] ? { proposedConditions: proposals[r.domain] } : {}),
        });
      }
    }
  }

  // In use, with one condition met before launch and one ongoing.
  const summarizer = await review("Prior-auth clinical summarizer", "ai_system", yesTo("phi", "humanInLoop", "vendorHosted"));
  await evidence(summarizer.assetId);
  await sign(summarizer.assetId, [], { "privacy-hipaa": ["Keep PHI inside our Azure tenant, with no cross-region replication"] });
  await gov.actOnCase(avery, summarizer.caseId, "conditionally_approve", "Approved for nurse-reviewed prior-auth summaries.", {
    conditions: [
      { text: "Keep PHI inside our Azure tenant, with no cross-region replication", due: "before_use" },
      { text: "Re-validate summaries against nurse review every quarter", due: "ongoing" },
    ],
  });
  const beforeUse = (await gov.getAsset(riley, summarizer.assetId)).assurance.conditions.find((c) => c.due === "before_use");
  await gov.addEvidence(riley, {
    assetId: summarizer.assetId,
    conditionId: beforeUse!.id,
    kind: "attestation",
    title: "Replication disabled",
    detail: "Geo-replication is off for the summarizer's storage account; region pinned to East US 2.",
  });
  await gov.actOnCondition(riley, beforeUse!.id, "submit");
  await gov.actOnCondition(avery, beforeUse!.id, "accept");
  await gov.actOnAsset(admin, summarizer.assetId, "activate");

  // Fast-laned: low risk, under the pre-approved policy.
  const notes = await review("Meeting-notes summarizer", "vendor_model", yesTo());
  await gov.actOnAsset(admin, notes.assetId, "activate");

  // Fast-laned, but its vendor gate controls still need evidence before use.
  await review("Call transcription API", "vendor_model", yesTo("vendorHosted"));

  // Paused by monitoring; an incident review waits on its owner.
  const agent = await review("Claims triage agent", "agent", yesTo("careCoverageInfluence", "phi", "individualImpact"));
  await evidence(agent.assetId);
  await sign(agent.assetId);
  await gov.actOnCase(avery, agent.caseId, "approve", "Approved for a two-region pilot with weekly denial-rate reporting.");
  await gov.actOnAsset(admin, agent.assetId, "activate");
  await gov.actOnAsset(monitor, agent.assetId, "pause", "Denial rate drifted 14% above the pilot baseline.");
  await gov.openCase(admin, { assetId: agent.assetId, trigger: "incident" });

  // Rejected after the responsible-AI reviewer returned it, so not cleared for use.
  const fraud = await review(
    "Provider fraud-scoring model",
    "vendor_model",
    yesTo("phi", "vendorHosted", "individualImpact", "humanInLoop"),
  );
  await evidence(fraud.assetId);
  await sign(fraud.assetId, ["responsible-ai"]);
  const returned = (await gov.getAsset(jordan, fraud.assetId)).assurance.reviews.find((r) => r.domain === "responsible-ai")!;
  await gov.reviewDomain(jordan, fraud.caseId, "responsible-ai", "return", {
    expectedRevision: returned.revision,
    note: "How does a provider learn why they were scored? I see no reason codes or appeal path.",
  });
  await gov.actOnCase(
    avery,
    fraud.caseId,
    "reject",
    "Providers get no explanation of their scores. Resubmit with reason codes and an appeal path.",
  );

  // In review: most domains signed; fairness testing waits on an exception only the approver can grant.
  const chat = await review(
    "Member benefits chat assistant",
    "ai_system",
    yesTo("memberFacing", "individualImpact", "humanInLoop"),
    "A chat assistant on the member portal answers members' questions about their benefits. A service agent approves every answer before the member sees it during the pilot.",
  );
  await evidence(chat.assetId, ["R-01"]);
  await sign(chat.assetId, ["legal", "responsible-ai"]);
  await gov.requestException(riley, {
    assetId: chat.assetId,
    controlId: "R-01",
    reason: "Fairness testing needs four weeks of pilot conversations; it runs before general availability.",
    days: 60,
  });

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
