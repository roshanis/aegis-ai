import { PGlite } from "@electric-sql/pglite";
import { serialized, sha256Hex } from "@aegis/db";
import { migrate } from "@aegis/db/migrate";
import { userId, type HumanPrincipal, type Role, type TenantId } from "@aegis/domain";
import { healthcareAiPack } from "@aegis/frameworks";
import { beforeAll, describe, expect, it } from "vitest";
import { createGovernance, type Governance } from "./governance";
import { provisionTenant } from "./provision";
import { ALL_DOMAINS, readyForDecision } from "./test-support";

/** PHI, vendor-hosted, a person checks every output: high risk under the "phi" rule. */
const HIGH_RISK = { phi: true, memberFacing: false, careCoverageInfluence: false, humanInLoop: true, vendorHosted: true, individualImpact: false };
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
}

async function provisionTeam(tenantUuid: string, slug: string): Promise<Team> {
  const { tenantId: tenant, adminId } = await provisionTenant(db, {
    tenant: { id: tenantUuid, slug, name: slug, deploymentMode: "dedicated", region: "eu" },
    admin: { email: `admin@${slug}.test`, displayName: "Ada Admin" },
    packs: [healthcareAiPack],
  });
  const person = (id: string, displayName: string, roles: Role[], reviewDomains: string[] = []): HumanPrincipal => ({
    kind: "human",
    tenantId: tenant,
    userId: userId(id),
    displayName,
    roles,
    reviewDomains,
  });
  const admin = person(adminId, "Ada Admin", ["admin"]);
  const add = async (name: string, roles: Role[], domains: string[] = []) =>
    person(
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
    reviewer: await add("Rowan Reviewer", ["reviewer"], ALL_DOMAINS),
    auditor: await add("Aubrey Auditor", ["auditor"]),
  };
}

let a: Team;
let b: Team;
/** Decided in this order: summarizer (conditional), notes (fast lane). */
let summarizer: { assetId: string; caseId: string };
let notes: { assetId: string; caseId: string };
let quinns: { assetId: string; caseId: string };

async function submit(team: Team, owner: HumanPrincipal, name: string, answers: Record<string, boolean>) {
  const asset = await gov.registerAsset(owner, { kind: "ai_system", name });
  const opened = await gov.openCase(owner, { assetId: asset.id });
  await gov.submitCase(owner, opened.id, answers);
  return { assetId: asset.id, caseId: opened.id };
}

beforeAll(async () => {
  db = new PGlite();
  await migrate(db);
  gov = createGovernance(serialized(db), { now: () => new Date((clock += 60_000)) });
  a = await provisionTeam("00000000-0000-4000-8000-00000000000a", "payer-a");
  b = await provisionTeam("00000000-0000-4000-8000-00000000000b", "payer-b");

  summarizer = await submit(a, a.requester, "Prior-auth 100% summarizer", HIGH_RISK);
  await readyForDecision(gov, a.requester, a.reviewer, summarizer.assetId);
  await gov.actOnCase(a.approver, summarizer.caseId, "conditionally_approve", "Approved for nurse-reviewed summaries.", {
    conditions: [{ text: "Keep PHI inside our cloud tenant", due: "before_use" }],
  });
  notes = await submit(a, a.requester, "Meeting-notes summarizer", LOW_RISK);
  quinns = await submit(a, a.otherRequester, "Quinn's claims copilot", HIGH_RISK);
  await submit(b, b.requester, "Payer B summarizer", HIGH_RISK);
}, 60_000);

describe("case numbers", () => {
  it("count up within each tenant, from one", async () => {
    const numbers = await Promise.all(
      [summarizer, notes, quinns].map(async (c) => (await gov.getAsset(a.auditor, c.assetId)).cases[0]!.number),
    );
    expect(numbers).toEqual([1, 2, 3]);
    const [onlyB] = await gov.listAssetViews(b.auditor);
    expect(onlyB!.cases[0]!.number).toBe(1);
  });
});

