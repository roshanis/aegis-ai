import { PGlite } from "@electric-sql/pglite";
import { serialized, verifyAuditChain, withTenant } from "@aegis/db";
import { migrate } from "@aegis/db/migrate";
import { userId, type HumanPrincipal, type Role } from "@aegis/domain";
import { cmsMemberCommunicationsPack, healthcareAiPack } from "@aegis/frameworks";
import { beforeAll, describe, expect, it } from "vitest";
import { createGovernance, type Governance } from "./governance";
import { provisionTenant } from "./provision";

const FLYER = `Sunrise Health Advantage (HMO)
Your 2027 benefits: $0 premium and $5 primary care copays.
Call 1-800-555-0142 (TTY 711), 8 a.m. to 8 p.m. Free language assistance and interpreter services are available.
Sunrise Health is an HMO plan with a Medicare contract. Enrollment in Sunrise Health depends on contract renewal.
H1234_FLYER27_C`;

let db: PGlite;
let gov: Governance;
let clock = Date.UTC(2026, 10, 12, 9);
let admin: HumanPrincipal;
let writer: HumanPrincipal;
let officer: HumanPrincipal;
let auditor: HumanPrincipal;

beforeAll(async () => {
  db = new PGlite();
  await migrate(db);
  gov = createGovernance(serialized(db), { now: () => new Date((clock += 60_000)) });
  const { tenantId, adminId } = await provisionTenant(db, {
    tenant: { id: "00000000-0000-4000-8000-0000000000d1", slug: "sunrise", name: "Sunrise Health" },
    admin: { email: "admin@sunrise.test", displayName: "Ada Admin" },
    packs: [healthcareAiPack, cmsMemberCommunicationsPack],
  });
  admin = { kind: "human", tenantId, userId: adminId, displayName: "Ada Admin", roles: ["admin"], reviewDomains: [] };
  const add = async (name: string, roles: Role[]): Promise<HumanPrincipal> => ({
    kind: "human",
    tenantId,
    userId: userId(await gov.addUser(admin, { email: `${name.split(" ")[0]!.toLowerCase()}@sunrise.test`, displayName: name, roles })),
    displayName: name,
    roles,
    reviewDomains: [],
  });
  writer = await add("Wren Writer", ["requester"]);
  officer = await add("Olu Officer", ["approver"]);
  auditor = await add("Aubrey Auditor", ["auditor"]);
}, 60_000);

async function draftFlyer(name: string) {
  const asset = await gov.registerAsset(writer, { kind: "content_item", name });
  const opened = await gov.openCase(writer, { assetId: asset.id });
  return { assetId: asset.id, caseId: opened.id };
}

