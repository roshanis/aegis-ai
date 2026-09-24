import { PGlite } from "@electric-sql/pglite";
import { serialized, verifyAuditChain, withTenant } from "@aegis/db";
import { migrate } from "@aegis/db/migrate";
import { userId, type HumanPrincipal, type Role, type SystemPrincipal, type TenantId } from "@aegis/domain";
import { financialCommunicationsPack, healthcareAiPack } from "@aegis/frameworks";
import { beforeAll, describe, expect, it } from "vitest";
import { GovernanceError } from "./errors";
import { createGovernance, type Governance } from "./governance";
import { provisionTenant } from "./provision";

/** Answers that triage to high risk: PHI, vendor-hosted, a person checks every output. */
const HIGH_RISK = {
  phi: true,
  memberFacing: false,
  careCoverageInfluence: false,
  humanInLoop: true,
  vendorHosted: true,
  individualImpact: false,
};
/** Answers that triage to low risk and qualify for the fast lane. */
const LOW_RISK = { ...HIGH_RISK, phi: false, vendorHosted: false };

let db: PGlite;
let gov: Governance;
let clock = Date.UTC(2026, 8, 24, 12);

interface Team {
  tenant: TenantId;
  admin: HumanPrincipal;
  requester: HumanPrincipal;
  otherRequester: HumanPrincipal;
  approver: HumanPrincipal;
  reviewer: HumanPrincipal;
  auditor: HumanPrincipal;
  monitor: SystemPrincipal;
}

function person(tenant: TenantId, id: string, displayName: string, roles: Role[], reviewDomains: string[] = []): HumanPrincipal {
  return { kind: "human", tenantId: tenant, userId: userId(id), displayName, roles, reviewDomains };
}

async function provisionTeam(tenantUuid: string, slug: string): Promise<Team> {
  const { tenantId: tenant, adminId } = await provisionTenant(db, {
    tenant: { id: tenantUuid, slug, name: slug },
    admin: { email: `admin@${slug}.test`, displayName: "Ada Admin" },
    packs: [healthcareAiPack, financialCommunicationsPack],
  });
  const admin = person(tenant, adminId, "Ada Admin", ["admin"]);
  const add = async (name: string, roles: Role[], domains: string[] = []) =>
    person(
      tenant,
      await gov.addUser(admin, { email: `${name.split(" ")[0]!.toLowerCase()}@${slug}.test`, displayName: name, roles, reviewDomains: domains }),
      name,
      roles,
      domains,
    );
  return {
    tenant,
    admin,
    requester: await add("Riley Requester", ["requester"]),
    otherRequester: await add("Quinn Requester", ["requester"]),
    approver: await add("Avery Approver", ["approver"]),
    reviewer: await add("Rowan Reviewer", ["reviewer"], ["privacy-hipaa"]),
    auditor: await add("Aubrey Auditor", ["auditor"]),
    monitor: { kind: "system", tenantId: tenant, job: "drift-monitor" },
  };
}

let a: Team;
let b: Team;

beforeAll(async () => {
  db = new PGlite();
  await migrate(db);
  gov = createGovernance(serialized(db), { now: () => new Date((clock += 60_000)) });
  a = await provisionTeam("00000000-0000-4000-8000-00000000000a", "payer-a");
  b = await provisionTeam("00000000-0000-4000-8000-00000000000b", "payer-b");
});