describe("tenant", () => {
  it("says where it runs", async () => {
    expect(await gov.tenant(a.auditor)).toMatchObject({ name: "payer-a", deploymentMode: "dedicated", region: "eu" });
  });
});

describe("audit log", () => {
  it("shows people who read every case the whole log, with hashes, and verifies the chain", async () => {
    const { events, chain } = await gov.auditLog(a.auditor);
    expect(chain).toMatchObject({ intact: true, brokenAt: null });
    expect(chain.events).toBeGreaterThan(20);
    expect(events).toHaveLength(chain.events);
    expect(events[0]!.hash).toBe(chain.latest);
    expect(events.every((e) => /^[0-9a-f]{64}$/.test(e.hash))).toBe(true);
    expect(events.map((e) => e.id)).toEqual([...events.map((e) => e.id)].sort((x, y) => y - x));
    expect(events.some((e) => e.action === "user.add")).toBe(true);
    const decision = events.find((e) => e.decision && e.actor.kind === "human")!;
    expect(decision).toMatchObject({ assetName: "Prior-auth 100% summarizer", caseNumber: 1, actor: { name: "Avery Approver" } });
  });

  it("shows a requester only events on what they own", async () => {
    const { events } = await gov.auditLog(a.otherRequester);
    expect(events.length).toBeGreaterThan(0);
    expect(new Set(events.map((e) => e.assetId))).toEqual(new Set([quinns.assetId]));
  });

  it("filters by actor kind and pages back", async () => {
    const system = await gov.auditLog(a.auditor, { actorKind: "system" });
    expect(system.events.length).toBeGreaterThan(0);
    expect(system.events.every((e) => e.actor.kind === "system")).toBe(true);
    const page = await gov.auditLog(a.auditor, { limit: 3 });
    const next = await gov.auditLog(a.auditor, { limit: 3, beforeId: page.events.at(-1)!.id });
    expect(next.events[0]!.id).toBeLessThan(page.events.at(-1)!.id);
  });

  it("never shows another tenant's events", async () => {
    const { events } = await gov.auditLog(b.auditor);
    expect(events.some((e) => e.assetName?.startsWith("Payer B"))).toBe(true);
    expect(events.some((e) => e.assetId === summarizer.assetId)).toBe(false);
  });
});

describe("search", () => {
  it("finds cases by number or by name, newest first", async () => {
    expect((await gov.findCases(a.auditor, "CASE-0002")).map((m) => m.assetName)).toEqual(["Meeting-notes summarizer"]);
    expect((await gov.findCases(a.auditor, "2")).map((m) => m.label)).toEqual(["CASE-0002"]);
    expect((await gov.findCases(a.auditor, "summarizer")).map((m) => m.label)).toEqual(["CASE-0002", "CASE-0001"]);
    expect(await gov.findCases(a.auditor, "   ")).toEqual([]);
  });

  it("treats wildcards as text, and hides what the viewer cannot see", async () => {
    expect((await gov.findCases(a.auditor, "100%")).map((m) => m.label)).toEqual(["CASE-0001"]);
    expect(await gov.findCases(a.auditor, "%")).toHaveLength(1);
    expect(await gov.findCases(a.auditor, "_")).toEqual([]);
    expect(await gov.findCases(a.otherRequester, "summarizer")).toEqual([]);
    expect((await gov.findCases(a.otherRequester, "copilot")).map((m) => m.label)).toEqual(["CASE-0003"]);
    expect(await gov.findCases(b.auditor, "CASE-0003")).toEqual([]);
  });
});