describe("member communications", () => {
  it("checks a submitted flyer in code, then an officer asks for changes, and approves the next version", async () => {
    const { assetId, caseId } = await draftFlyer("2027 benefits flyer");
    const first = await gov.submitCommunication(writer, caseId, {
      body: `${FLYER}\nThe best plan in Ohio. Our plan is endorsed by Medicare.`,
      markets: ["MA"],
    });
    expect(first.case.state).toBe("ai_reviewed");
    expect(first.version).toMatchObject({ version: 1, verdict: "fail", markets: ["MA"] });
    expect(first.version.findings.map((f) => f.criterionId)).toEqual(["M1", "M7"]);

    const view = await gov.communication(officer, caseId);
    expect(view.pack).toMatchObject({ id: "cms-member-communications", version: "1.0.0" });
    expect(view.criteria.find((c) => c.id === "M1")).toMatchObject({ status: "finding", automatic: true, title: "No claim of Medicare endorsement" });
    expect(view.criteria.find((c) => c.id === "M11")).toMatchObject({ status: "uncertain", automatic: false });
    expect(view.criteria.map((c) => c.id)).not.toContain("M14");

    await expect(gov.actOnCase(officer, caseId, "request_changes")).rejects.toThrow(/reason/);
    await gov.actOnCase(officer, caseId, "request_changes", "Drop the endorsement line and the superlative.");
    // The owner resubmits a corrected version; the first stays on file as it was.
    const second = await gov.submitCommunication(writer, caseId, { body: FLYER, markets: ["MA"] });
    expect(second.version).toMatchObject({ version: 2, verdict: "needs_human_review", findings: [] });
    const both = await gov.communication(writer, caseId);
    expect(both.versions.map((v) => [v.version, v.verdict])).toEqual([
      [1, "fail"],
      [2, "needs_human_review"],
    ]);
    expect(both.versions[0]!.body).toContain("endorsed by Medicare");

    await gov.actOnCase(officer, caseId, "approve", "Benefits checked against the 2027 EOC.");
    const asset = await gov.getAsset(writer, assetId);
    expect(asset.cases[0]!.state).toBe("approved");
    expect(asset.clearance.cleared).toBe(true);

    const actions = (await gov.assetHistory(auditor, assetId)).map((e) => `${e.actor.kind}:${e.action}`);
    expect(actions).toEqual([
      "human:asset.register",
      "human:case.open",
      "human:case.submit",
      "system:case.record_ai_review",
      "human:case.request_changes",
      "human:case.resubmit",
      "system:case.record_ai_review",
      "human:case.approve",
    ]);
    const check = (await gov.assetHistory(auditor, assetId)).find((e) => e.action === "case.record_ai_review")!;
    expect(check.payload).toMatchObject({ version: 1, verdict: "fail", findings: ["M1", "M7"], forPerson: ["M11", "M12"] });
    expect(await withTenant(db, admin.tenantId, verifyAuditChain)).toBeNull();
  });

  it("refuses empty text, unknown markets, someone else's case, and a second submission while it is with the officer", async () => {
    const { caseId } = await draftFlyer("Part D postcard");
    await expect(gov.submitCommunication(writer, caseId, { body: "  ", markets: ["PDP"] })).rejects.toThrow(/paste/);
    await expect(gov.submitCommunication(writer, caseId, { body: FLYER, markets: [] })).rejects.toThrow(/who it is for/);
    await expect(gov.submitCommunication(writer, caseId, { body: FLYER, markets: ["UK"] })).rejects.toThrow(/does not cover UK/);
    await expect(gov.submitCommunication(officer, caseId, { body: FLYER, markets: ["PDP"] })).rejects.toThrow(/not_found|only the case owner/);
    await expect(gov.submitCommunication(writer, caseId, { body: "x".repeat(40_001), markets: ["PDP"] })).rejects.toThrow(/under/);

    await gov.submitCommunication(writer, caseId, { body: FLYER, markets: ["PDP"] });
    await expect(gov.submitCommunication(writer, caseId, { body: FLYER, markets: ["PDP"] })).rejects.toThrow(/no 'submit' from 'ai_reviewed'/);
  });

  it("lets nobody but an officer decide, and never the writer", async () => {
    const { caseId } = await draftFlyer("Welcome letter");
    await gov.submitCommunication(writer, caseId, { body: FLYER, markets: ["MA"] });
    await expect(gov.actOnCase(writer, caseId, "approve", "mine")).rejects.toThrow();
    await expect(gov.actOnCase(auditor, caseId, "approve", "looks fine")).rejects.toThrow();
    await gov.actOnCase(officer, caseId, "reject", "Wrong plan year.");
    expect((await gov.communication(auditor, caseId)).versions).toHaveLength(1);
  });

  it("keeps each version as written: the app cannot edit or delete one", async () => {
    await expect(withTenant(db, admin.tenantId, (tx) => tx.exec("UPDATE content_versions SET body = 'x'"))).rejects.toThrow(/permission denied/);
    await expect(withTenant(db, admin.tenantId, (tx) => tx.exec("DELETE FROM content_versions"))).rejects.toThrow(/permission denied/);
  });
});