describe("an AI system from intake to use", () => {
  it("registers, triages, routes to review, and blocks use until approved", async () => {
    const asset = await gov.registerAsset(a.requester, { kind: "ai_system", name: "Prior-auth summarizer" });
    expect(asset.state).toBe("registered");

    const draft = await gov.openCase(a.requester, { assetId: asset.id });
    expect(draft).toMatchObject({ kind: "risk_review", trigger: "initial", state: "draft", packId: "healthcare-ai" });

    const { case: submitted, fastLane } = await gov.submitCase(a.requester, draft.id, HIGH_RISK);
    expect(submitted.state).toBe("in_review");
    expect(submitted.tier).toBe("high");
    expect(submitted.triage?.domains).toEqual(["data-governance", "legal", "privacy-hipaa", "procurement", "responsible-ai", "security", "tech-architecture"]);
    expect(submitted.triage?.explanation[0]).toBe("high tier: uses protected health information");
    expect(fastLane).toMatchObject({ eligible: false, reasons: ["tier is above low", "initiative touches PHI"] });

    await expect(gov.actOnAsset(a.admin, asset.id, "activate")).rejects.toThrow(/no review has approved it yet/);

    const approverView = await gov.getAsset(a.approver, asset.id);
    expect(approverView.actions.openCase).toEqual(["approve", "conditionally_approve", "reject"]);
    expect((await gov.getAsset(a.requester, asset.id)).actions.openCase).toEqual([]);

    await expect(gov.actOnCase(a.requester, draft.id, "approve")).rejects.toThrow(/case.decide/);
    const decided = await gov.actOnCase(a.approver, draft.id, "conditionally_approve", "Retention control C-12 live before launch");
    expect(decided.state).toBe("conditionally_approved");
    expect(decided.decidedAt).not.toBeNull();

    const active = await gov.actOnAsset(a.admin, asset.id, "activate");
    expect(active.state).toBe("active");
    expect(await withTenant(db, a.tenant, verifyAuditChain)).toBeNull();
  });

  it("answers who approved it, why, and under which policy version", async () => {
    const [asset] = await gov.listAssets(a.auditor);
    const history = await gov.assetHistory(a.auditor, asset!.id);
    expect(history.map((e) => e.action)).toEqual([
      "asset.register",
      "case.open",
      "case.submit",
      "case.triage",
      "case.start_review",
      "case.conditionally_approve",
      "asset.activate",
    ]);

    const [decision] = history.filter((e) => e.decision);
    expect(decision).toMatchObject({
      after: "conditionally_approved",
      actor: { kind: "human", name: "Avery Approver" },
      reason: "Retention control C-12 live before launch",
      reasonStatus: "intact",
      policy: { packId: "healthcare-ai", packVersion: "1.0.0" },
    });
    const triaged = history.find((e) => e.action === "case.triage")!;
    expect(triaged.actor).toMatchObject({ kind: "system", id: "system:triage" });
    expect(triaged.payload).toMatchObject({ tier: "high", tierRuleId: "phi" });
    expect(history.at(-1)!.payload).toEqual({ clearingCaseId: decision!.caseId });
  });
});

describe("re-review", () => {
  it("opens a new case on the same asset and follows its outcome", async () => {
    const [asset] = await gov.listAssets(a.requester);
    await gov.actOnAsset(a.monitor, asset!.id, "pause", "Drift alert: denial rate up 12%");
    const incident = await gov.openCase(a.admin, { assetId: asset!.id, trigger: "incident" });
    expect(incident.ownerId).toBe(a.requester.userId);

    await expect(gov.actOnAsset(a.admin, asset!.id, "resume", "false alarm")).rejects.toThrow(
      /an incident review is still open/,
    );
    await gov.submitCase(a.requester, incident.id, HIGH_RISK);
    await gov.actOnCase(a.approver, incident.id, "reject", "Denial drift unexplained; retrain first");
    await expect(gov.actOnAsset(a.admin, asset!.id, "resume", "retrained")).rejects.toThrow(/was rejected/);

    const view = await gov.getAsset(a.auditor, asset!.id);
    expect(view.asset.state).toBe("paused");
    expect(view.cases.map((c) => [c.trigger, c.state])).toEqual([
      ["initial", "conditionally_approved"],
      ["incident", "rejected"],
    ]);
    expect(view.clearance.cleared).toBe(false);
  });

  it("allows one open case at a time, and only one initial review", async () => {
    const asset = await gov.registerAsset(a.requester, { kind: "agent", name: "Claims triage agent" });
    const first = await gov.openCase(a.requester, { assetId: asset.id });
    await expect(gov.openCase(a.admin, { assetId: asset.id, trigger: "change" })).rejects.toThrow(/still open/);
    await gov.submitCase(a.requester, first.id, HIGH_RISK);
    await gov.actOnCase(a.approver, first.id, "approve");
    await expect(gov.openCase(a.requester, { assetId: asset.id })).rejects.toThrow(/reviewed before/);
    expect((await gov.openCase(a.requester, { assetId: asset.id, trigger: "change" })).trigger).toBe("change");
  });
});