describe("case records", () => {
  it("tell who decided, why, under which rule, and who signed", async () => {
    const record = await gov.caseRecord(a.auditor, summarizer.caseId);
    expect(record).toMatchObject({
      label: "CASE-0001",
      ownerName: "Riley Requester",
      tierRule: { id: "phi", because: "uses protected health information" },
      fastLane: null,
      decision: { after: "conditionally_approved", actor: { name: "Avery Approver" }, reason: "Approved for nurse-reviewed summaries." },
      conditions: [{ text: "Keep PHI inside our cloud tenant", due: "before_use", state: "open" }],
    });
    expect(record.pack.version).toBe("1.3.0");
    expect(record.events[0]!.action).toBe("case.open");
    expect(record.events.every((e) => e.caseId === summarizer.caseId)).toBe(true);
    expect(record.signoffs.length).toBe(7);
    for (const s of record.signoffs) {
      expect(s).toMatchObject({ status: "signed", reviewer: { name: "Rowan Reviewer" } });
      expect(record.events.find((e) => e.hash === s.hash)).toMatchObject({ action: "review.sign", payload: { domain: s.domain } });
    }
  });

  it("name the fast-lane policy and who is accountable", async () => {
    const record = await gov.caseRecord(a.auditor, notes.caseId);
    expect(record).toMatchObject({
      tierRule: { id: null, because: null },
      fastLane: { policyId: "healthcare-ai/fast-lane/v1", accountableApprover: "VP, AI Governance" },
      decision: { after: "fast_lane_approved", actor: { kind: "system" } },
      signoffs: [],
    });
  });

  it("are hidden from people who cannot see the case", async () => {
    await expect(gov.caseRecord(a.otherRequester, summarizer.caseId)).rejects.toMatchObject({ code: "not_found" });
    await expect(gov.caseRecord(b.auditor, summarizer.caseId)).rejects.toMatchObject({ code: "not_found" });
    await expect(gov.caseRecord(a.auditor, "not-a-uuid")).rejects.toMatchObject({ code: "not_found" });
  });

  it("list the latest decisions first", async () => {
    expect((await gov.recentDecisions(a.auditor)).map((r) => r.label)).toEqual(["CASE-0002", "CASE-0001"]);
    expect(await gov.recentDecisions(a.otherRequester)).toEqual([]);
    expect((await gov.recentDecisions(a.auditor, 1)).map((r) => r.label)).toEqual(["CASE-0002"]);
  });
});

describe("policy packs", () => {
  it("lists the versions the tenant holds", async () => {
    const packs = await gov.policyPacks(a.requester);
    expect(packs.map((p) => [p.packId, p.version, p.enabled])).toEqual([["healthcare-ai", "1.3.0", true]]);
    expect(packs[0]!.pack.kind === "initiative" && packs[0]!.pack.sentence?.phrases.phi).toEqual({ yes: "reads", no: "never touches" });
  });
});

describe("evidence packs", () => {
  it("are for auditors only", async () => {
    await expect(gov.exportEvidencePack(a.approver, summarizer.caseId)).rejects.toMatchObject({ code: "forbidden" });
    await expect(gov.exportEvidencePack(b.auditor, summarizer.caseId)).rejects.toMatchObject({ code: "not_found" });
  });

  it("carry the decision, sign-offs, evidence and every event, and the export itself is audited", async () => {
    const { filename, body } = await gov.exportEvidencePack(a.auditor, summarizer.caseId);
    expect(filename).toBe("CASE-0001-evidence-pack.json");
    const pack = JSON.parse(body);
    expect(pack).toMatchObject({
      format: "aegis.evidence-pack/1",
      case: { label: "CASE-0001", policy: "healthcare-ai@1.3.0", tier: "high", tierRule: { id: "phi" } },
      asset: { name: "Prior-auth 100% summarizer", owner: "Riley Requester" },
      decision: { state: "conditionally_approved", by: { name: "Avery Approver" }, reason: "Approved for nurse-reviewed summaries." },
      chain: { intact: true },
    });
    expect(pack.signoffs).toHaveLength(7);
    expect(pack.controlsAsOfExport.filter((c: { enforcement: string }) => c.enforcement === "gate").every((c: { covered: boolean }) => c.covered)).toBe(true);
    expect(pack.events.length).toBeGreaterThan(10);

    const { events, chain } = await gov.auditLog(a.auditor, { limit: 1 });
    expect(events[0]).toMatchObject({
      action: "audit.export",
      caseId: summarizer.caseId,
      actor: { name: "Aubrey Auditor" },
      payload: { contentSha256: sha256Hex(body) },
    });
    expect(chain.intact).toBe(true);
  });
});
