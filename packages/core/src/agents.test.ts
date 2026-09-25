import { randomBytes } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { modelProviderFor, type ModelConnection } from "@aegis/agents";
import { serialized, verifyAuditChain, withTenant } from "@aegis/db";
import { migrate } from "@aegis/db/migrate";
import { draftMemo, userId, type HumanPrincipal, type Role, type TenantId } from "@aegis/domain";
import { healthcareAiPack } from "@aegis/frameworks";
import { Usage, type Model, type ModelProvider } from "@openai/agents-core";
import { beforeAll, describe, expect, it } from "vitest";
import { createGovernance, type Governance } from "./governance";
import { inlineJobs, type InlineJobs } from "./jobs";
import { provisionTenant } from "./provision";
import { keyring, openSecret, sealSecret } from "./secrets";
import { ALL_DOMAINS } from "./test-support";

/** High risk: PHI, vendor-hosted, a person checks every output. Seven review domains. */
const HIGH_RISK = { phi: true, memberFacing: false, careCoverageInfluence: false, humanInLoop: true, vendorHosted: true, individualImpact: false };
const DESCRIPTION =
  "Reads prior authorization requests and the attached clinical notes, then drafts a summary for the nurse reviewer. A nurse reads every summary before deciding the request. Runs on Azure OpenAI.";

let db: PGlite;
let gov: Governance;
let jobs: InlineJobs;
const jobErrors: unknown[] = [];
let clock = Date.UTC(2026, 8, 25, 12);
const ring = keyring(randomBytes(32));

/** How the "model" behaves in each test. Defaults to the scripted model. */
let behaviour: (c: ModelConnection) => ModelProvider | Promise<ModelProvider> = () =>
  modelProviderFor({ provider: "scripted", model: "scripted" });

let tenant: TenantId;
let otherTenant: TenantId;
let admin: HumanPrincipal;
let requester: HumanPrincipal;
let secondRequester: HumanPrincipal;
let reviewer: HumanPrincipal;
let approver: HumanPrincipal;
let otherAdmin: HumanPrincipal;

const person = (t: TenantId, id: string, name: string, roles: Role[], domains: string[] = []): HumanPrincipal => ({
  kind: "human",
  tenantId: t,
  userId: userId(id),
  displayName: name,
  roles,
  reviewDomains: domains,
});

function provider(getResponse: Model["getResponse"]): ModelProvider {
  const model: Model = {
    getResponse,
    async *getStreamedResponse() {
      throw new Error("no streaming");
    },
  };
  return { getModel: () => model };
}
const answer = (output: unknown) =>
  provider(async () => ({
    usage: new Usage({ requests: 1, inputTokens: 5, outputTokens: 5, totalTokens: 10 }),
    output: [{ type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: JSON.stringify(output) }] }],
  }));
const scripted = () => modelProviderFor({ provider: "scripted", model: "scripted" });

async function registerAndSubmit(name: string, answers: Record<string, boolean>, owner = requester, suggestionRunId?: string) {
  const asset = await gov.registerAsset(owner, { kind: "ai_system", name });
  const draft = await gov.openCase(owner, { assetId: asset.id });
  const { case: submitted } = await gov.submitCase(owner, draft.id, answers, suggestionRunId ? { suggestionRunId } : {});
  return { assetId: asset.id, caseId: submitted.id };
}

const reviews = async (viewer: HumanPrincipal, assetId: string) => (await gov.getAsset(viewer, assetId)).assurance.reviews;
const agentStatus = async (actor = admin) =>
  Object.fromEntries((await gov.agentsOverview(actor)).agents.map((a) => [a.id, a.status]));

