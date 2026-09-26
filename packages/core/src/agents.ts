import { randomUUID } from "node:crypto";
import {
  AGENTS,
  AGENT_IDS,
  AgentFailure,
  MODEL_PROVIDERS,
  buildDraftContext,
  classifyFailure,
  connectionProblems,
  describeConnection,
  draftReview,
  evalCase,
  goldenSetFor,
  goldenSetKey,
  isAgentId,
  modelFingerprint,
  modelProviderFor,
  suggestIntake,
  summarize,
  type AgentId,
  type AgentUsage,
  type DraftContext,
  type EndpointPolicy,
  type EvalCaseResult,
  type ModelConnection,
  type ModelProviderId,
} from "@aegis/agents";
import { appendAudit, type Connection, type Database } from "@aegis/db";
import {
  can,
  canSignDomain,
  domainReviewLifecycle,
  exceptionActive,
  requiredControls,
  tenantId,
  type AgentPrincipal,
  type Answers,
  type DomainReviewStatus,
  type IntakeSuggestion,
  type Principal,
  type SystemPrincipal,
  type TenantId,
} from "@aegis/domain";
import type { InitiativePack, PolicyPack } from "@aegis/frameworks";
import type { ModelProvider } from "@openai/agents-core";
import {
  AnswerCache,
  inputHash,
  intakeCallsToday,
  loadBudget,
  monthlyBlock,
  tokenUsage,
  type Budget,
  type TokenUsage,
} from "./budget";
import { GovernanceError } from "./errors";
import type { AgentJob, AgentRuntime, DraftJob, DraftOutcome, EvalJob, JobQueue } from "./jobs";
import { UUID, actorId, toCase, type Case, type CaseRow, type Kernel } from "./model";
import { openSecret, sealSecret, type Keyring } from "./secrets";

/**
 * Agents: the tenant's model connection, the golden-set gate, intake
 * suggestions, and review drafting. Agents hold no permissions. An agent
 * runs only while it is turned on, and it can be turned on only by an admin
 * after it passed its policy pack's golden set on the tenant's current
 * model; changing the model turns it off again.
 */

export interface AgentOptions {
  readonly jobs?: JobQueue;
  /** Seals model keys. Without it, only the scripted model can be connected. */
  readonly secrets?: Keyring;
  /** Build providers differently, for example to put a misbehaving model under test. */
  readonly models?: (connection: ModelConnection) => ModelProvider | Promise<ModelProvider>;
  readonly endpointPolicy?: EndpointPolicy;
  readonly timeoutMs?: number;
}

export interface Person {
  readonly id: string;
  readonly name: string | null;
}

export interface ConnectionView {
  readonly provider: ModelProviderId;
  readonly model: string;
  readonly endpoint: string | null;
  readonly apiVersion: string | null;
  readonly keyHint: string | null;
  readonly label: string;
  readonly fingerprint: string;
  readonly updatedBy: Person;
  readonly updatedAt: Date;
}

export interface EvalCaseView extends EvalCaseResult {
  readonly title: string;
}

export interface EvalView {
  readonly id: string;
  readonly state: "running" | "passed" | "failed" | "error";
  readonly errorCode: string | null;
  readonly goldenSet: string;
  readonly total: number;
  readonly done: number;
  readonly threshold: number;
  readonly score: number | null;
  readonly criticalFailures: number | null;
  /** True when it ran this agent version, on the connected model, against the current golden set. */
  readonly current: boolean;
  readonly startedBy: Person;
  readonly startedAt: Date;
  readonly finishedAt: Date | null;
  readonly cases: readonly EvalCaseView[];
}

export type AgentStatus = "on" | "ready" | "blocked" | "evaluating" | "failed";

export interface AgentView {
  readonly id: AgentId;
  readonly version: string;
  readonly title: string;
  readonly purpose: string;
  readonly sends: string;
  readonly status: AgentStatus;
  /** One sentence on why it is in that status. */
  readonly statusReason: string;
  readonly latestEval: EvalView | null;
  readonly actions: { readonly evaluate: boolean; readonly enable: boolean; readonly disable: boolean };
}

export interface AgentRunView {
  readonly id: string;
  readonly agentId: string;
  readonly purpose: "intake" | "draft" | "eval";
  readonly state: "running" | "succeeded" | "failed" | "stale";
  readonly errorCode: string | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  /** Answered from cache: no model call, no tokens. */
  readonly reused: boolean;
  readonly startedAt: Date;
  readonly finishedAt: Date | null;
}

export interface AgentsOverview {
  readonly connection: ConnectionView | null;
  readonly agents: readonly AgentView[];
  readonly canManage: boolean;
  readonly sandbox: boolean;
  /** Providers this tenant may connect. Sandboxes cannot point Aegis at custom endpoints. */
  readonly providers: readonly ModelProviderId[];
  readonly recentRuns: readonly AgentRunView[];
  readonly usage: TokenUsage;
}

export interface IntakeSuggestions {
  readonly runId: string;
  readonly suggestions: readonly IntakeSuggestion[];
}

interface ConnectionRow {
  provider: ModelProviderId;
  model: string;
  endpoint: string | null;
  api_version: string | null;
  key_ciphertext: string | null;
  key_hint: string | null;
  fingerprint: string;
  updated_by: string;
  updated_by_name: string | null;
  updated_at: Date;
}

interface EvalRow {
  id: string;
  agent_id: AgentId;
  agent_version: string;
  golden_set: string;
  pack_id: string;
  pack_version: string;
  fingerprint: string;
  state: EvalView["state"];
  error_code: string | null;
  total: number;
  threshold: string;
  results: EvalCaseResult[];
  score: string | null;
  critical_failures: number | null;
  started_by: string;
  started_by_name: string | null;
  started_at: Date;
  finished_at: Date | null;
}

interface Gate {
  readonly on: boolean;
  readonly enabled: boolean;
  readonly reason: string;
  readonly connection: ConnectionRow | null;
  readonly pack: InitiativePack | null;
  readonly goldenSet: string | null;
  readonly passing: EvalRow | null;
}

const KEY_PURPOSE = "model-key";
const SANDBOX_PROVIDERS: readonly ModelProviderId[] = ["scripted", "openai"];

