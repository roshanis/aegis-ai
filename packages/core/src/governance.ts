import { randomUUID } from "node:crypto";
import { appendAudit, sha256Hex, withTenant, type AuditPayload, type Connection, type Database } from "@aegis/db";
import {
  ASSET_KINDS,
  CASE_TRIGGERS,
  IllegalTransitionError,
  ROLES,
  assetLifecycle,
  can,
  caseKindFor,
  caseLifecycles,
  clearance,
  fastLaneEligibility,
  isDecided,
  roleConflicts,
  triage,
  type Answers,
  type AssetAction,
  type AssetKind,
  type AssetState,
  type CaseKind,
  type CaseSummary,
  type CaseTrigger,
  type Clearance,
  type FastLaneResult,
  type HumanPrincipal,
  type Principal,
  type Role,
  type SystemPrincipal,
  type TenantId,
  type Tier,
  type TriageResult,
  type UserId,
} from "@aegis/domain";
import type { InitiativePack, PolicyPack } from "@aegis/frameworks";
import { createAssurance, type Assurance, type NewCondition } from "./assurance";
import { GovernanceError } from "./errors";
import {
  PACK_KIND,
  SERVICE_ACTIONS,
  SUBMIT_ACTIONS,
  UUID,
  actorId,
  canSee,
  toAsset,
  toCase,
  type Asset,
  type AssetRow,
  type Case,
  type CaseRow,
  type Kernel,
} from "./model";

export { actorId, type Asset, type Case } from "./model";

/**
 * Governance services: the only path from a request to tenant data. Every
 * call runs inside one tenant-scoped transaction, applies the domain rules,
 * and appends to the audit log in the same transaction, so a state change
 * and its audit event commit or fail together.
 */

export interface AssetView {
  readonly asset: Asset;
  readonly ownerName: string | null;
  /** True when the viewer owns this asset. */
  readonly viewerIsOwner: boolean;
  readonly cases: readonly Case[];
  /** The case under way, if any. */
  readonly openCase: Case | null;
  readonly clearance: Clearance;
  /** Domain reviews, controls, evidence, exceptions and conditions. */
  readonly assurance: Assurance;
  /** What this viewer may do next; the UI offers exactly these. */
  readonly actions: {
    readonly asset: readonly AssetAction[];
    readonly openCase: readonly string[];
    /** Reviews this viewer may open now. */
    readonly newCase: readonly CaseTrigger[];
  };
}

export interface TenantInfo {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  /** Set for sandbox tenants, which are purged after this time. */
  readonly sandboxExpiresAt: Date | null;
}

export interface SubmitResult {
  readonly case: Case;
  /** Why the fast lane did or did not apply, for risk reviews. */
  readonly fastLane: FastLaneResult | null;
}

export interface HistoryEntry {
  readonly at: Date;
  readonly action: string;
  readonly before: string | null;
  readonly after: string | null;
  readonly caseId: string | null;
  readonly actor: { readonly kind: Principal["kind"]; readonly id: string; readonly name: string | null };
  /** True when this event decided a case. */
  readonly decision: boolean;
  /** The written reason, unless none was given or it has been erased. */
  readonly reason: string | null;
  readonly reasonStatus: "none" | "intact" | "erased" | "altered";
  /** The policy pack version the case was reviewed under. */
  readonly policy: { readonly packId: string; readonly packVersion: string } | null;
  readonly payload: AuditPayload;
}

export interface GovernanceOptions {
  readonly now?: () => Date;
}

function validateAnswers(pack: InitiativePack, answers: Answers): void {
  const fields = new Set(pack.questions.map((q) => q.field));
  const unknown = Object.keys(answers).filter((field) => !fields.has(field));
  if (unknown.length > 0) throw new GovernanceError("invalid", `unknown questions: ${unknown.join(", ")}`);
  const missing = pack.questions.filter((q) => typeof answers[q.field] !== "boolean").map((q) => q.field);
  if (missing.length > 0) {
    throw new GovernanceError("invalid", `answer every question before submitting: ${missing.join(", ")}`);
  }
}