/** Wait for a condition that background jobs will make true. */
async function until(check: () => Promise<boolean>, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function evaluateAndEnable(agents: readonly ("intake" | "review-drafter")[] = ["intake", "review-drafter"]) {
  for (const agent of agents) await gov.startEval(admin, agent);
  await jobs.idle();
  for (const agent of agents) await gov.setAgentEnabled(admin, agent, true);
}

beforeAll(async () => {
  db = new PGlite();
  await migrate(db);
  gov = createGovernance(serialized(db), {
    now: () => new Date((clock += 60_000)),
    secrets: ring,
    models: (c) => behaviour(c),
    jobs: { enqueue: (job) => jobs.enqueue(job) },
    timeoutMs: 5_000,
  });
  jobs = inlineJobs(() => gov.agentRuntime, {
    retry: { attempts: 3, delayMs: 1, backoff: 1 },
    onError: (error) => jobErrors.push(error),
  });
  const a = await provisionTenant(db, {
    tenant: { id: "00000000-0000-4000-8000-0000000000d0", slug: "payer-d", name: "Payer D" },
    admin: { email: "admin@payer-d.test", displayName: "Ada Admin" },
    packs: [healthcareAiPack],
  });
  tenant = a.tenantId;
  admin = person(tenant, a.adminId, "Ada Admin", ["admin"]);
  const add = async (name: string, roles: Role[], domains: string[] = []) =>
    person(
      tenant,
      await gov.addUser(admin, { email: `${name.split(" ")[0]!.toLowerCase()}@payer-d.test`, displayName: name, roles, reviewDomains: domains }),
      name,
      roles,
      domains,
    );
  requester = await add("Riley Requester", ["requester"]);
  secondRequester = await add("Quinn Requester", ["requester"]);
  reviewer = await add("Rowan Reviewer", ["reviewer"], ALL_DOMAINS);
  approver = await add("Avery Approver", ["approver"]);

  const b = await provisionTenant(db, {
    tenant: { id: "00000000-0000-4000-8000-0000000000e0", slug: "payer-e", name: "Payer E" },
    admin: { email: "admin@payer-e.test", displayName: "Eve Admin" },
    packs: [healthcareAiPack],
  });
  otherTenant = b.tenantId;
  otherAdmin = person(otherTenant, b.adminId, "Eve Admin", ["admin"]);
}, 60_000);

describe("the golden-set gate", () => {
  it("keeps agents off until an admin connects a model, it passes its golden set, and the admin turns it on", async () => {
    let overview = await gov.agentsOverview(admin);
    expect(overview.connection).toBeNull();
    expect(overview.agents.map((a) => [a.id, a.status, a.statusReason])).toEqual([
      ["intake", "blocked", "No model is connected."],
      ["review-drafter", "blocked", "No model is connected."],
    ]);
    await expect(gov.connectModel(requester, { provider: "scripted", model: "scripted" })).rejects.toThrow(/only an admin/);

    await gov.connectModel(admin, { provider: "scripted", model: "scripted" });
    expect(await agentStatus()).toEqual({ intake: "blocked", "review-drafter": "blocked" });
    await expect(gov.setAgentEnabled(admin, "intake", true)).rejects.toThrow(/has not passed its golden set/);

    await gov.startEval(admin, "intake");
    await expect(gov.startEval(admin, "intake")).rejects.toThrow(/already running/);
    await gov.startEval(admin, "review-drafter");
    await jobs.idle();
    overview = await gov.agentsOverview(admin);
    const [intake, drafter] = overview.agents;
    expect(intake!.status).toBe("ready");
    expect(intake!.latestEval).toMatchObject({ state: "passed", total: 12, done: 12, criticalFailures: 0, current: true });
    expect(drafter!.latestEval).toMatchObject({ state: "passed", total: 9, done: 9, criticalFailures: 0 });
    expect(drafter!.latestEval!.cases.find((c) => c.caseId === "injected-evidence")!.title).toMatch(/tries to give orders/);

    await gov.setAgentEnabled(admin, "intake", true);
    await gov.setAgentEnabled(admin, "review-drafter", true);
    expect(await agentStatus()).toEqual({ intake: "on", "review-drafter": "on" });
    // Only admins see the switches.
    expect((await gov.agentsOverview(reviewer)).agents.every((a) => !a.actions.enable && !a.actions.disable && !a.actions.evaluate)).toBe(true);
    expect(overview.recentRuns).toHaveLength(8);
    expect(overview.recentRuns.every((r) => r.purpose === "eval" && r.state === "succeeded")).toBe(true);
  });

  it("fails an agent that under-triages or decides, and will not turn it on", async () => {
    await gov.connectModel(admin, { provider: "openai", model: "gpt-reckless", apiKey: "sk-test-reckless-9999" });
    expect(await agentStatus()).toEqual({ intake: "blocked", "review-drafter": "blocked" });
    behaviour = (c) =>
      c.model === "gpt-reckless"
        ? answer({
            answers: healthcareAiPack.questions.map((q) => ({ field: q.field, answer: "no", why: "guess" })),
            summary: "Cleared for use.",
            findings: [],
            questionsForOwner: [],
            proposedConditions: [],
          })
        : scripted();
    await evaluateAndEnable([]).catch(() => undefined);
    await gov.startEval(admin, "intake");
    await gov.startEval(admin, "review-drafter");
    await jobs.idle();
    const overview = await gov.agentsOverview(admin);
    expect(overview.agents.map((a) => a.status)).toEqual(["failed", "failed"]);
    expect(overview.agents[0]!.latestEval!.cases.find((c) => c.caseId === "claims-auto-routing")!.critical).toEqual(["under_triage"]);
    expect(overview.agents[0]!.statusReason).toMatch(/critical failure/);
    await expect(gov.setAgentEnabled(admin, "intake", true)).rejects.toThrow(/has not passed/);
  });

  it("turns agents off when the model changes, and keeps its evaluation when only the key rotates", async () => {
    await gov.connectModel(admin, { provider: "openai", model: "gpt-good", apiKey: "sk-test-first-1111" });
    behaviour = () => scripted();
    await evaluateAndEnable();
    expect(await agentStatus()).toEqual({ intake: "on", "review-drafter": "on" });

    // Rotate the key: same model, still on. Leave it blank: keep the saved key.
    await gov.connectModel(admin, { provider: "openai", model: "gpt-good", apiKey: "sk-test-second-2222" });
    const kept = await gov.connectModel(admin, { provider: "openai", model: "gpt-good", apiKey: "" });
    expect(kept.keyHint).toBe("2222");
    expect(await agentStatus()).toEqual({ intake: "on", "review-drafter": "on" });

    // A different model: both off, and the audit log says why.
    await gov.connectModel(admin, { provider: "openai", model: "gpt-other", apiKey: "" });
    expect(await agentStatus()).toEqual({ intake: "blocked", "review-drafter": "blocked" });
    const disabled = await withTenant(db, tenant, (tx) =>
      tx.query<{ payload: { agentId: string; because: string } }>("SELECT payload FROM audit_events WHERE action = 'agent.disable'"),
    );
    expect(disabled.rows.map((r) => r.payload).slice(-2)).toEqual([
      { agentId: "intake", because: "model_changed" },
      { agentId: "review-drafter", because: "model_changed" },
    ]);

    // Back to the model that passed: its evaluation counts again, but only an admin turns it back on.
    await gov.connectModel(admin, { provider: "openai", model: "gpt-good", apiKey: "" });
    expect(await agentStatus()).toEqual({ intake: "ready", "review-drafter": "ready" });
    await gov.setAgentEnabled(admin, "intake", true);
    await gov.setAgentEnabled(admin, "review-drafter", true);
  });

  it("stores the key sealed to this tenant, never in the clear", async () => {
    const { rows } = await db.query<{ key_ciphertext: string; key_hint: string }>(
      "SELECT key_ciphertext, key_hint FROM model_connections WHERE tenant_id = $1",
      [tenant],
    );
    expect(rows[0]!.key_ciphertext).not.toContain("sk-test");
    expect(rows[0]!.key_hint).toBe("2222");
    const sealed = rows[0]!.key_ciphertext;
    expect(await withTenant(db, tenant, (tx) => openSecret(tx, ring, tenant, "model-key", sealed))).toBe("sk-test-second-2222");
    // The same ciphertext is useless in another tenant, for another purpose, or under another master key.
    await withTenant(db, otherTenant, (tx) => sealSecret(tx, ring, otherTenant, "model-key", "sk-b", new Date()));
    expect(await withTenant(db, otherTenant, (tx) => openSecret(tx, ring, otherTenant, "model-key", sealed))).toBeNull();
    expect(await withTenant(db, tenant, (tx) => openSecret(tx, ring, tenant, "other-purpose", sealed))).toBeNull();
    await expect(withTenant(db, tenant, (tx) => openSecret(tx, keyring(randomBytes(32)), tenant, "model-key", sealed))).rejects.toThrow(
      /master key this server does not have/,
    );
  });

  it("shows another tenant none of it", async () => {
    const overview = await gov.agentsOverview(otherAdmin);
    expect(overview.connection).toBeNull();
    expect(overview.recentRuns).toEqual([]);
    expect(overview.agents.every((a) => a.latestEval === null && a.status === "blocked")).toBe(true);
  });
});

describe("review drafts", () => {
  it("drafts every review when a case enters review, and records how the reviewer used the draft", async () => {
    behaviour = () => scripted();
    const { assetId, caseId } = await registerAndSubmit("Prior-auth summarizer", HIGH_RISK);
    await jobs.idle();
    const drafted = await reviews(reviewer, assetId);
    expect(drafted).toHaveLength(7);
    expect(drafted.every((r) => r.status === "drafted" && r.draft.status === "ready")).toBe(true);
    const security = drafted.find((r) => r.domain === "security")!;
    expect(security.draft.content!.findings.map((f) => f.controlId)).toContain("S-01");
    expect(security.actions).toContain("sign");

    // Signing still needs gate controls covered; the draft does not change that.
    for (const control of (await gov.getAsset(requester, assetId)).assurance.controls.filter((c) => c.enforcement === "gate")) {
      await gov.addEvidence(requester, { assetId, controlId: control.id, kind: "link", title: control.requiredEvidence, url: `https://docs.example.test/${control.id}` });
    }
    const [asDrafted, edited, none] = (await reviews(reviewer, assetId)).filter((r) => ["security", "legal", "procurement"].includes(r.domain));
    await gov.reviewDomain(reviewer, caseId, asDrafted!.domain, "sign", { expectedRevision: asDrafted!.revision, note: draftMemo(asDrafted!.draft.content!) });
    await gov.reviewDomain(reviewer, caseId, edited!.domain, "sign", { expectedRevision: edited!.revision, note: `${draftMemo(edited!.draft.content!)} Checked the DPA too.` });
    await gov.reviewDomain(reviewer, caseId, none!.domain, "sign", { expectedRevision: none!.revision });

    const history = await gov.assetHistory(approver, assetId);
    const draftEvents = history.filter((h) => h.action === "review.draft");
    expect(draftEvents).toHaveLength(7);
    expect(draftEvents[0]!.actor).toEqual({ kind: "agent", id: "agent:review-drafter", name: null });
    expect(draftEvents[0]!.reasonStatus).toBe("intact");
    const signed = Object.fromEntries(history.filter((h) => h.action === "review.sign").map((h) => [h.payload.domain, h.payload.fromDraft]));
    expect(signed).toEqual({ [asDrafted!.domain]: "as_drafted", [edited!.domain]: "edited", [none!.domain]: "not_used" });
    expect(await withTenant(db, tenant, (tx) => verifyAuditChain(tx))).toBeNull();

    // Jeeves' rule lets a conditional approval rest on unsigned drafts; the decision records which.
    await gov.actOnCase(approver, caseId, "conditionally_approve", "Pilot only.", {
      conditions: [{ text: "Sign the remaining reviews before general availability", due: "ongoing" }],
    });
    const decision = (await gov.assetHistory(approver, assetId)).find((h) => h.action === "case.conditionally_approve")!;
    expect(decision.payload.unsignedDrafts).toEqual(["clinical-safety", "data-governance", "privacy-hipaa", "responsible-ai", "tech-architecture"].filter((d) => drafted.some((r) => r.domain === d)));
  });

  it("lets a person who acts first win over a draft still in flight", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    behaviour = async () => {
      const inner = await scripted();
      return provider(async (request) => {
        await gate;
        return (await inner.getModel()).getResponse(request);
      });
    };
    const { assetId, caseId } = await registerAndSubmit("Slow drafts", { ...HIGH_RISK, phi: false, vendorHosted: false, memberFacing: true });
    const pending = await reviews(reviewer, assetId);
    expect(pending.every((r) => r.status === "pending" && r.draft.status === "queued")).toBe(true);
    // Every draft is now with the model.
    await until(async () => {
      const { rows } = await withTenant(db, tenant, (tx) =>
        tx.query("SELECT 1 FROM agent_runs WHERE case_id = $1 AND state = 'running'", [caseId]),
      );
      return rows.length === pending.length;
    });
    const first = pending[0]!;
    await gov.reviewDomain(reviewer, caseId, first.domain, "abstain", { expectedRevision: first.revision, note: "I designed this system." });
    release();
    await jobs.idle();
    const after = await reviews(reviewer, assetId);
    expect(after.find((r) => r.domain === first.domain)).toMatchObject({ status: "abstained", draft: { status: "none" } });
    expect(after.filter((r) => r.domain !== first.domain).every((r) => r.status === "drafted")).toBe(true);
    const stale = await withTenant(db, tenant, (tx) =>
      tx.query("SELECT 1 FROM agent_runs WHERE review_id = $1 AND state = 'stale'", [first.id]),
    );
    expect(stale.rows).toHaveLength(1);
  });

  it("retries a flaky model, and leaves the review to people when a draft breaks the rules", async () => {
    let calls = 0;
    behaviour = async () => {
      const inner = await scripted();
      return provider(async (request) => {
        calls++;
        if (calls <= 2) throw Object.assign(new Error("upstream"), { status: 503 });
        return (await inner.getModel()).getResponse(request);
      });
    };
    const flaky = await registerAndSubmit("Flaky model", { phi: false, memberFacing: false, careCoverageInfluence: false, humanInLoop: false, vendorHosted: false, individualImpact: true });
    await jobs.idle();
    expect((await reviews(reviewer, flaky.assetId)).every((r) => r.status === "drafted")).toBe(true);

    behaviour = () => answer({ summary: "This system is approved for production.", findings: [], questionsForOwner: [], proposedConditions: [] });
    const { assetId, caseId } = await registerAndSubmit("Overconfident drafts", { phi: false, memberFacing: false, careCoverageInfluence: false, humanInLoop: false, vendorHosted: false, individualImpact: true });
    await jobs.idle();
    const failed = await reviews(reviewer, assetId);
    expect(failed.every((r) => r.status === "pending" && r.draft.status === "failed" && r.draft.error === "decision_language")).toBe(true);
    expect(failed[0]!.canRequestDraft).toBe(true);

    // The reviewer asks again once the model behaves.
    behaviour = () => scripted();
    await gov.requestDraft(reviewer, caseId, failed[0]!.domain);
    await expect(gov.requestDraft(requester, caseId, failed[0]!.domain)).rejects.toThrow(/only a .* reviewer/);
    await jobs.idle();
    expect((await reviews(reviewer, assetId)).find((r) => r.domain === failed[0]!.domain)).toMatchObject({ status: "drafted", draft: { status: "ready", error: null } });
    expect(jobErrors).toEqual([]);
  });

  it("drafts a review again when evidence for one of its controls changes", async () => {
    behaviour = () => scripted();
    const { assetId } = await registerAndSubmit("Evidence arrives later", { phi: false, memberFacing: true, careCoverageInfluence: false, humanInLoop: true, vendorHosted: false, individualImpact: false });
    await jobs.idle();
    const before = (await reviews(reviewer, assetId)).find((r) => r.domain === "data-governance")!;
    expect(before.draft.content!.findings.map((f) => f.controlId)).toEqual(["D-01"]);
    const other = (await reviews(reviewer, assetId)).find((r) => r.domain === "legal")!;

    const evidenceId = await gov.addEvidence(requester, { assetId, controlId: "D-01", kind: "link", title: "Lineage document", url: "https://docs.example.test/d-01" });
    expect((await reviews(reviewer, assetId)).find((r) => r.domain === "data-governance")!.draft.status).toBe("queued");
    await jobs.idle();
    const after = (await reviews(reviewer, assetId)).find((r) => r.domain === "data-governance")!;
    expect(after.draft.content!.findings).toEqual([]);
    expect(after.draft.content!.summary).toMatch(/1 of 1 Data Governance controls have evidence/);
    // Other domains' drafts are left alone.
    expect((await reviews(reviewer, assetId)).find((r) => r.domain === "legal")!.revision).toBe(other.revision);

    await gov.withdrawEvidence(requester, assetId, evidenceId);
    await jobs.idle();
    expect((await reviews(reviewer, assetId)).find((r) => r.domain === "data-governance")!.draft.content!.findings.map((f) => f.controlId)).toEqual(["D-01"]);
  });

  it("drafts again once the owner answers a returned review", async () => {
    behaviour = () => scripted();
    const { assetId, caseId } = await registerAndSubmit("Returned and answered", { phi: false, memberFacing: true, careCoverageInfluence: false, humanInLoop: true, vendorHosted: false, individualImpact: false });
    await jobs.idle();
    const legal = (await reviews(reviewer, assetId)).find((r) => r.domain === "legal")!;
    await gov.reviewDomain(reviewer, caseId, "legal", "return", { expectedRevision: legal.revision, note: "Who approves the marketing claims?" });
    const returned = (await reviews(requester, assetId)).find((r) => r.domain === "legal")!;
    await gov.reviewDomain(requester, caseId, "legal", "respond", { expectedRevision: returned.revision, note: "Compliance signs off every claim." });
    await jobs.idle();
    const redrafted = (await reviews(reviewer, assetId)).find((r) => r.domain === "legal")!;
    expect(redrafted.status).toBe("drafted");
    expect(redrafted.draft.content!.summary).toMatch(/owner has answered/);
  });

  it("never lets the drafter's principal act as a person", async () => {
    const { assetId, caseId } = await registerAndSubmit("Agent tries its luck", { ...HIGH_RISK, phi: false, memberFacing: true });
    await jobs.idle();
    const agent = { kind: "agent" as const, tenantId: tenant, agent: "review-drafter" };
    const review = (await reviews(reviewer, assetId))[0]!;
    await expect(gov.reviewDomain(agent, caseId, review.domain, "sign", { expectedRevision: review.revision })).rejects.toThrow(/not found/);
    await expect(gov.actOnCase(agent, caseId, "approve")).rejects.toThrow(/not found/);
  });
});