const FAILURE_WORDS: Record<string, string> = {
  timeout: "didn't answer in time",
  rate_limited: "is being rate limited by the model provider",
  provider_error: "couldn't reach the model provider",
  auth_failed: "was refused by the model provider; check the key",
  bad_request: "was refused by the model provider; check the model settings",
  endpoint_blocked: "was blocked: the endpoint resolves to a private address",
  no_key: "has no readable key; enter the key again",
  invalid_output: "gave an answer in the wrong shape",
  decision_language: "tried to state a decision, so its answer was discarded",
  unknown_control: "cited a control this case doesn't have, so its answer was discarded",
  interrupted: "was interrupted by a restart",
  budget: "is paused: this month's token budget is used up",
};
export const failureWords = (code: string) => FAILURE_WORDS[code] ?? "failed";

export function createAgents(k: Kernel, db: Database, options: AgentOptions = {}) {
  const system = (tenant: TenantId, job: string): SystemPrincipal => ({ kind: "system", tenantId: tenant, job });
  const drafter = (tenant: TenantId): AgentPrincipal => ({ kind: "agent", tenantId: tenant, agent: "review-drafter" });
  const enqueue = (tx: Connection, job: AgentJob) => k.afterCommit(tx, () => options.jobs?.enqueue(job));
  const intakeCache = new AnswerCache<readonly IntakeSuggestion[]>();

  /* -------------------------------------------------------------- reads */

  async function connectionRow(tx: Connection): Promise<ConnectionRow | null> {
    const { rows } = await tx.query<ConnectionRow>(
      `SELECT m.provider, m.model, m.endpoint, m.api_version, m.key_ciphertext, m.key_hint, m.fingerprint,
              m.updated_by, u.display_name AS updated_by_name, m.updated_at
       FROM model_connections m LEFT JOIN users u ON u.id = m.updated_by`,
    );
    return rows[0] ?? null;
  }

  /** The tenant's enabled initiative pack; its golden sets gate the agents. */
  async function currentPack(tx: Connection): Promise<InitiativePack | null> {
    const { rows } = await tx.query<{ content: PolicyPack }>(
      "SELECT content FROM policy_packs WHERE enabled AND content->>'kind' = 'initiative' ORDER BY pack_id LIMIT 1",
    );
    const pack = rows[0]?.content;
    return pack?.kind === "initiative" ? pack : null;
  }

  async function evalRows(tx: Connection, where: string, params: unknown[], lock = false): Promise<EvalRow[]> {
    const { rows } = await tx.query<EvalRow>(
      `SELECT e.*, u.display_name AS started_by_name FROM agent_evals e LEFT JOIN users u ON u.id = e.started_by
       WHERE ${where} ORDER BY e.started_at DESC, e.id${lock ? " FOR UPDATE OF e" : ""}`,
      params,
    );
    return rows;
  }

  const matches = (e: EvalRow, agent: AgentId, connection: ConnectionRow | null, goldenSet: string | null) =>
    e.agent_version === AGENTS[agent].version && e.fingerprint === connection?.fingerprint && e.golden_set === goldenSet;

  async function gateFor(tx: Connection, agent: AgentId): Promise<Gate> {
    const [connection, pack, setting] = await Promise.all([
      connectionRow(tx),
      currentPack(tx),
      tx.query<{ enabled: boolean; eval_id: string | null }>("SELECT enabled, eval_id FROM agent_settings WHERE agent_id = $1", [agent]),
    ]);
    const set = pack ? goldenSetFor(pack, agent) : null;
    const goldenSet = set ? goldenSetKey(set) : null;
    const [latestPass] = await evalRows(tx, "e.agent_id = $1 AND e.state = 'passed'", [agent]);
    const passing = latestPass && matches(latestPass, agent, connection, goldenSet) ? latestPass : null;
    const enabled = setting.rows[0]?.enabled ?? false;
    const base = { enabled, connection, pack, goldenSet, passing };
    if (!connection) return { ...base, on: false, reason: "No model is connected." };
    if (!set) return { ...base, on: false, reason: "The policy pack has no golden set for this agent." };
    if (!passing) return { ...base, on: false, reason: "It has not passed its golden set on this model." };
    if (!enabled) return { ...base, on: false, reason: "It passed its golden set; an admin has not turned it on." };
    return { ...base, on: true, reason: "On." };
  }

  async function isSandbox(tx: Connection): Promise<boolean> {
    const { rows } = await tx.query<{ sandbox: boolean }>("SELECT sandbox_expires_at IS NOT NULL AS sandbox FROM tenants");
    return rows[0]?.sandbox ?? false;
  }

  /** The connection with its key opened, for one run. The key lives only as long as the returned object. */
  async function openConnection(tx: Connection, tenant: TenantId, row: ConnectionRow): Promise<ModelConnection> {
    let apiKey: string | null = null;
    if (row.key_ciphertext) {
      apiKey = options.secrets ? await openSecret(tx, options.secrets, tenant, KEY_PURPOSE, row.key_ciphertext) : null;
      if (!apiKey) throw new AgentFailure("no_key", "the saved key cannot be read; enter it again");
    }
    return { provider: row.provider, model: row.model, endpoint: row.endpoint, apiVersion: row.api_version, apiKey };
  }

  const providerFor = async (connection: ModelConnection) =>
    options.models ? options.models(connection) : modelProviderFor(connection, options.endpointPolicy);

  async function startRun(
    tx: Connection,
    input: {
      agent: AgentId;
      fingerprint: string;
      purpose: "intake" | "draft" | "eval";
      requestedBy: string;
      at: Date;
      assetId?: string;
      caseId?: string;
      reviewId?: string;
      evalId?: string;
    },
  ): Promise<string> {
    const id = randomUUID();
    await tx.query(
      `INSERT INTO agent_runs (id, tenant_id, agent_id, agent_version, fingerprint, purpose, requested_by,
                               asset_id, case_id, review_id, eval_id, started_at)
       VALUES ($1, current_tenant_id(), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        id,
        input.agent,
        AGENTS[input.agent].version,
        input.fingerprint,
        input.purpose,
        input.requestedBy,
        input.assetId ?? null,
        input.caseId ?? null,
        input.reviewId ?? null,
        input.evalId ?? null,
        input.at.toISOString(),
      ],
    );
    return id;
  }

  async function finishRun(
    tx: Connection,
    runId: string,
    state: "succeeded" | "failed" | "stale",
    at: Date,
    extra: { code?: string; usage?: AgentUsage; result?: Record<string, unknown> } = {},
  ): Promise<void> {
    await tx.query(
      `UPDATE agent_runs SET state = $2, error_code = $3, input_tokens = $4, output_tokens = $5,
              result = $6, finished_at = $7
       WHERE id = $1`,
      [
        runId,
        state,
        extra.code ?? null,
        extra.usage?.inputTokens ?? null,
        extra.usage?.outputTokens ?? null,
        JSON.stringify(extra.result ?? {}),
        at.toISOString(),
      ],
    );
  }

  function toEvalView(e: EvalRow, pack: InitiativePack | null, current: boolean): EvalView {
    const set = pack ? goldenSetFor(pack, e.agent_id) : null;
    const titles = new Map((set?.cases ?? []).map((c) => [c.id, c.title]));
    return {
      id: e.id,
      state: e.state,
      errorCode: e.error_code,
      goldenSet: e.golden_set,
      total: e.total,
      done: e.results.length,
      threshold: Number(e.threshold),
      score: e.score === null ? null : Number(e.score),
      criticalFailures: e.critical_failures,
      current,
      startedBy: { id: e.started_by, name: e.started_by_name },
      startedAt: new Date(e.started_at),
      finishedAt: e.finished_at ? new Date(e.finished_at) : null,
      cases: e.results.map((r) => ({ ...r, title: titles.get(r.caseId) ?? r.caseId })),
    };
  }

  function requireManager(actor: Principal): void {
    if (!can(actor, "tenant.manage")) throw new GovernanceError("forbidden", "only an admin manages agents");
  }

  function requireAgent(agent: string): AgentId {
    if (!isAgentId(agent)) throw new GovernanceError("not_found", `no agent ${agent}`);
    return agent;
  }

  /* ------------------------------------------------ drafting (transaction steps) */

  /** Queue a draft for a pending review, if the drafter is on. Call inside the transaction that made it pending. */
  async function queueDraft(tx: Connection, tenant: TenantId, reviewId: string, how: { settle?: boolean } = {}): Promise<boolean> {
    if (!(await gateFor(tx, "review-drafter")).on) return false;
    const requestId = randomUUID();
    await tx.query(
      "UPDATE domain_reviews SET draft_status = 'queued', draft_request_id = $2, draft_error = NULL WHERE id = $1",
      [reviewId, requestId],
    );
    enqueue(tx, { kind: "draft", tenantId: tenant, reviewId, requestId, ...(how.settle ? { settle: true } : {}) });
    return true;
  }

  /** A person acted on the review: a draft still in flight no longer applies. */
  async function cancelDraft(tx: Connection, reviewId: string): Promise<void> {
    await tx.query("UPDATE domain_reviews SET draft_status = 'none' WHERE id = $1 AND draft_status = 'queued'", [reviewId]);
  }

  interface ReviewForDraft {
    id: string;
    case_id: string;
    domain: string;
    status: DomainReviewStatus;
    revision: number;
    draft_status: string;
    draft_request_id: string | null;
    note_body: string | null;
    draft_context_hash: string | null;
  }

  async function lockReview(tx: Connection, reviewId: string): Promise<ReviewForDraft | null> {
    const { rows } = await tx.query<ReviewForDraft>(
      `SELECT r.id, r.case_id, r.domain, r.status, r.revision, r.draft_status, r.draft_request_id, r.draft_context_hash,
              n.body AS note_body
       FROM domain_reviews r LEFT JOIN notes n ON n.id = r.note_id
       WHERE r.id = $1 FOR UPDATE OF r`,
      [reviewId],
    );
    return rows[0] ?? null;
  }

  const draftable = (r: ReviewForDraft, c: Case, job: DraftJob) =>
    r.draft_request_id === job.requestId &&
    r.draft_status === "queued" &&
    c.state === "in_review" &&
    (r.status === "pending" || r.status === "drafted");

  /** Everything the drafter sees for one review: this case, this domain, nothing else. */
  async function draftContext(tx: Connection, c: Case, review: ReviewForDraft) {
    const pack = await k.loadPack(tx, c);
    if (pack.kind !== "initiative" || !c.triage) throw new AgentFailure("bad_request", "this case has no controls to draft against");
    const { rows: assetRows } = await tx.query<{ kind: string; name: string }>("SELECT kind, name FROM assets WHERE id = $1", [
      c.assetId,
    ]);
    const controls = requiredControls(pack.controls, c.triage, c.answers).filter((ctl) => ctl.domain === review.domain);
    const ids = controls.map((ctl) => ctl.id);
    const { rows: evidence } = await tx.query<{ control_id: string; kind: "link" | "attestation"; title: string; detail: string | null }>(
      "SELECT control_id, kind, title, detail FROM evidence WHERE asset_id = $1 AND control_id = ANY($2) ORDER BY added_at, id",
      [c.assetId, ids],
    );
    const { rows: exceptions } = await tx.query<{ control_id: string; state: string; expires_at: Date | null }>(
      "SELECT control_id, state, expires_at FROM control_exceptions WHERE asset_id = $1 AND control_id = ANY($2) ORDER BY created_at, id",
      [c.assetId, ids],
    );
    const now = k.now();
    const exceptionState: Record<string, "requested" | "approved"> = {};
    for (const x of exceptions) {
      if (x.state === "requested") exceptionState[x.control_id] = "requested";
      else if (exceptionActive(x.state as "approved", x.expires_at ? new Date(x.expires_at) : null, now)) {
        exceptionState[x.control_id] = "approved";
      } else delete exceptionState[x.control_id];
    }
    const byControl: Record<string, { kind: "link" | "attestation"; title: string; detail: string | null }[]> = {};
    for (const e of evidence) (byControl[e.control_id] ??= []).push({ kind: e.kind, title: e.title, detail: e.detail });
    return buildDraftContext(pack, {
      asset: assetRows[0]!,
      answers: c.answers as Answers,
      domain: review.domain,
      evidence: byControl,
      exceptions: exceptionState,
      thread: review.note_body ? `Latest on this review: ${review.note_body}` : null,
    });
  }

  async function loadCaseRow(tx: Connection, caseId: string): Promise<Case> {
    const { rows } = await tx.query<CaseRow>("SELECT * FROM cases WHERE id = $1", [caseId]);
    return toCase(rows[0]!);
  }

  const runtime: AgentRuntime = {
    async draft(job) {
      const tenant = tenantId(job.tenantId);
      const job_ = system(tenant, "review-drafter");
      const claim = await k.inTenant(job_, async (tx) => {
        const review = await lockReview(tx, job.reviewId);
        if (!review) return null;
        const c = await loadCaseRow(tx, review.case_id);
        if (!draftable(review, c, job)) {
          // Still this job's request, but the case was decided or a person acted: nothing left to draft.
          if (review.draft_request_id === job.requestId) await cancelDraft(tx, review.id);
          return null;
        }
        const gate = await gateFor(tx, "review-drafter");
        if (!gate.on || !gate.connection) {
          await tx.query("UPDATE domain_reviews SET draft_status = 'none' WHERE id = $1", [review.id]);
          return null;
        }
        const at = k.now();
        // A run still marked running for this review was cut off by a crash or deploy.
        await tx.query(
          "UPDATE agent_runs SET state = 'failed', error_code = 'interrupted', finished_at = $2 WHERE review_id = $1 AND state = 'running'",
          [review.id, at.toISOString()],
        );
        let context: DraftContext | null = null;
        try {
          context = await draftContext(tx, c, review);
        } catch {
          // Recorded as a failed run below, as before.
        }
        const contextHash = context
          ? inputHash(AGENTS["review-drafter"].version, gate.connection.fingerprint, context)
          : null;
        if (contextHash && review.status === "drafted" && review.draft_context_hash === contextHash) {
          // Nothing the drafter sees has changed: the draft on file stands, at no cost.
          await tx.query("UPDATE domain_reviews SET draft_status = 'ready' WHERE id = $1", [review.id]);
          return null;
        }
        if (await monthlyBlock(tx, at)) {
          await tx.query("UPDATE domain_reviews SET draft_status = 'failed', draft_error = 'budget' WHERE id = $1", [review.id]);
          return null;
        }
        const runId = await startRun(tx, {
          agent: "review-drafter",
          fingerprint: gate.connection.fingerprint,
          purpose: "draft",
          requestedBy: actorId(job_),
          at,
          assetId: c.assetId,
          caseId: c.id,
          reviewId: review.id,
        });
        try {
          const connection = await openConnection(tx, tenant, gate.connection);
          return {
            runId,
            revision: review.revision,
            context: context ?? (await draftContext(tx, c, review)),
            contextHash,
            connection,
            fingerprint: gate.connection.fingerprint,
          };
        } catch (error) {
          await finishRun(tx, runId, "failed", at, { code: classifyFailure(error).code });
          return { runId, failure: classifyFailure(error) };
        }
      });
      if (!claim) return "skipped";
      if ("failure" in claim) throw claim.failure;

      let drafted;
      try {
        drafted = await draftReview(await providerFor(claim.connection), claim.connection.model, claim.context, {
          ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
        });
      } catch (error) {
        const failure = classifyFailure(error);
        await k.inTenant(job_, (tx) => finishRun(tx, claim.runId, "failed", k.now(), { code: failure.code }));
        throw failure;
      }

      return k.inTenant(job_, async (tx) => {
        const at = k.now();
        const review = await lockReview(tx, job.reviewId);
        const c = review ? await loadCaseRow(tx, review.case_id) : null;
        if (!review || !c || !draftable(review, c, job) || review.revision !== claim.revision) {
          await finishRun(tx, claim.runId, "stale", at, { usage: drafted.usage });
          if (review?.draft_request_id === job.requestId) await cancelDraft(tx, review.id);
          return "stale";
        }
        const agent = drafter(tenant);
        const event = domainReviewLifecycle.transition(review.status, "draft", agent, { at });
        const note = (await k.writeNote(tx, agent, { assetId: c.assetId, caseId: c.id }, JSON.stringify(drafted.draft)))!;
        const revision = review.revision + 1;
        await tx.query(
          `UPDATE domain_reviews
           SET status = $2, revision = $3, draft_status = 'ready', draft_note_id = $4, draft_run_id = $5,
               draft_error = NULL, draft_context_hash = $7, updated_at = $6
           WHERE id = $1`,
          [review.id, event.after, revision, note.id, claim.runId, at.toISOString(), claim.contextHash],
        );
        const counts = {
          findings: drafted.draft.findings.length,
          questions: drafted.draft.questionsForOwner.length,
          conditions: drafted.draft.proposedConditions.length,
        };
        await appendAudit(tx, {
          assetId: c.assetId,
          caseId: c.id,
          actorKind: "agent",
          actorId: actorId(agent),
          action: "review.draft",
          before: event.before,
          after: event.after,
          note,
          payload: { domain: review.domain, revision, runId: claim.runId, model: claim.fingerprint, ...counts },
          at,
        });
        await finishRun(tx, claim.runId, "succeeded", at, { usage: drafted.usage, result: counts });
        return "drafted" satisfies DraftOutcome;
      });
    },

    async abandonDraft(job, code) {
      const tenant = tenantId(job.tenantId);
      return k.inTenant(system(tenant, "review-drafter"), async (tx) => {
        const { rows } = await tx.query(
          `UPDATE domain_reviews SET draft_status = 'failed', draft_error = $3
           WHERE id = $1 AND draft_request_id = $2 AND draft_status = 'queued' RETURNING id`,
          [job.reviewId, job.requestId, code],
        );
        return rows.length > 0 ? "failed" : "stale";
      });
    },

    async evalCasesLeft(job) {
      return k.inTenant(system(tenantId(job.tenantId), "agent-evals"), async (tx) => {
        const [e] = await evalRows(tx, "e.id = $1", [job.evalId]);
        if (!e || e.state !== "running") return [];
        const pack = await k.loadPack(tx, { packId: e.pack_id, packVersion: e.pack_version });
        const set = pack.kind === "initiative" ? goldenSetFor(pack, e.agent_id) : null;
        const done = new Set(e.results.map((r) => r.caseId));
        return (set?.cases ?? []).map((c) => c.id).filter((id) => !done.has(id));
      });
    },

    async evalCase(job, caseId) {
      const tenant = tenantId(job.tenantId);
      const who = system(tenant, "agent-evals");
      const claim = await k.inTenant(who, async (tx) => {
        const [e] = await evalRows(tx, "e.id = $1", [job.evalId]);
        if (!e || e.state !== "running" || e.results.some((r) => r.caseId === caseId)) return null;
        const connection = await connectionRow(tx);
        const pack = await k.loadPack(tx, { packId: e.pack_id, packVersion: e.pack_version });
        if (!connection || connection.fingerprint !== e.fingerprint || pack.kind !== "initiative") {
          await tx.query(
            "UPDATE agent_evals SET state = 'error', error_code = 'model_changed', finished_at = $2 WHERE id = $1",
            [e.id, k.now().toISOString()],
          );
          return null;
        }
        const at = k.now();
        await tx.query(
          "UPDATE agent_runs SET state = 'failed', error_code = 'interrupted', finished_at = $2 WHERE eval_id = $1 AND state = 'running'",
          [e.id, at.toISOString()],
        );
        const runId = await startRun(tx, { agent: e.agent_id, fingerprint: e.fingerprint, purpose: "eval", requestedBy: actorId(who), at, evalId: e.id });
        try {
          return { e, pack, runId, connection: await openConnection(tx, tenant, connection) };
        } catch (error) {
          return { e, pack, runId, connection: null, failure: classifyFailure(error) };
        }
      });
      if (!claim) return "skipped";

      let result: EvalCaseResult;
      if (!claim.connection) {
        result = { caseId, passed: false, score: 0, critical: [claim.failure!.code], misses: [] };
      } else {
        try {
          result = await evalCase(claim.e.agent_id, await providerFor(claim.connection), claim.connection.model, claim.pack, caseId, {
            throwTransient: true,
            ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
          });
        } catch (error) {
          const failure = classifyFailure(error);
          await k.inTenant(who, (tx) => finishRun(tx, claim.runId, "failed", k.now(), { code: failure.code }));
          throw failure;
        }
      }
      await k.inTenant(who, async (tx) => {
        await recordCase(tx, job.evalId, result);
        await finishRun(tx, claim.runId, "succeeded", k.now(), { result: { passed: result.passed, critical: result.critical.length } });
      });
      return result.passed ? "passed" : "failed";
    },

    async recordEvalFailure(job, caseId, code) {
      await k.inTenant(system(tenantId(job.tenantId), "agent-evals"), (tx) =>
        recordCase(tx, job.evalId, { caseId, passed: false, score: 0, critical: [code], misses: [] }),
      );
      return "failed";
    },

    async finishEval(job) {
      const tenant = tenantId(job.tenantId);
      const who = system(tenant, "agent-evals");
      return k.inTenant(who, async (tx) => {
        const [e] = await evalRows(tx, "e.id = $1", [job.evalId], true);
        if (!e || e.state !== "running") return e?.state ?? "missing";
        const at = k.now();
        const summary = summarize({ threshold: Number(e.threshold) }, e.results);
        const state = e.results.length < e.total ? "error" : summary.passed ? "passed" : "failed";
        await tx.query(
          `UPDATE agent_evals SET state = $2, score = $3, critical_failures = $4, finished_at = $5,
                  error_code = CASE WHEN $2 = 'error' THEN 'incomplete' ELSE NULL END
           WHERE id = $1`,
          [e.id, state, summary.score, summary.criticalFailures, at.toISOString()],
        );
        await appendAudit(tx, {
          actorKind: "system",
          actorId: actorId(who),
          action: "agent.evaluated",
          after: state,
          payload: {
            agentId: e.agent_id,
            evalId: e.id,
            goldenSet: e.golden_set,
            model: e.fingerprint,
            score: Math.round(summary.score * 1000) / 1000,
            criticalFailures: summary.criticalFailures,
            total: e.total,
          },
          at,
        });
        return state;
      });
    },

    async pendingJobs() {
      // Across tenants, on the platform connection: ids only.
      return db.run(async (conn) => {
        const drafts = await conn.query<{ tenant_id: string; id: string; draft_request_id: string }>(
          "SELECT tenant_id, id, draft_request_id FROM domain_reviews WHERE draft_status = 'queued' ORDER BY updated_at, id",
        );
        const evals = await conn.query<{ tenant_id: string; id: string }>(
          "SELECT tenant_id, id FROM agent_evals WHERE state = 'running' ORDER BY started_at, id",
        );
        return [
          ...drafts.rows.map((r): AgentJob => ({ kind: "draft", tenantId: r.tenant_id, reviewId: r.id, requestId: r.draft_request_id })),
          ...evals.rows.map((r): AgentJob => ({ kind: "eval", tenantId: r.tenant_id, evalId: r.id })),
        ];
      });
    },
  };

  /** Record one graded case, once: a retried step never counts a case twice. */
  async function recordCase(tx: Connection, evalId: string, result: EvalCaseResult): Promise<void> {
    await tx.query(
      `UPDATE agent_evals SET results = results || jsonb_build_array($2::jsonb)
       WHERE id = $1 AND state = 'running'
         AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(results) r WHERE r->>'caseId' = $3)`,
      [evalId, JSON.stringify(result), result.caseId],
    );
  }

  /* ---------------------------------------------------------------- service */

  return {
    runtime,
    queueDraft,
    cancelDraft,
    gateFor,

    /** Whether each agent is on, why, and what this viewer may do about it. */
    agentsOverview(actor: Principal): Promise<AgentsOverview> {
      return k.inTenant(actor, async (tx) => {
        if (actor.kind !== "human") throw new GovernanceError("forbidden", "people only");
        const canManage = can(actor, "tenant.manage");
        const [connection, sandbox, usage, runs] = await Promise.all([
          connectionRow(tx),
          isSandbox(tx),
          tokenUsage(tx, k.now()),
          tx.query<{
            id: string;
            agent_id: string;
            purpose: AgentRunView["purpose"];
            state: AgentRunView["state"];
            error_code: string | null;
            input_tokens: number | null;
            output_tokens: number | null;
            result: { reused?: boolean } | null;
            started_at: Date;
            finished_at: Date | null;
          }>("SELECT * FROM agent_runs ORDER BY started_at DESC, id LIMIT 8"),
        ]);
        const agents: AgentView[] = [];
        for (const id of AGENT_IDS) {
          const gate = await gateFor(tx, id);
          const [latest] = await evalRows(tx, "e.agent_id = $1", [id]);
          const latestCurrent = latest ? matches(latest, id, connection, gate.goldenSet) : false;
          const status: AgentStatus = gate.on
            ? "on"
            : latest?.state === "running" && latestCurrent
              ? "evaluating"
              : gate.passing
                ? "ready"
                : latest && latestCurrent && (latest.state === "failed" || latest.state === "error")
                  ? "failed"
                  : "blocked";
          const statusReason =
            status === "on"
              ? "On, after passing its golden set on this model."
              : status === "evaluating"
                ? `Running its golden set: ${latest!.results.length} of ${latest!.total} cases done.`
                : status === "failed"
                  ? latest!.state === "error"
                    ? "Its last evaluation stopped before finishing."
                    : `It failed its golden set${latest!.critical_failures ? ` with ${latest!.critical_failures} critical failure${latest!.critical_failures === 1 ? "" : "s"}` : ""}.`
                  : gate.reason;
          agents.push({
            ...AGENTS[id],
            status,
            statusReason,
            latestEval: latest ? toEvalView(latest, gate.pack, latestCurrent) : null,
            actions: {
              evaluate: canManage && connection !== null && gate.goldenSet !== null && status !== "evaluating",
              enable: canManage && status === "ready",
              disable: canManage && gate.enabled,
            },
          });
        }
        return {
          connection: connection
            ? {
                provider: connection.provider,
                model: connection.model,
                endpoint: connection.endpoint,
                apiVersion: connection.api_version,
                keyHint: connection.key_hint,
                label: describeConnection(connection),
                fingerprint: connection.fingerprint,
                updatedBy: { id: connection.updated_by, name: connection.updated_by_name },
                updatedAt: new Date(connection.updated_at),
              }
            : null,
          agents,
          canManage,
          sandbox,
          providers: sandbox ? SANDBOX_PROVIDERS : MODEL_PROVIDERS,
          usage,
          recentRuns: runs.rows.map((r) => ({
            id: r.id,
            agentId: r.agent_id,
            purpose: r.purpose,
            state: r.state,
            errorCode: r.error_code,
            inputTokens: r.input_tokens,
            outputTokens: r.output_tokens,
            reused: r.result?.reused === true,
            startedAt: new Date(r.started_at),
            finishedAt: r.finished_at ? new Date(r.finished_at) : null,
          })),
        };
      });
    },

    /**
     * Connect the tenant's model. Leave the key blank to keep the saved one.
     * A different model or endpoint turns every agent off until it passes
     * its golden set again.
     */
    connectModel(
      actor: Principal,
      input: { provider: string; model: string; endpoint?: string | null; apiVersion?: string | null; apiKey?: string | null },
    ): Promise<ConnectionView> {
      return k.inTenant(actor, async (tx) => {
        requireManager(actor);
        const provider = input.provider as ModelProviderId;
        if (!MODEL_PROVIDERS.includes(provider)) throw new GovernanceError("invalid", `unknown provider: ${input.provider}`);
        if ((await isSandbox(tx)) && !SANDBOX_PROVIDERS.includes(provider)) {
          throw new GovernanceError("invalid", "a sandbox can use the scripted model or OpenAI only");
        }
        const prior = await connectionRow(tx);
        const newKey = input.apiKey?.trim() || null;
        const keepKey = !newKey && prior?.provider === provider && prior.key_ciphertext !== null;
        const connection: ModelConnection = {
          provider,
          model: provider === "scripted" ? "scripted" : input.model.trim(),
          endpoint: provider === "azure-openai" || provider === "openai-compatible" ? input.endpoint?.trim() || null : null,
          apiVersion: provider === "azure-openai" ? input.apiVersion?.trim() || null : null,
          apiKey: provider === "scripted" ? null : newKey ?? (keepKey ? "saved" : null),
        };
        const problems = connectionProblems(connection, options.endpointPolicy);
        if (problems.length > 0) throw new GovernanceError("invalid", problems.join("; "));
        if (newKey && provider !== "scripted" && !options.secrets) {
          throw new GovernanceError("invalid", "this server has no master key to seal model keys with");
        }
        const at = k.now();
        const fingerprint = modelFingerprint(connection);
        const ciphertext =
          provider === "scripted"
            ? null
            : newKey
              ? await sealSecret(tx, options.secrets!, actor.tenantId, KEY_PURPOSE, newKey, at)
              : prior!.key_ciphertext;
        const hint = provider === "scripted" ? null : newKey ? newKey.slice(-4) : (prior?.key_hint ?? null);
        await tx.query(
          `INSERT INTO model_connections (tenant_id, provider, model, endpoint, api_version, key_ciphertext, key_hint,
                                          fingerprint, updated_by, updated_at)
           VALUES (current_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9)
           ON CONFLICT (tenant_id) DO UPDATE SET provider = $1, model = $2, endpoint = $3, api_version = $4,
             key_ciphertext = $5, key_hint = $6, fingerprint = $7, updated_by = $8, updated_at = $9`,
          [provider, connection.model, connection.endpoint, connection.apiVersion, ciphertext, hint, fingerprint, actorId(actor), at.toISOString()],
        );
        await appendAudit(tx, {
          actorKind: actor.kind,
          actorId: actorId(actor),
          action: "agent.connect",
          payload: { provider, model: fingerprint, keyChanged: newKey !== null },
          at,
        });
        if (prior && prior.fingerprint !== fingerprint) {
          const { rows } = await tx.query<{ agent_id: string }>(
            "UPDATE agent_settings SET enabled = false, updated_by = $1, updated_at = $2 WHERE enabled RETURNING agent_id",
            [actorId(actor), at.toISOString()],
          );
          for (const row of rows) {
            await appendAudit(tx, {
              actorKind: actor.kind,
              actorId: actorId(actor),
              action: "agent.disable",
              payload: { agentId: row.agent_id, because: "model_changed" },
              at,
            });
          }
        }
        const saved = (await connectionRow(tx))!;
        return {
          provider: saved.provider,
          model: saved.model,
          endpoint: saved.endpoint,
          apiVersion: saved.api_version,
          keyHint: saved.key_hint,
          label: describeConnection(saved),
          fingerprint: saved.fingerprint,
          updatedBy: { id: saved.updated_by, name: saved.updated_by_name },
          updatedAt: new Date(saved.updated_at),
        };
      });
    },

    /** Run an agent against its golden set on the connected model, in the background. */
    startEval(actor: Principal, agent: string): Promise<string> {
      return k.inTenant(actor, async (tx) => {
        requireManager(actor);
        const id = requireAgent(agent);
        const connection = await connectionRow(tx);
        if (!connection) throw new GovernanceError("invalid", "connect a model first");
        const { rows: packs } = await tx.query<{ pack_id: string; version: string; content: PolicyPack }>(
          "SELECT pack_id, version, content FROM policy_packs WHERE enabled AND content->>'kind' = 'initiative' ORDER BY pack_id LIMIT 1",
        );
        const packRow = packs[0];
        const set = packRow && packRow.content.kind === "initiative" ? goldenSetFor(packRow.content, id) : null;
        if (!packRow || !set) throw new GovernanceError("invalid", "the policy pack has no golden set for this agent");
        const running = await tx.query("SELECT 1 FROM agent_evals WHERE agent_id = $1 AND state = 'running'", [id]);
        if (running.rows.length > 0) throw new GovernanceError("conflict", "an evaluation of this agent is already running");

        const evalId = randomUUID();
        const at = k.now();
        await tx.query(
          `INSERT INTO agent_evals (id, tenant_id, agent_id, agent_version, golden_set, pack_id, pack_version, fingerprint,
                                    total, threshold, started_by, started_at)
           VALUES ($1, current_tenant_id(), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
          [
            evalId,
            id,
            AGENTS[id].version,
            goldenSetKey(set),
            packRow.pack_id,
            packRow.version,
            connection.fingerprint,
            set.cases.length,
            set.threshold,
            actorId(actor),
            at.toISOString(),
          ],
        );
        await appendAudit(tx, {
          actorKind: actor.kind,
          actorId: actorId(actor),
          action: "agent.evaluate",
          payload: { agentId: id, evalId, goldenSet: goldenSetKey(set), model: connection.fingerprint },
          at,
        });
        enqueue(tx, { kind: "eval", tenantId: actor.tenantId, evalId });
        return evalId;
      });
    },

    /** Turn an agent on (only after it passed on this model) or off. */
    /** Cap this tenant's monthly tokens and each person's daily intake requests. */
    setBudget(actor: Principal, budget: Budget): Promise<void> {
      return k.inTenant(actor, async (tx) => {
        requireManager(actor);
        const { monthlyTokens, dailyIntakePerPerson } = budget;
        if (monthlyTokens !== null && (!Number.isInteger(monthlyTokens) || monthlyTokens < 1_000 || monthlyTokens > 2_000_000_000)) {
          throw new GovernanceError("invalid", "set the monthly budget between 1,000 and 2,000,000,000 tokens, or no cap");
        }
        if (!Number.isInteger(dailyIntakePerPerson) || dailyIntakePerPerson < 1 || dailyIntakePerPerson > 1_000) {
          throw new GovernanceError("invalid", "set between 1 and 1,000 intake requests per person per day");
        }
        const before = await loadBudget(tx);
        if (before.monthlyTokens === monthlyTokens && before.dailyIntakePerPerson === dailyIntakePerPerson) return;
        const at = k.now();
        await tx.query(
          `INSERT INTO agent_budgets (tenant_id, monthly_tokens, daily_intake_per_person, updated_by, updated_at)
           VALUES (current_tenant_id(), $1, $2, $3, $4)
           ON CONFLICT (tenant_id) DO UPDATE SET monthly_tokens = $1, daily_intake_per_person = $2, updated_by = $3, updated_at = $4`,
          [monthlyTokens, dailyIntakePerPerson, actorId(actor), at.toISOString()],
        );
        // Drafts that stopped on the cap can go again once the new one leaves room.
        if (!(await monthlyBlock(tx, at))) {
          const { rows } = await tx.query<{ id: string }>(
            "SELECT id FROM domain_reviews WHERE draft_status = 'failed' AND draft_error = 'budget' AND status IN ('pending', 'drafted')",
          );
          for (const r of rows) await queueDraft(tx, actor.tenantId, r.id);
        }
        await appendAudit(tx, {
          actorKind: actor.kind,
          actorId: actorId(actor),
          action: "agent.budget",
          payload: {
            monthlyTokensBefore: before.monthlyTokens,
            monthlyTokens,
            dailyIntakeBefore: before.dailyIntakePerPerson,
            dailyIntake: dailyIntakePerPerson,
          },
          at,
        });
      });
    },

    setAgentEnabled(actor: Principal, agent: string, enabled: boolean): Promise<void> {
      return k.inTenant(actor, async (tx) => {
        requireManager(actor);
        const id = requireAgent(agent);
        const gate = await gateFor(tx, id);
        if (enabled && !gate.passing) throw new GovernanceError("conflict", gate.reason);
        if (enabled === gate.enabled) return;
        const at = k.now();
        await tx.query(
          `INSERT INTO agent_settings (tenant_id, agent_id, enabled, eval_id, updated_by, updated_at)
           VALUES (current_tenant_id(), $1, $2, $3, $4, $5)
           ON CONFLICT (tenant_id, agent_id) DO UPDATE SET enabled = $2, eval_id = coalesce($3, agent_settings.eval_id),
             updated_by = $4, updated_at = $5`,
          [id, enabled, gate.passing?.id ?? null, actorId(actor), at.toISOString()],
        );
        await appendAudit(tx, {
          actorKind: actor.kind,
          actorId: actorId(actor),
          action: enabled ? "agent.enable" : "agent.disable",
          payload: { agentId: id, evalId: gate.passing?.id ?? null },
          at,
        });
      });
    },

    /** Suggest intake answers from a description. The requester checks and submits every answer. */
    async suggestIntake(actor: Principal, description: string): Promise<IntakeSuggestions> {
      if (actor.kind !== "human" || !(can(actor, "asset.register") || can(actor, "case.submit"))) {
        throw new GovernanceError("forbidden", "only someone who registers systems can ask for suggestions");
      }
      const text = description.trim();
      if (text.length < 20) throw new GovernanceError("invalid", "describe the system in a sentence or two first");
      const claim = await k.inTenant(actor, async (tx) => {
        const gate = await gateFor(tx, "intake");
        if (!gate.on || !gate.connection || !gate.pack) throw new GovernanceError("conflict", `The intake assistant is off. ${gate.reason}`);
        const at = k.now();
        const cacheKey = inputHash(
          actor.tenantId,
          AGENTS.intake.version,
          gate.connection.fingerprint,
          gate.pack.id,
          gate.pack.version,
          text.replace(/\s+/g, " "),
        );
        const cached = intakeCache.get(cacheKey, at.getTime());
        if (cached) {
          // The same description on the same model and pack: answer again at no cost.
          const runId = await startRun(tx, { agent: "intake", fingerprint: gate.connection.fingerprint, purpose: "intake", requestedBy: actorId(actor), at });
          await finishRun(tx, runId, "succeeded", at, {
            usage: { inputTokens: 0, outputTokens: 0 },
            result: { answers: Object.fromEntries(cached.map((s) => [s.field, s.answer])), reused: true },
          });
          return { kind: "cached", result: { runId, suggestions: cached } } as const;
        }
        const budget = await loadBudget(tx);
        if ((await intakeCallsToday(tx, actorId(actor), at)) >= budget.dailyIntakePerPerson) {
          throw new GovernanceError(
            "conflict",
            `You've used today's ${budget.dailyIntakePerPerson} intake suggestions. Answer the questions yourself, or try again tomorrow.`,
          );
        }
        if (await monthlyBlock(tx, at)) {
          throw new GovernanceError("conflict", "This month's token budget is used up. Answer the questions yourself; an admin can raise the budget.");
        }
        const runId = await startRun(tx, {
          agent: "intake",
          fingerprint: gate.connection.fingerprint,
          purpose: "intake",
          requestedBy: actorId(actor),
          at,
        });
        try {
          return {
            kind: "call",
            runId,
            cacheKey,
            pack: gate.pack,
            connection: await openConnection(tx, actor.tenantId, gate.connection),
          } as const;
        } catch (error) {
          await finishRun(tx, runId, "failed", at, { code: classifyFailure(error).code });
          throw new GovernanceError("unavailable", `The intake assistant ${failureWords(classifyFailure(error).code)}.`);
        }
      });
      if (claim.kind === "cached") return claim.result;
      try {
        const { suggestions, usage } = await suggestIntake(
          await providerFor(claim.connection),
          claim.connection.model,
          claim.pack.questions,
          text,
          options.timeoutMs ? { timeoutMs: options.timeoutMs } : {},
        );
        await k.inTenant(actor, (tx) =>
          finishRun(tx, claim.runId, "succeeded", k.now(), {
            usage,
            result: { answers: Object.fromEntries(suggestions.map((s) => [s.field, s.answer])) },
          }),
        );
        intakeCache.set(claim.cacheKey, suggestions, k.now().getTime());
        return { runId: claim.runId, suggestions };
      } catch (error) {
        const failure = classifyFailure(error);
        await k.inTenant(actor, (tx) => finishRun(tx, claim.runId, "failed", k.now(), { code: failure.code }));
        throw new GovernanceError("unavailable", `The intake assistant ${failureWords(failure.code)}. Answer the questions yourself, or try again.`);
      }
    },

    /** Whether an agent is on for this tenant right now. */
    agentOn(actor: Principal, agent: string): Promise<boolean> {
      return k.inTenant(actor, async (tx) => (await gateFor(tx, requireAgent(agent))).on);
    },

    /** Ask the drafter for a fresh draft of one review. */
    requestDraft(actor: Principal, caseId: string, domain: string): Promise<void> {
      return k.inTenant(actor, async (tx) => {
        const c = await k.loadCase(tx, actor, caseId);
        if (!canSignDomain(actor, domain) || (actor.kind === "human" && actor.userId === c.ownerId)) {
          throw new GovernanceError("forbidden", `only a ${domain} reviewer can ask for a draft`);
        }
        const { rows } = await tx.query<{ id: string; status: DomainReviewStatus; draft_status: string }>(
          "SELECT id, status, draft_status FROM domain_reviews WHERE case_id = $1 AND domain = $2 FOR UPDATE",
          [c.id, domain],
        );
        const review = rows[0];
        if (!review) throw new GovernanceError("not_found", `no ${domain} review on this case`);
        if (c.state !== "in_review" || (review.status !== "pending" && review.status !== "drafted")) {
          throw new GovernanceError("conflict", "only a review waiting for a signature can be drafted");
        }
        if (review.draft_status === "queued") return;
        if (!(await queueDraft(tx, actor.tenantId, review.id))) {
          throw new GovernanceError("conflict", `The review drafter is off. ${(await gateFor(tx, "review-drafter")).reason}`);
        }
      });
    },

    /**
     * Check an intake suggestion run before a submission cites it: it must
     * be this person's, finished, and not already used.
     */
    async claimSuggestion(tx: Connection, actor: Principal, runId: string, c: Case, answers: Answers) {
      if (!UUID.test(runId) || actor.kind !== "human") throw new GovernanceError("invalid", "unknown suggestion run");
      const { rows } = await tx.query<{ result: { answers?: Record<string, string> }; requested_by: string; state: string; case_id: string | null }>(
        "SELECT result, requested_by, state, case_id FROM agent_runs WHERE id = $1 AND purpose = 'intake' FOR UPDATE",
        [runId],
      );
      const run = rows[0];
      if (!run || run.requested_by !== actor.userId || run.state !== "succeeded" || run.case_id !== null) {
        throw new GovernanceError("invalid", "unknown suggestion run");
      }
      await tx.query("UPDATE agent_runs SET case_id = $2, asset_id = $3 WHERE id = $1", [runId, c.id, c.assetId]);
      const suggested = Object.entries(run.result.answers ?? {}).filter(([, a]) => a === "yes" || a === "no");
      const changed = suggested.filter(([field, a]) => answers[field] !== (a === "yes")).map(([field]) => field);
      return { suggestionRunId: runId, suggested: suggested.length, keptAsSuggested: suggested.length - changed.length, changed };
    },
  };
}

export type Agents = ReturnType<typeof createAgents>;