export function createGovernance(db: Database, options: GovernanceOptions = {}) {
  const now = options.now ?? (() => new Date());
  const inTenant = <T>(actor: Principal, fn: (tx: Connection) => Promise<T>) =>
    db.run((conn) => withTenant(conn, actor.tenantId, fn));

  async function loadAsset(tx: Connection, actor: Principal, assetId: string, lock = false): Promise<Asset> {
    const notFound = new GovernanceError("not_found", `asset ${assetId} not found`);
    if (!UUID.test(assetId)) throw notFound;
    const { rows } = await tx.query<AssetRow>(`SELECT * FROM assets WHERE id = $1${lock ? " FOR UPDATE" : ""}`, [
      assetId,
    ]);
    const asset = rows[0] && toAsset(rows[0]);
    if (!asset || !canSee(actor, asset)) throw notFound;
    return asset;
  }

  async function loadCase(tx: Connection, actor: Principal, caseId: string): Promise<Case> {
    const notFound = new GovernanceError("not_found", `case ${caseId} not found`);
    if (!UUID.test(caseId)) throw notFound;
    const { rows } = await tx.query<CaseRow>("SELECT * FROM cases WHERE id = $1 FOR UPDATE", [caseId]);
    if (!rows[0]) throw notFound;
    const found = toCase(rows[0]);
    await loadAsset(tx, actor, found.assetId).catch(() => {
      throw notFound;
    });
    return found;
  }

  async function loadCases(tx: Connection, assetId: string): Promise<Case[]> {
    const { rows } = await tx.query<CaseRow>("SELECT * FROM cases WHERE asset_id = $1 ORDER BY created_at, id", [
      assetId,
    ]);
    return rows.map(toCase);
  }

  async function loadPack(tx: Connection, c: Pick<Case, "packId" | "packVersion">): Promise<PolicyPack> {
    const { rows } = await tx.query<{ content: PolicyPack }>(
      "SELECT content FROM policy_packs WHERE pack_id = $1 AND version = $2",
      [c.packId, c.packVersion],
    );
    return rows[0]!.content;
  }

  async function writeNote(
    tx: Connection,
    actor: Principal,
    target: { assetId: string; caseId?: string },
    body: string | null,
  ): Promise<{ id: string; body: string } | undefined> {
    if (body === null) return undefined;
    const id = randomUUID();
    await tx.query(
      "INSERT INTO notes (id, tenant_id, asset_id, case_id, author_id, body) VALUES ($1, current_tenant_id(), $2, $3, $4, $5)",
      [id, target.assetId, target.caseId ?? null, actorId(actor), body],
    );
    return { id, body };
  }

  /** Apply one lifecycle step to a case, persist it, and audit it. */
  async function moveCase(
    tx: Connection,
    current: Case,
    action: string,
    actor: Principal,
    context: { reason?: string; policyId?: string; accountableApprover?: string } = {},
    payload: AuditPayload = {},
  ): Promise<Case> {
    const at = now();
    const event = caseLifecycles[current.kind].transition(current.state, action, actor, {
      ...context,
      at,
      caseOwnerId: current.ownerId,
    });
    const decidedAt = isDecided(current.kind, event.after) ? at : null;
    const note = await writeNote(tx, actor, { assetId: current.assetId, caseId: current.id }, event.reason);
    await tx.query("UPDATE cases SET state = $2, decided_at = $3, updated_at = $4 WHERE id = $1", [
      current.id,
      event.after,
      decidedAt?.toISOString() ?? null,
      at.toISOString(),
    ]);
    await appendAudit(tx, {
      assetId: current.assetId,
      caseId: current.id,
      actorKind: actor.kind,
      actorId: actorId(actor),
      action: `case.${action}`,
      before: event.before,
      after: event.after,
      note,
      payload,
      at,
    });
    const moved = { ...current, state: event.after, decidedAt };
    if (moved.kind === "risk_review" && moved.state === "in_review") await assurance.openDomainReviews(tx, moved, at);
    return moved;
  }

  const kernel: Kernel = { now, inTenant, loadAsset, loadCase, loadCases, loadPack, writeNote, moveCase };
  const assurance = createAssurance(kernel);

  /** Deterministic triage, then the fast lane or a full review. No model is involved. */
  async function triageCase(tx: Connection, submitted: Case, pack: InitiativePack, tenant: TenantId): Promise<SubmitResult> {
    const job: SystemPrincipal = { kind: "system", tenantId: tenant, job: "triage" };
    const result = triage(pack.triage, submitted.answers, pack.domains);
    await tx.query("UPDATE cases SET tier = $2, triage = $3 WHERE id = $1", [
      submitted.id,
      result.tier,
      JSON.stringify(result),
    ]);
    let current = await moveCase(tx, { ...submitted, tier: result.tier, triage: result }, "triage", job, {}, {
      packId: pack.id,
      packVersion: pack.version,
      tier: result.tier,
      tierRuleId: result.tierRuleId,
      domains: result.domains,
    });

    const fastLane = fastLaneEligibility(pack.fastLane, {
      tier: result.tier,
      intakeComplete: true,
      answers: submitted.answers,
    });
    current = fastLane.eligible
      ? await moveCase(
          tx,
          current,
          "fast_lane_approve",
          job,
          { policyId: fastLane.policyId, accountableApprover: fastLane.accountableApprover },
          { fastLanePolicyId: fastLane.policyId, accountableApprover: fastLane.accountableApprover },
        )
      : await moveCase(tx, current, "start_review", job);
    return { case: current, fastLane };
  }

  async function buildView(tx: Connection, actor: Principal, asset: Asset): Promise<AssetView> {
    const cases = await loadCases(tx, asset.id);
    const owner = await tx.query<{ display_name: string }>("SELECT display_name FROM users WHERE id = $1", [
      asset.ownerId,
    ]);
    const open = cases.find((c) => c.decidedAt === null) ?? null;
    const isCaseOwner = actor.kind === "human" && open?.ownerId === actor.userId;
    const caseActions = open
      ? caseLifecycles[open.kind]
          .available(open.state, actor, { caseOwnerId: open.ownerId })
          .filter((a) => (SUBMIT_ACTIONS.has(a) ? isCaseOwner : !SERVICE_ACTIONS.has(a)))
      : [];

    const isOwner = actor.kind === "human" && actor.userId === asset.ownerId && can(actor, "case.submit");
    const isOperator = actor.kind === "system" || can(actor, "deployment.operate");
    const reReviews = CASE_TRIGGERS.filter((t) => t !== "initial");
    const newCase: CaseTrigger[] =
      open || asset.state === "retired"
        ? []
        : cases.length === 0
          ? isOwner
            ? ["initial"]
            : []
          : isOwner || isOperator
            ? reReviews
            : [];

    return {
      asset,
      ownerName: owner.rows[0]?.display_name ?? null,
      viewerIsOwner: actor.kind === "human" && actor.userId === asset.ownerId,
      cases,
      openCase: open,
      clearance: await assurance.clearanceFor(tx, cases),
      assurance: await assurance.view(tx, actor, asset, cases),
      actions: { asset: assetLifecycle.available(asset.state, actor), openCase: caseActions, newCase },
    };
  }

  return {
    /** The signed-in person, as the tenant currently knows them; null if they are not in it. */
    principal(tenant: TenantId, user: string): Promise<HumanPrincipal | null> {
      if (!UUID.test(user)) return Promise.resolve(null);
      return db.run((conn) =>
        withTenant(conn, tenant, async (tx) => {
          const { rows } = await tx.query<{ display_name: string; roles: Role[]; review_domains: string[] }>(
            "SELECT display_name, roles, review_domains FROM users WHERE id = $1",
            [user],
          );
          const row = rows[0];
          if (!row) return null;
          return {
            kind: "human",
            tenantId: tenant,
            userId: user as UserId,
            displayName: row.display_name,
            roles: row.roles,
            reviewDomains: row.review_domains,
          };
        }),
      );
    },

    tenant(actor: Principal): Promise<TenantInfo> {
      return inTenant(actor, async (tx) => {
        const { rows } = await tx.query<{ id: string; name: string; slug: string; sandbox_expires_at: Date | null }>(
          "SELECT id, name, slug, sandbox_expires_at FROM tenants",
        );
        const row = rows[0]!;
        return {
          id: row.id,
          name: row.name,
          slug: row.slug,
          sandboxExpiresAt: row.sandbox_expires_at ? new Date(row.sandbox_expires_at) : null,
        };
      });
    },

    /**
     * The policy pack a new case of this kind would use, or the pack a case
     * is pinned to. Intake forms render its questions and preview triage
     * with its exact rules.
     */
    policyPack(actor: Principal, target: { caseKind: CaseKind } | { caseId: string }): Promise<PolicyPack | null> {
      return inTenant(actor, async (tx) => {
        if ("caseId" in target) return loadPack(tx, await loadCase(tx, actor, target.caseId));
        const { rows } = await tx.query<{ content: PolicyPack }>(
          "SELECT content FROM policy_packs WHERE enabled AND content->>'kind' = $1",
          [PACK_KIND[target.caseKind]],
        );
        return rows.length === 1 ? rows[0]!.content : null;
      });
    },

    /** Add a person to the tenant. Incompatible role pairs are refused at the door. */
    addUser(
      actor: Principal,
      input: {
        email: string;
        displayName: string;
        title?: string;
        roles: readonly Role[];
        reviewDomains?: readonly string[];
      },
    ): Promise<string> {
      return inTenant(actor, async (tx) => {
        if (!can(actor, "tenant.manage")) throw new GovernanceError("forbidden", "managing people needs tenant.manage");
        const unknown = input.roles.filter((r) => !ROLES.includes(r));
        if (unknown.length > 0) throw new GovernanceError("invalid", `unknown roles: ${unknown.join(", ")}`);
        const conflicts = roleConflicts(input.roles);
        if (conflicts.length > 0) throw new GovernanceError("invalid", conflicts.join("; "));
        const taken = await tx.query("SELECT 1 FROM users WHERE email = $1", [input.email]);
        if (taken.rows.length > 0) throw new GovernanceError("conflict", "someone in this tenant already has that email");

        const id = randomUUID();
        const at = now();
        await tx.query(
          `INSERT INTO users (id, tenant_id, email, display_name, title, roles, review_domains)
           VALUES ($1, current_tenant_id(), $2, $3, $4, $5, $6)`,
          [id, input.email, input.displayName, input.title ?? null, input.roles, input.reviewDomains ?? []],
        );
        await appendAudit(tx, {
          actorKind: actor.kind,
          actorId: actorId(actor),
          action: "user.add",
          payload: { userId: id, roles: [...input.roles] },
          at,
        });
        return id;
      });
    },

    /** Put something on the inventory. It stays registered, not in use, until a review clears it. */
    registerAsset(actor: Principal, input: { kind: AssetKind; name: string }): Promise<Asset> {
      return inTenant(actor, async (tx) => {
        if (actor.kind !== "human" || !can(actor, "asset.register")) {
          throw new GovernanceError("forbidden", "registering needs asset.register");
        }
        if (!ASSET_KINDS.includes(input.kind)) throw new GovernanceError("invalid", `unknown asset kind: ${input.kind}`);
        const name = input.name.trim();
        if (name.length === 0) throw new GovernanceError("invalid", "give it a name");

        const id = randomUUID();
        const at = now();
        const { rows } = await tx.query<AssetRow>(
          `INSERT INTO assets (id, tenant_id, kind, name, owner_id, created_at, updated_at)
           VALUES ($1, current_tenant_id(), $2, $3, $4, $5, $5) RETURNING *`,
          [id, input.kind, name, actor.userId, at.toISOString()],
        );
        await appendAudit(tx, {
          assetId: id,
          actorKind: actor.kind,
          actorId: actorId(actor),
          action: "asset.register",
          after: "registered",
          payload: { kind: input.kind },
          at,
        });
        return toAsset(rows[0]!);
      });
    },

    /**
     * Open a review case on an asset. The owner opens the first review; an
     * operator may also open a re-review (change, periodic or incident). The
     * case belongs to the asset's owner, who answers its intake.
     */
    openCase(actor: Principal, input: { assetId: string; trigger?: CaseTrigger; packId?: string }): Promise<Case> {
      return inTenant(actor, async (tx) => {
        const asset = await loadAsset(tx, actor, input.assetId, true);
        const trigger = input.trigger ?? "initial";
        if (!CASE_TRIGGERS.includes(trigger)) throw new GovernanceError("invalid", `unknown trigger: ${trigger}`);

        const isOwner = actor.kind === "human" && actor.userId === asset.ownerId && can(actor, "case.submit");
        const isOperator = actor.kind === "system" || can(actor, "deployment.operate");
        if (!isOwner && !(trigger !== "initial" && isOperator)) {
          throw new GovernanceError("forbidden", "only the asset's owner, or an operator for a re-review, can open a case");
        }
        if (asset.state === "retired") throw new GovernanceError("invalid", "a retired asset cannot be reviewed");

        const cases = await loadCases(tx, asset.id);
        const open = cases.find((c) => c.decidedAt === null);
        if (open) throw new GovernanceError("conflict", `case ${open.id} is still open for this asset`);
        if (trigger === "initial" && cases.length > 0) {
          throw new GovernanceError("invalid", "this asset has been reviewed before; open a change, periodic or incident review");
        }
        if (trigger !== "initial" && cases.length === 0) {
          throw new GovernanceError("invalid", "the first review of an asset must be its initial review");
        }

        const kind = caseKindFor(asset.kind);
        const { rows: packs } = await tx.query<{ pack_id: string; version: string; kind: string }>(
          "SELECT pack_id, version, content->>'kind' AS kind FROM policy_packs WHERE enabled ORDER BY pack_id",
        );
        const candidates = packs.filter((p) => p.kind === PACK_KIND[kind]);
        const pack = input.packId ? candidates.find((p) => p.pack_id === input.packId) : candidates[0];
        if (!pack) throw new GovernanceError("invalid", `no enabled ${PACK_KIND[kind]} policy pack${input.packId ? ` '${input.packId}'` : ""}`);
        if (!input.packId && candidates.length > 1) {
          throw new GovernanceError("invalid", `choose a policy pack: ${candidates.map((p) => p.pack_id).join(", ")}`);
        }

        const id = randomUUID();
        const at = now();
        const { rows } = await tx.query<CaseRow>(
          `INSERT INTO cases (id, tenant_id, asset_id, kind, trigger, state, owner_id, pack_id, pack_version, created_at, updated_at)
           VALUES ($1, current_tenant_id(), $2, $3, $4, 'draft', $5, $6, $7, $8, $8) RETURNING *`,
          [id, asset.id, kind, trigger, asset.ownerId, pack.pack_id, pack.version, at.toISOString()],
        );
        await appendAudit(tx, {
          assetId: asset.id,
          caseId: id,
          actorKind: actor.kind,
          actorId: actorId(actor),
          action: "case.open",
          after: "draft",
          payload: { kind, trigger, packId: pack.pack_id, packVersion: pack.version },
          at,
        });
        return toCase(rows[0]!);
      });
    },

    /**
     * The owner submits a case. A risk review needs every intake question
     * answered, then is triaged at once and either fast-laned or sent to
     * review, all in the same transaction.
     */
    submitCase(actor: Principal, caseId: string, answers: Answers = {}): Promise<SubmitResult> {
      return inTenant(actor, async (tx) => {
        const current = await loadCase(tx, actor, caseId);
        if (actor.kind !== "human" || actor.userId !== current.ownerId) {
          throw new GovernanceError("forbidden", "only the case owner can submit it");
        }
        const action = current.state === "changes_requested" ? "resubmit" : "submit";
        const pack = await loadPack(tx, current);

        if (pack.kind !== "initiative") {
          return { case: await moveCase(tx, current, action, actor), fastLane: null };
        }
        validateAnswers(pack, answers);
        await tx.query("UPDATE cases SET answers = $2 WHERE id = $1", [current.id, JSON.stringify(answers)]);
        const submitted = await moveCase(tx, { ...current, answers }, action, actor);
        return triageCase(tx, submitted, pack, actor.tenantId);
      });
    },

    /**
     * A person acts on a case: start a review, approve, reject, request
     * changes. Approving a risk review waits until its domain reviews are
     * ready; a conditional approval carries at least one condition.
     */
    actOnCase(
      actor: Principal,
      caseId: string,
      action: string,
      reason?: string,
      extras: { conditions?: readonly NewCondition[] } = {},
    ): Promise<Case> {
      return inTenant(actor, async (tx) => {
        if (SERVICE_ACTIONS.has(action)) throw new GovernanceError("invalid", `'${action}' is not a manual action`);
        const current = await loadCase(tx, actor, caseId);
        // Authority, state and reason come first, so readiness is never revealed to someone who cannot decide.
        caseLifecycles[current.kind].transition(current.state, action, actor, {
          at: now(),
          caseOwnerId: current.ownerId,
          ...(reason === undefined ? {} : { reason }),
        });
        const approving = action === "approve" || action === "conditionally_approve";
        let conditions: NewCondition[] = [];
        if (current.kind === "risk_review" && approving) {
          const readiness = await assurance.readinessFor(tx, current);
          const ready = action === "approve" ? readiness.canApprove : readiness.canConditionallyApprove;
          if (!ready) {
            const blockers = action === "approve" ? readiness.approvalBlockers : readiness.conditionalBlockers;
            throw new GovernanceError("conflict", `${readiness.reason} Waiting on: ${blockers.join(", ")}`);
          }
          if (action === "conditionally_approve") conditions = assurance.validateConditions(extras.conditions ?? []);
        }
        const moved = await moveCase(tx, current, action, actor, reason === undefined ? {} : { reason });
        if (conditions.length > 0) await assurance.addConditions(tx, actor, moved, conditions, now());
        return moved;
      });
    },

    reviewDomain: assurance.reviewDomain,
    addEvidence: assurance.addEvidence,
    withdrawEvidence: assurance.withdrawEvidence,
    requestException: assurance.requestException,
    actOnException: assurance.actOnException,
    actOnCondition: assurance.actOnCondition,

    /** Activate, pause, resume or retire an asset. Activating and resuming need clearance. */
    actOnAsset(actor: Principal, assetId: string, action: AssetAction, reason?: string): Promise<Asset> {
      return inTenant(actor, async (tx) => {
        const asset = await loadAsset(tx, actor, assetId, true);
        const cleared = await assurance.clearanceFor(tx, await loadCases(tx, asset.id));
        const rule = assetLifecycle.table[asset.state]?.[action];
        if (rule?.requiresClearance && !cleared.cleared) {
          throw new IllegalTransitionError(`'${action}' needs an approved review: ${cleared.reason}`);
        }

        const at = now();
        const event = assetLifecycle.transition(asset.state, action, actor, {
          at,
          ...(reason === undefined ? {} : { reason }),
          ...(cleared.cleared ? { clearingCaseId: cleared.caseId } : {}),
        });
        const note = await writeNote(tx, actor, { assetId: asset.id }, event.reason);
        await tx.query("UPDATE assets SET state = $2, updated_at = $3 WHERE id = $1", [
          asset.id,
          event.after,
          at.toISOString(),
        ]);
        await appendAudit(tx, {
          assetId: asset.id,
          actorKind: actor.kind,
          actorId: actorId(actor),
          action: `asset.${action}`,
          before: event.before,
          after: event.after,
          note,
          payload: rule?.requiresClearance && cleared.cleared ? { clearingCaseId: cleared.caseId } : {},
          at,
        });
        return { ...asset, state: event.after };
      });
    },

    listAssets(actor: Principal): Promise<Asset[]> {
      return inTenant(actor, async (tx) => {
        const { rows } = await tx.query<AssetRow>("SELECT * FROM assets ORDER BY created_at, id");
        return rows.map(toAsset).filter((asset) => canSee(actor, asset));
      });
    },

    /** Every asset this viewer can see, each with its cases, clearance and next actions. */
    listAssetViews(actor: Principal): Promise<AssetView[]> {
      return inTenant(actor, async (tx) => {
        const { rows } = await tx.query<AssetRow>("SELECT * FROM assets ORDER BY created_at, id");
        const visible = rows.map(toAsset).filter((asset) => canSee(actor, asset));
        const views: AssetView[] = [];
        for (const asset of visible) views.push(await buildView(tx, actor, asset));
        return views;
      });
    },

    /** One asset with its cases, whether it may be in use, and what this viewer can do next. */
    getAsset(actor: Principal, assetId: string): Promise<AssetView> {
      return inTenant(actor, async (tx) => buildView(tx, actor, await loadAsset(tx, actor, assetId)));
    },

    /**
     * Everything that happened to an asset and its cases, oldest first, with
     * who acted, why, and under which policy version. Reasons are checked
     * against the hash the audit log kept.
     */
    assetHistory(actor: Principal, assetId: string): Promise<HistoryEntry[]> {
      return inTenant(actor, async (tx) => {
        await loadAsset(tx, actor, assetId);
        const { rows } = await tx.query<{
          at: Date;
          action: string;
          before_state: string | null;
          after_state: string | null;
          case_id: string | null;
          actor_kind: Principal["kind"];
          actor_id: string;
          note_id: string | null;
          note_sha256: string | null;
          payload: AuditPayload;
          display_name: string | null;
          body: string | null;
          case_kind: CaseKind | null;
          pack_id: string | null;
          pack_version: string | null;
        }>(
          `SELECT e.at, e.action, e.before_state, e.after_state, e.case_id, e.actor_kind, e.actor_id,
                  e.note_id, e.note_sha256, e.payload, u.display_name, n.body,
                  c.kind AS case_kind, c.pack_id, c.pack_version
           FROM audit_events e
           LEFT JOIN users u ON e.actor_kind = 'human' AND u.id::text = e.actor_id
           LEFT JOIN notes n ON n.id = e.note_id
           LEFT JOIN cases c ON c.id = e.case_id
           WHERE e.asset_id = $1
           ORDER BY e.id`,
          [assetId],
        );
        return rows.map((r) => ({
          at: new Date(r.at),
          action: r.action,
          before: r.before_state,
          after: r.after_state,
          caseId: r.case_id,
          actor: { kind: r.actor_kind, id: r.actor_id, name: r.display_name },
          decision: r.case_kind !== null && r.after_state !== null && isDecided(r.case_kind, r.after_state),
          reason: r.body,
          reasonStatus:
            r.note_id === null ? "none" : r.body === null ? "erased" : sha256Hex(r.body) === r.note_sha256 ? "intact" : "altered",
          policy: r.pack_id && r.pack_version ? { packId: r.pack_id, packVersion: r.pack_version } : null,
          payload: r.payload,
        }));
      });
    },
  };
}

export type Governance = ReturnType<typeof createGovernance>;
