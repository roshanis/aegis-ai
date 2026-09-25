import { PGlite } from "@electric-sql/pglite";
import { serialized, verifyAuditChain, withTenant } from "@aegis/db";
import { migrate } from "@aegis/db/migrate";
import { userId, type HumanPrincipal, type Role, type TenantId } from "@aegis/domain";
import { healthcareAiPack } from "@aegis/frameworks";
import { beforeAll, describe, expect, it } from "vitest";
import { createGovernance, type Governance } from "./governance";
import { provisionTenant } from "./provision";
import { ALL_DOMAINS, readyForDecision } from "./test-support";

/** High risk: PHI, vendor-hosted, a person checks every output. Seven review domains. */
const HIGH_RISK = {
  phi: true,
  memberFacing: false,
  careCoverageInfluence: false,
  humanInLoop: true,
  vendorHosted: true,
  individualImpact: false,
};
/** Low risk but vendor-hosted: fast-laned, with vendor gate controls. */
const VENDOR_ONLY = { ...HIGH_RISK, phi: false, humanInLoop: false };

let db: PGlite;
let gov: Governance;
let clock = Date.UTC(2026, 8, 25, 12);
const DAY = 86_400_000;

let tenant: TenantId;
let admin: HumanPrincipal;
let requester: HumanPrincipal;
let approver: HumanPrincipal;
let secondApprover: HumanPrincipal;
let reviewer: HumanPrincipal;
let privacyReviewer: HumanPrincipal;
let builderReviewer: HumanPrincipal;
let outsider: HumanPrincipal;

const person = (id: string, name: string, roles: Role[], domains: string[] = []): HumanPrincipal => ({
  kind: "human",
  tenantId: tenant,
  userId: userId(id),
  displayName: name,
  roles,
  reviewDomains: domains,
});

async function registerAndSubmit(name: string, answers: Record<string, boolean>, owner = requester) {
  const asset = await gov.registerAsset(owner, { kind: "ai_system", name });
  const draft = await gov.openCase(owner, { assetId: asset.id });
  const { case: submitted } = await gov.submitCase(owner, draft.id, answers);
  return { assetId: asset.id, caseId: submitted.id, state: submitted.state };
}

const reviewOf = async (viewer: HumanPrincipal, assetId: string, domain: string) =>
  (await gov.getAsset(viewer, assetId)).assurance.reviews.find((r) => r.domain === domain)!;

beforeAll(async () => {
  db = new PGlite();
  await migrate(db);
  gov = createGovernance(serialized(db), { now: () => new Date((clock += 60_000)) });
  const provisioned = await provisionTenant(db, {
    tenant: { id: "00000000-0000-4000-8000-0000000000c0", slug: "payer-c", name: "Payer C" },
    admin: { email: "admin@payer-c.test", displayName: "Ada Admin" },
    packs: [healthcareAiPack],
  });
  tenant = provisioned.tenantId;
  admin = person(provisioned.adminId, "Ada Admin", ["admin"]);
  const add = async (name: string, roles: Role[], domains: string[] = []) =>
    person(
      await gov.addUser(admin, { email: `${name.split(" ")[0]!.toLowerCase()}@payer-c.test`, displayName: name, roles, reviewDomains: domains }),
      name,
      roles,
      domains,
    );
  requester = await add("Riley Requester", ["requester"]);
  approver = await add("Avery Approver", ["approver"]);
  secondApprover = await add("Sam Approver", ["approver"]);
  reviewer = await add("Rowan Reviewer", ["reviewer"], ALL_DOMAINS);
  privacyReviewer = await add("Pat Privacy", ["reviewer"], ["privacy-hipaa"]);
  // Requesters may also review, which is exactly why nobody may review their own case.
  builderReviewer = await add("Blake Builder", ["requester", "reviewer"], ALL_DOMAINS);

  const other = await provisionTenant(db, {
    tenant: { id: "00000000-0000-4000-8000-0000000000d0", slug: "payer-d", name: "Payer D" },
    admin: { email: "admin@payer-d.test", displayName: "Other Admin" },
    packs: [healthcareAiPack],
  });
  outsider = { ...person(other.adminId, "Other Admin", ["admin"]), tenantId: other.tenantId };
});