describe("fast lane", () => {
  it("approves low-risk work under the pre-approved policy and names who is accountable", async () => {
    const asset = await gov.registerAsset(a.requester, { kind: "vendor_model", name: "Meeting-notes summarizer" });
    const draft = await gov.openCase(a.requester, { assetId: asset.id });
    const { case: approved, fastLane } = await gov.submitCase(a.requester, draft.id, LOW_RISK);
    expect(fastLane?.eligible).toBe(true);
    expect(approved).toMatchObject({ state: "fast_lane_approved", tier: "low" });

    const decision = (await gov.assetHistory(a.auditor, asset.id)).find((e) => e.decision)!;
    expect(decision.actor.id).toBe("system:triage");
    expect(decision.payload).toMatchObject({ accountableApprover: "VP, AI Governance" });
    expect((await gov.actOnAsset(a.admin, asset.id, "activate")).state).toBe("active");
  });
});

describe("intake", () => {
  it("tells the requester exactly which questions are unanswered or unknown", async () => {
    const asset = await gov.registerAsset(a.requester, { kind: "ai_system", name: "Call-center copilot" });
    const draft = await gov.openCase(a.requester, { assetId: asset.id });
    await expect(gov.submitCase(a.requester, draft.id, { phi: true })).rejects.toThrow(
      "answer every question before submitting: memberFacing, careCoverageInfluence, humanInLoop, vendorHosted, individualImpact",
    );
    await expect(gov.submitCase(a.requester, draft.id, { ...HIGH_RISK, mood: true })).rejects.toThrow(/unknown questions: mood/);
    await expect(gov.submitCase(a.requester, draft.id, { ...HIGH_RISK, phi: "yes" })).rejects.toThrow(/phi/);
    expect((await gov.getAsset(a.requester, asset.id)).actions.openCase).toEqual(["submit"]);
  });

  it("routes content to a content review under the content pack", async () => {
    const asset = await gov.registerAsset(a.requester, { kind: "content_item", name: "Quarterly newsletter draft" });
    const draft = await gov.openCase(a.requester, { assetId: asset.id });
    expect(draft).toMatchObject({ kind: "content_review", packId: financialCommunicationsPack.id });
    const { case: submitted } = await gov.submitCase(a.requester, draft.id);
    expect(submitted.state).toBe("submitted");
    await expect(gov.actOnCase(a.approver, draft.id, "approve", "fine")).rejects.toThrow(/no 'approve' from 'submitted'/);
  });
});

describe("access", () => {
  it("shows requesters only their own assets", async () => {
    const [mine] = await gov.listAssets(a.requester);
    expect((await gov.listAssets(a.otherRequester)).length).toBe(0);
    await expect(gov.getAsset(a.otherRequester, mine!.id)).rejects.toMatchObject({ code: "not_found" });
    await expect(gov.openCase(a.otherRequester, { assetId: mine!.id, trigger: "change" })).rejects.toThrow(
      GovernanceError,
    );
  });

  it("hides every record from another tenant, even to its admins and approvers", async () => {
    const [assetA] = await gov.listAssets(a.auditor);
    const caseA = (await gov.getAsset(a.auditor, assetA!.id)).cases[0]!;
    expect(await gov.listAssets(b.auditor)).toEqual([]);
    await expect(gov.getAsset(b.admin, assetA!.id)).rejects.toMatchObject({ code: "not_found" });
    await expect(gov.actOnCase(b.approver, caseA.id, "approve")).rejects.toMatchObject({ code: "not_found" });
    await expect(gov.actOnAsset(b.admin, assetA!.id, "retire", "x")).rejects.toMatchObject({ code: "not_found" });
  });

  it("refuses incompatible roles when a person is added", async () => {
    await expect(
      gov.addUser(a.admin, { email: "both@payer-a.test", displayName: "Both", roles: ["requester", "approver"] }),
    ).rejects.toThrow(/requester and approver cannot be held by the same person/);
    await expect(
      gov.addUser(a.approver, { email: "x@payer-a.test", displayName: "X", roles: ["auditor"] }),
    ).rejects.toMatchObject({ code: "forbidden" });
  });
});

describe("erasure", () => {
  it("deletes a written reason without breaking the audit chain, and says so in the history", async () => {
    const [asset] = await gov.listAssets(a.auditor);
    await withTenant(db, a.tenant, (tx) =>
      tx.query("DELETE FROM notes WHERE body = 'Retention control C-12 live before launch'"),
    );
    const decision = (await gov.assetHistory(a.auditor, asset!.id)).find((e) => e.decision)!;
    expect(decision).toMatchObject({ reason: null, reasonStatus: "erased", actor: { name: "Avery Approver" } });
    expect(await withTenant(db, a.tenant, verifyAuditChain)).toBeNull();
    expect(await withTenant(db, b.tenant, verifyAuditChain)).toBeNull();
  });
});