describe("intake suggestions", () => {
  it("suggests answers, and the submission records which ones the requester kept", async () => {
    behaviour = () => scripted();
    await expect(gov.suggestIntake(requester, "too short")).rejects.toThrow(/sentence or two/);
    await expect(gov.suggestIntake(reviewer, DESCRIPTION)).rejects.toThrow(/only someone who registers/);
    const { runId, suggestions } = await gov.suggestIntake(requester, DESCRIPTION);
    expect(Object.fromEntries(suggestions.map((s) => [s.field, s.answer]))).toEqual({
      phi: "yes",
      memberFacing: "no",
      careCoverageInfluence: "yes",
      humanInLoop: "yes",
      vendorHosted: "yes",
      individualImpact: "yes",
    });
    // The requester disagrees about individual impact, and submits.
    const answers = { phi: true, memberFacing: false, careCoverageInfluence: true, humanInLoop: true, vendorHosted: true, individualImpact: false };
    await expect(registerAndSubmit("Someone else's run", answers, secondRequester, runId)).rejects.toThrow(/unknown suggestion run/);
    const { assetId } = await registerAndSubmit("Suggested intake", answers, requester, runId);
    const submitted = (await gov.assetHistory(requester, assetId)).find((h) => h.action === "case.submit")!;
    expect(submitted.payload).toEqual({ suggestionRunId: runId, suggested: 6, keptAsSuggested: 5, changed: ["individualImpact"] });
    await expect(registerAndSubmit("Reused run", answers, requester, runId)).rejects.toThrow(/unknown suggestion run/);
  });

  it("says plainly when the assistant is off or its model fails", async () => {
    behaviour = () => provider(async () => { throw Object.assign(new Error("slow"), { name: "TimeoutError" }); });
    await expect(gov.suggestIntake(requester, DESCRIPTION)).rejects.toThrow(/didn't answer in time. Answer the questions yourself/);
    await gov.setAgentEnabled(admin, "intake", false);
    await expect(gov.suggestIntake(requester, DESCRIPTION)).rejects.toThrow(/The intake assistant is off/);
  });
});

describe("recovery", () => {
  it("picks up drafts that were queued when the process stopped", async () => {
    behaviour = () => scripted();
    await jobs.idle();
    // Nothing is left queued once jobs finish, even for cases decided while their drafts were queued.
    expect((await db.query("SELECT 1 FROM domain_reviews WHERE draft_status = 'queued'")).rows).toEqual([]);
    // A service with nowhere to send jobs, as if the process died right after the commit.
    const orphaned = createGovernance(serialized(db), { now: () => new Date((clock += 60_000)), secrets: ring, models: (c) => behaviour(c) });
    const asset = await orphaned.registerAsset(requester, { kind: "ai_system", name: "Queued at shutdown" });
    const draft = await orphaned.openCase(requester, { assetId: asset.id });
    await orphaned.submitCase(requester, draft.id, { ...HIGH_RISK, phi: false, memberFacing: true });
    const queued = await reviews(reviewer, asset.id);
    expect(queued.length).toBeGreaterThanOrEqual(5);
    expect(queued.every((r) => r.draft.status === "queued")).toBe(true);

    const restarted = inlineJobs(() => orphaned.agentRuntime, { retry: { attempts: 1, delayMs: 1, backoff: 1 } });
    expect(await restarted.recover()).toBe(queued.length);
    await restarted.idle();
    expect((await reviews(reviewer, asset.id)).every((r) => r.status === "drafted")).toBe(true);
    expect(await restarted.recover()).toBe(0);
  });
});