describe("domain reviews", () => {
  it("opens one pending review per required domain when a case enters review", async () => {
    const { assetId } = await registerAndSubmit("Review opening", HIGH_RISK);
    const { assurance } = await gov.getAsset(reviewer, assetId);
    expect(assurance.reviews.map((r) => [r.domain, r.status, r.revision])).toEqual(
      ["data-governance", "legal", "privacy-hipaa", "procurement", "responsible-ai", "security", "tech-architecture"].map(
        (d) => [d, "pending", 0],
      ),
    );
    expect(assurance.readiness).toMatchObject({ canApprove: false, canReject: true });
  });

  it("will not sign a domain until its gate controls are evidenced or excepted", async () => {
    const { assetId, caseId } = await registerAndSubmit("Gate before signature", HIGH_RISK);
    const privacy = await reviewOf(privacyReviewer, assetId, "privacy-hipaa");
    expect(privacy.uncoveredGates).toEqual(["H-01", "H-02"]);
    await expect(
      gov.reviewDomain(privacyReviewer, caseId, "privacy-hipaa", "sign", { expectedRevision: privacy.revision }),
    ).rejects.toThrow("attach evidence or approve an exception first: H-01 PHI minimization and BAA, H-02 De-identification validation");

    await gov.addEvidence(requester, { assetId, controlId: "H-01", kind: "link", title: "DPIA and BAA", url: "https://docs.example.test/h01" });
    await gov.addEvidence(requester, {
      assetId,
      controlId: "H-02",
      kind: "attestation",
      title: "Expert determination",
      detail: "Validated by the privacy office on 2026-09-20.",
    });
    const signed = await gov.reviewDomain(privacyReviewer, caseId, "privacy-hipaa", "sign", {
      expectedRevision: privacy.revision,
      note: "PHI stays in-tenant.",
      proposedConditions: ["Keep PHI inside our Azure tenant"],
    });
    expect(signed).toEqual({ status: "signed", revision: 1 });
    expect(await reviewOf(approver, assetId, "privacy-hipaa")).toMatchObject({
      status: "signed",
      reviewer: { name: "Pat Privacy" },
      note: "PHI stays in-tenant.",
      proposedConditions: ["Keep PHI inside our Azure tenant"],
      actions: [],
    });
  });

  it("scopes reviewers to their domains and never lets anyone review their own case", async () => {
    const { assetId, caseId } = await registerAndSubmit("Own case", HIGH_RISK, builderReviewer);
    const legal = await reviewOf(privacyReviewer, assetId, "legal");
    expect(legal.actions).toEqual([]);
    await expect(
      gov.reviewDomain(privacyReviewer, caseId, "legal", "abstain", { expectedRevision: 0, note: "n/a" }),
    ).rejects.toThrow(/only a legal reviewer/);
    expect((await reviewOf(builderReviewer, assetId, "legal")).actions).toEqual([]);
    await expect(
      gov.reviewDomain(builderReviewer, caseId, "legal", "abstain", { expectedRevision: 0, note: "mine" }),
    ).rejects.toThrow(/nobody reviews a case they submitted/);
  });

  it("returns a review with a question, and the requester's answer sends it back to pending", async () => {
    const { assetId, caseId } = await registerAndSubmit("Return and respond", HIGH_RISK);
    await gov.reviewDomain(reviewer, caseId, "procurement", "return", {
      expectedRevision: 0,
      note: "Which vendor region hosts inference?",
    });
    const returned = await reviewOf(requester, assetId, "procurement");
    expect(returned).toMatchObject({ status: "returned", note: "Which vendor region hosts inference?", actions: ["respond"] });
    await expect(
      gov.reviewDomain(requester, caseId, "procurement", "respond", { expectedRevision: 1 }),
    ).rejects.toThrow(/written reason/);
    await gov.reviewDomain(requester, caseId, "procurement", "respond", { expectedRevision: 1, note: "East US 2 only." });
    expect(await reviewOf(reviewer, assetId, "procurement")).toMatchObject({
      status: "pending",
      revision: 2,
      note: "East US 2 only.",
      reviewer: { name: "Rowan Reviewer" },
    });
  });

  it("refuses a change made from a stale screen", async () => {
    const { caseId } = await registerAndSubmit("Stale revision", HIGH_RISK);
    await gov.reviewDomain(reviewer, caseId, "legal", "return", { expectedRevision: 0, note: "Contract?" });
    await expect(
      gov.reviewDomain(reviewer, caseId, "legal", "abstain", { expectedRevision: 0, note: "conflict" }),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("records an abstention without resolving the case, and resumes to pending (Jeeves acceptance)", async () => {
    const { assetId, caseId } = await registerAndSubmit("Abstention", HIGH_RISK);
    await gov.reviewDomain(reviewer, caseId, "security", "abstain", {
      expectedRevision: 0,
      note: "I helped design this proposal and cannot independently review it.",
    });
    const view = await gov.getAsset(approver, assetId);
    expect(view.openCase?.state).toBe("in_review");
    expect(view.assurance.readiness?.approvalBlockers).not.toContain("security:abstained");
    await gov.reviewDomain(reviewer, caseId, "security", "resume", { expectedRevision: 1 });
    expect(await reviewOf(approver, assetId, "security")).toMatchObject({ status: "pending", revision: 2 });
    const actions = (await gov.assetHistory(approver, assetId)).map((e) => e.action);
    expect(actions.filter((a) => a === "review.abstain")).toHaveLength(1);
    expect(actions.filter((a) => a === "review.resume")).toHaveLength(1);
  });
});

describe("decisions with conditions", () => {
  it("waits for every signature, then requires at least one condition on a conditional approval", async () => {
    const { assetId, caseId } = await registerAndSubmit("Conditional approval", HIGH_RISK);
    await expect(gov.actOnCase(approver, caseId, "approve")).rejects.toThrow(/Waiting on: data-governance:pending/);
    await readyForDecision(gov, requester, reviewer, assetId);
    await expect(gov.actOnCase(approver, caseId, "conditionally_approve", "OK with conditions")).rejects.toThrow(
      /at least one condition/,
    );
    await gov.actOnCase(approver, caseId, "conditionally_approve", "OK with conditions", {
      conditions: [
        { text: "Disable cross-region replication", due: "before_use" },
        { text: "Quarterly accuracy review", due: "ongoing" },
      ],
    });
    const view = await gov.getAsset(requester, assetId);
    expect(view.clearance).toMatchObject({ cleared: false, reason: "1 condition must be met before use" });
    await expect(gov.actOnAsset(admin, assetId, "activate")).rejects.toThrow(/1 condition must be met before use/);
  });

  it("clears for use once the owner shows the condition is met and an approver accepts it", async () => {
    const assetId = (await gov.listAssetViews(requester)).find((v) => v.asset.name === "Conditional approval")!.asset.id;
    const condition = (await gov.getAsset(requester, assetId)).assurance.conditions.find((c) => c.due === "before_use")!;
    expect(condition.actions).toEqual(["submit"]);
    await expect(gov.actOnCondition(requester, condition.id, "submit")).rejects.toThrow(/attach evidence/);
    await gov.addEvidence(requester, {
      assetId,
      conditionId: condition.id,
      kind: "attestation",
      title: "Replication off",
      detail: "Storage account pinned to East US 2.",
    });
    await gov.actOnCondition(requester, condition.id, "submit");
    await expect(gov.actOnCondition(requester, condition.id, "accept")).rejects.toThrow(/case.decide/);
    await expect(gov.actOnCondition(approver, condition.id, "return")).rejects.toThrow(/written reason/);
    await gov.actOnCondition(approver, condition.id, "accept");

    const view = await gov.getAsset(admin, assetId);
    expect(view.clearance.cleared).toBe(true);
    expect((await gov.actOnAsset(admin, assetId, "activate")).state).toBe("active");
    expect(view.assurance.conditions.map((c) => [c.due, c.state])).toEqual([
      ["before_use", "met"],
      ["ongoing", "open"],
    ]);
  });
});

describe("controls and exceptions", () => {
  it("keeps a fast-laned vendor model out of use until its vendor gate controls are covered", async () => {
    const { assetId, state } = await registerAndSubmit("Vendor fast lane", VENDOR_ONLY);
    expect(state).toBe("fast_lane_approved");
    await expect(gov.actOnAsset(admin, assetId, "activate")).rejects.toThrow(
      "L-01 Vendor contract AI addendum has no evidence or exception; P-01 Vendor risk assessment has no evidence or exception",
    );
    await gov.addEvidence(requester, { assetId, controlId: "L-01", kind: "link", title: "Addendum", url: "https://docs.example.test/l01" });
    await gov.addEvidence(requester, { assetId, controlId: "P-01", kind: "link", title: "VRA", url: "https://docs.example.test/p01" });
    expect((await gov.actOnAsset(admin, assetId, "activate")).state).toBe("active");
  });

  it("validates evidence and keeps its content out of the audit log", async () => {
    const assetId = (await gov.listAssetViews(requester)).find((v) => v.asset.name === "Vendor fast lane")!.asset.id;
    await expect(
      gov.addEvidence(requester, { assetId, controlId: "L-01", kind: "link", title: "x", url: "http://insecure.test" }),
    ).rejects.toThrow(/https/);
    await expect(
      gov.addEvidence(requester, { assetId, controlId: "C-01", kind: "link", title: "x", url: "https://x.test" }),
    ).rejects.toThrow(/not required for this asset/);
    const id = await gov.addEvidence(requester, {
      assetId,
      controlId: "P-02",
      kind: "attestation",
      title: "Residency",
      detail: "Data stays in the US, per Jane Doe at the vendor.",
    });
    const { rows } = await withTenant(db, tenant, (tx) =>
      tx.query<{ payload: Record<string, unknown> }>("SELECT payload FROM audit_events WHERE payload->>'evidenceId' = $1", [id]),
    );
    expect(rows[0]!.payload).toMatchObject({ controlId: "P-02", kind: "attestation" });
    expect(JSON.stringify(rows)).not.toContain("Jane");

    await expect(gov.withdrawEvidence(reviewer, assetId, id)).rejects.toThrow(/not yours/);
    await gov.withdrawEvidence(requester, assetId, id);
  });

  it("covers a gate control with a time-boxed exception that nobody decides for themselves (Jeeves acceptance)", async () => {
    const { assetId, caseId } = await registerAndSubmit("Exception path", HIGH_RISK);
    await expect(
      gov.requestException(requester, { assetId, controlId: "S-02", reason: "later" }),
    ).rejects.toThrow(/not a gate control/);
    const exceptionId = await gov.requestException(approver, {
      assetId,
      controlId: "S-01",
      reason: "The pen test is booked for next month.",
      days: 30,
    });
    await expect(
      gov.requestException(requester, { assetId, controlId: "S-01", reason: "again" }),
    ).rejects.toThrow(/already has a live exception/);
    await expect(gov.actOnException(approver, exceptionId, "approve")).rejects.toThrow(/case you submitted/);
    await expect(gov.actOnException(reviewer, exceptionId, "approve")).rejects.toThrow(/case.decide/);
    expect(await gov.actOnException(secondApprover, exceptionId, "approve")).toBe("approved");

    const security = await reviewOf(reviewer, assetId, "security");
    expect(security.uncoveredGates).toEqual([]);
    await gov.reviewDomain(reviewer, caseId, "security", "sign", { expectedRevision: security.revision });

    clock += 31 * DAY;
    const later = await gov.getAsset(approver, assetId);
    expect(later.assurance.controls.find((c) => c.id === "S-01")).toMatchObject({
      covered: false,
      exception: { state: "expired", actions: [] },
    });
    await expect(gov.actOnException(admin, exceptionId, "revoke", "no longer needed")).rejects.toThrow(/already expired/);
    const renewed = await gov.requestException(requester, { assetId, controlId: "S-01", reason: "Pen test slipped." });
    expect((await gov.getAsset(approver, assetId)).assurance.controls.find((c) => c.id === "S-01")?.exception).toMatchObject({
      id: renewed,
      state: "requested",
    });
    const history = (await gov.assetHistory(approver, assetId)).map((e) => e.action);
    expect(history).toContain("exception.expire");
  });

  it("lets an admin revoke an approved exception with a reason", async () => {
    const { assetId } = await registerAndSubmit("Revocation", HIGH_RISK);
    const id = await gov.requestException(requester, { assetId, controlId: "D-01", reason: "Lineage doc in progress." });
    await gov.actOnException(approver, id, "approve");
    await expect(gov.actOnException(admin, id, "revoke")).rejects.toThrow(/written reason/);
    expect(await gov.actOnException(admin, id, "revoke", "Lineage doc arrived")).toBe("revoked");
  });
});

describe("isolation", () => {
  it("hides every review, piece of evidence and exception from another tenant", async () => {
    const view = (await gov.listAssetViews(approver)).find((v) => v.asset.name === "Exception path")!;
    const review = view.assurance.reviews[0]!;
    const exception = view.assurance.controls.find((c) => c.exception)!.exception!;
    await expect(
      gov.reviewDomain(outsider, review.caseId, review.domain, "abstain", { expectedRevision: review.revision, note: "x" }),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      gov.addEvidence(outsider, { assetId: view.asset.id, controlId: "S-01", kind: "link", title: "x", url: "https://x.test" }),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(gov.actOnException(outsider, exception.id, "reject", "x")).rejects.toMatchObject({ code: "not_found" });
    expect(await withTenant(db, tenant, verifyAuditChain)).toBeNull();
  });
});
