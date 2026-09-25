import { randomUUID } from "node:crypto";
import { appendAudit, sha256Hex, type Connection } from "@aegis/db";
import {
  CONDITION_DUES,
  DEFAULT_EXCEPTION_DAYS,
  MAX_EXCEPTION_DAYS,
  can,
  canSignDomain,
  clearance as decisionClearance,
  draftUse,
  conditionLifecycle,
  conditionSettled,
  decisionReadiness,
  domainReviewLifecycle,
  exceptionActive,
  exceptionLifecycle,
  requiredControls,
  uncoveredGates,
  useBlockers,
  type Clearance,
  type ConditionAction,
  type ConditionDue,
  type ConditionState,
  type ControlDefinition,
  type DecisionReadiness,
  type DomainReviewAction,
  type DomainReviewStatus,
  type ExceptionAction,
  type ExceptionState,
  type Principal,
  type ReviewDraft,
  type SystemPrincipal,
  type TenantId,
} from "@aegis/domain";
import type { InitiativePack, PolicyPack } from "@aegis/frameworks";
import type { Agents } from "./agents";
import { GovernanceError } from "./errors";
import { UUID, actorId, type Asset, type Case, type Kernel } from "./model";

/**
 * Assurance: what a review needs beyond the decision itself. Domain
 * reviewers sign off, evidence covers controls, exceptions cover controls
 * that cannot be met yet, and conditions keep a conditional approval honest.
 * Clearance for use takes all of it into account.
 */

export interface Person {
  readonly id: string;
  readonly name: string | null;
}

export interface DomainReviewView {
  readonly id: string;
  readonly caseId: string;
  readonly domain: string;
  readonly label: string;
  readonly status: DomainReviewStatus;
  /** Send back with every change, so a stale screen cannot overwrite a newer one. */
  readonly revision: number;
  readonly reviewer: Person | null;
  /** The latest question, answer, abstention reason or signing memo. */
  readonly note: string | null;
  readonly proposedConditions: readonly string[];
  /** Gate controls in this domain without evidence or an exception; signing waits on these. */
  readonly uncoveredGates: readonly string[];
  /** What this viewer may do on this review. */
  readonly actions: readonly DomainReviewAction[];
  /** The review drafter's work on this review. */
  readonly draft: {
    readonly status: "none" | "queued" | "ready" | "failed";
    /** Why the last draft failed, as a failure code. */
    readonly error: string | null;
    /** The latest draft, unless it has been erased. */
    readonly content: ReviewDraft | null;
  };
  /** Whether this viewer may ask the drafter for a fresh draft. */
  readonly canRequestDraft: boolean;
}

export interface EvidenceView {
  readonly id: string;
  readonly kind: "link" | "attestation";
  readonly title: string;
  readonly url: string | null;
  readonly detail: string | null;
  readonly addedBy: Person;
  readonly addedAt: Date;
  readonly canWithdraw: boolean;
}

export interface ExceptionView {
  readonly id: string;
  /** Effective state: an approved exception past its expiry reads as expired. */
  readonly state: ExceptionState;
  readonly requestedBy: Person;
  readonly decidedBy: Person | null;
  readonly reason: string | null;
  readonly days: number;
  readonly expiresAt: Date | null;
  readonly actions: readonly ExceptionAction[];
}

export interface ControlView extends Omit<ControlDefinition, "when" | "minTier"> {
  readonly domainLabel: string;
  readonly evidence: readonly EvidenceView[];
  readonly exception: ExceptionView | null;
  readonly covered: boolean;
}

export interface ConditionView {
  readonly id: string;
  readonly caseId: string;
  readonly text: string | null;
  readonly due: ConditionDue;
  readonly state: ConditionState;
  readonly evidence: readonly EvidenceView[];
  readonly actions: readonly ConditionAction[];
}

export interface Assurance {
  /** Domain reviews for the case under way, or the latest one. */
  readonly reviews: readonly DomainReviewView[];
  /** Whether an approver can decide yet; null unless a case is in review. */
  readonly readiness: DecisionReadiness | null;
  /** Controls the latest triaged case requires. */
  readonly controls: readonly ControlView[];
  readonly conditions: readonly ConditionView[];
  /** Whether this viewer may add evidence. */
  readonly canContribute: boolean;
  /** Whether this viewer may request control exceptions. */
  readonly canRequestExceptions: boolean;
  /** Whether the review drafter is on for this tenant. */
  readonly drafterOn: boolean;
}

export interface NewCondition {
  readonly text: string;
  readonly due: ConditionDue;
}

interface ReviewRow {
  id: string;
  case_id: string;
  domain: string;
  status: DomainReviewStatus;
  revision: number;
  reviewer_id: string | null;
  reviewer_name: string | null;
  note_id: string | null;
  note_body: string | null;
  proposed_conditions: string[];
  draft_status: DomainReviewView["draft"]["status"];
  draft_error: string | null;
  draft_body: string | null;
}

interface EvidenceRow {
  id: string;
  control_id: string | null;
  condition_id: string | null;
  kind: "link" | "attestation";
  title: string;
  url: string | null;
  detail: string | null;
  added_by: string;
  added_by_name: string | null;
  added_at: Date;
}

interface ExceptionRow {
  id: string;
  asset_id: string;
  control_id: string;
  state: ExceptionState;
  requested_by: string;
  requested_by_name: string | null;
  decided_by: string | null;
  decided_by_name: string | null;
  note_body: string | null;
  days: number;
  expires_at: Date | null;
}

interface ConditionRow {
  id: string;
  asset_id: string;
  case_id: string;
  due: ConditionDue;
  state: ConditionState;
  note_body: string | null;
}

const trimmed = (value: string | undefined | null) => (value ?? "").trim();
const initiative = (pack: PolicyPack): InitiativePack | null => (pack.kind === "initiative" ? pack : null);
const effectiveExceptionState = (row: ExceptionRow, now: Date): ExceptionState =>
  row.state === "approved" && !exceptionActive(row.state, row.expires_at ? new Date(row.expires_at) : null, now)
    ? "expired"
    : row.state;

/** The draft stored in a note, or null if it was erased or does not read as a draft. */
const parseDraft = (body: string | null): ReviewDraft | null => {
  if (!body) return null;
  try {
    const d = JSON.parse(body) as Partial<ReviewDraft>;
    const ok =
      typeof d.summary === "string" &&
      Array.isArray(d.findings) &&
      Array.isArray(d.questionsForOwner) &&
      Array.isArray(d.proposedConditions);
    return ok ? (d as ReviewDraft) : null;
  } catch {
    return null;
  }
};

export function createAssurance(k: Kernel, drafts: Pick<Agents, "queueDraft" | "cancelDraft" | "gateFor">) {
  const system = (actor: Principal, job: string): SystemPrincipal => ({ kind: "system", tenantId: actor.tenantId, job });
  const isOwner = (actor: Principal, asset: Asset) => actor.kind === "human" && actor.userId === asset.ownerId;
  const canContribute = (actor: Principal, asset: Asset) =>
    (isOwner(actor, asset) && can(actor, "case.submit")) || can(actor, "review.sign") || can(actor, "deployment.operate");

  /* -------------------------------------------------------------- reads */

  async function reviewRows(tx: Connection, caseId: string): Promise<ReviewRow[]> {
    const { rows } = await tx.query<ReviewRow>(
      `SELECT r.id, r.case_id, r.domain, r.status, r.revision, r.reviewer_id, u.display_name AS reviewer_name,
              r.note_id, n.body AS note_body, r.proposed_conditions, r.draft_status, r.draft_error, d.body AS draft_body
       FROM domain_reviews r
       LEFT JOIN users u ON u.id = r.reviewer_id
       LEFT JOIN notes n ON n.id = r.note_id
       LEFT JOIN notes d ON d.id = r.draft_note_id
       WHERE r.case_id = $1
       ORDER BY r.domain`,
      [caseId],
    );
    return rows;
  }

  async function evidenceRows(tx: Connection, assetId: string): Promise<EvidenceRow[]> {
    const { rows } = await tx.query<EvidenceRow>(
      `SELECT e.id, e.control_id, e.condition_id, e.kind, e.title, e.url, e.detail, e.added_by,
              u.display_name AS added_by_name, e.added_at
       FROM evidence e LEFT JOIN users u ON u.id = e.added_by
       WHERE e.asset_id = $1
       ORDER BY e.added_at, e.id`,
      [assetId],
    );
    return rows;
  }

  /** The latest exception per control on an asset. */
  async function exceptionRows(tx: Connection, assetId: string): Promise<Map<string, ExceptionRow>> {
    const { rows } = await tx.query<ExceptionRow>(
      `SELECT x.id, x.asset_id, x.control_id, x.state, x.requested_by, r.display_name AS requested_by_name,
              x.decided_by, d.display_name AS decided_by_name, n.body AS note_body, x.days, x.expires_at
       FROM control_exceptions x
       LEFT JOIN users r ON r.id = x.requested_by
       LEFT JOIN users d ON d.id = x.decided_by
       LEFT JOIN notes n ON n.id = x.note_id
       WHERE x.asset_id = $1
       ORDER BY x.created_at, x.id`,
      [assetId],
    );
    return new Map(rows.map((row) => [row.control_id, row]));
  }

  /** The case whose triage defines the asset's current obligations. */
  const focusCase = (cases: readonly Case[]) => cases.filter((c) => c.triage !== null).at(-1) ?? null;

  async function controlsFor(tx: Connection, c: Case | null): Promise<{ pack: InitiativePack | null; controls: ControlDefinition[] }> {
    if (!c?.triage) return { pack: null, controls: [] };
    const pack = initiative(await k.loadPack(tx, c));
    if (!pack) return { pack: null, controls: [] };
    return { pack, controls: requiredControls(pack.controls ?? [], c.triage, c.answers) };
  }

  function coverage(evidence: readonly EvidenceRow[], exceptions: Map<string, ExceptionRow>, now: Date) {
    return (controlId: string) => {
      const exception = exceptions.get(controlId);
      return {
        evidence: evidence.filter((e) => e.control_id === controlId).length,
        activeException: Boolean(exception && effectiveExceptionState(exception, now) === "approved"),
      };
    };
  }

  async function readinessFor(tx: Connection, c: Case): Promise<DecisionReadiness> {
    const rows = await reviewRows(tx, c.id);
    return decisionReadiness({
      caseState: c.state,
      requiredDomains: c.triage?.domains ?? null,
      reviews: rows.map((r) => ({
        domain: r.domain,
        status: r.status,
        abstentionRecorded: r.status === "abstained" && r.note_id !== null,
      })),
    });
  }

  /** Whether the asset may be in use: an approving decision, met before-use conditions, and covered gate controls. */
  async function clearanceFor(tx: Connection, cases: readonly Case[]): Promise<Clearance> {
    const decided = decisionClearance(cases);
    if (!decided.cleared) return decided;
    const clearing = cases.find((c) => c.id === decided.caseId)!;
    const { controls } = await controlsFor(tx, clearing);
    const [evidence, exceptions, pending] = await Promise.all([
      evidenceRows(tx, clearing.assetId),
      exceptionRows(tx, clearing.assetId),
      tx.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM conditions WHERE case_id = $1 AND due = 'before_use' AND state NOT IN ('met', 'waived')",
        [clearing.id],
      ),
    ]);
    const blockers = useBlockers({
      pendingConditions: pending.rows[0]!.n,
      uncoveredGates: uncoveredGates(controls, coverage(evidence, exceptions, k.now())),
    });
    return blockers.length > 0 ? { cleared: false, reason: blockers.join("; "), caseId: clearing.id } : decided;
  }

  async function view(tx: Connection, actor: Principal, asset: Asset, cases: readonly Case[]): Promise<Assurance> {
    const now = k.now();
    const focus = focusCase(cases);
    const { pack, controls } = await controlsFor(tx, focus);
    const [evidence, exceptions, reviews, conditionResult] = await Promise.all([
      evidenceRows(tx, asset.id),
      exceptionRows(tx, asset.id),
      focus ? reviewRows(tx, focus.id) : Promise.resolve([]),
      tx.query<ConditionRow>(
        `SELECT c.id, c.asset_id, c.case_id, c.due, c.state, n.body AS note_body
         FROM conditions c LEFT JOIN notes n ON n.id = c.note_id
         WHERE c.asset_id = $1 ORDER BY c.created_at, c.due, c.id`,
        [asset.id],
      ),
    ]);
    const covered = coverage(evidence, exceptions, now);
    const label = (domain: string) => pack?.domains[domain] ?? domain;
    const toEvidence = (e: EvidenceRow): EvidenceView => ({
      id: e.id,
      kind: e.kind,
      title: e.title,
      url: e.url,
      detail: e.detail,
      addedBy: { id: e.added_by, name: e.added_by_name },
      addedAt: new Date(e.added_at),
      canWithdraw: actor.kind === "human" && actor.userId === e.added_by,
    });
    const caseOwner = new Map(cases.map((c) => [c.id, c.ownerId]));
    const inReview = focus?.state === "in_review";
    const drafterOn = (await drafts.gateFor(tx, "review-drafter")).on;

    return {
      reviews: reviews.map((r) => {
        const isCaseOwner = actor.kind === "human" && actor.userId === focus?.ownerId;
        const actions = !inReview
          ? []
          : domainReviewLifecycle
              .available(r.status, actor)
              .filter((a) => (a === "respond" ? isCaseOwner : canSignDomain(actor, r.domain) && !isCaseOwner));
        return {
          id: r.id,
          caseId: r.case_id,
          domain: r.domain,
          label: label(r.domain),
          status: r.status,
          revision: r.revision,
          reviewer: r.reviewer_id ? { id: r.reviewer_id, name: r.reviewer_name } : null,
          note: r.note_body,
          proposedConditions: r.proposed_conditions,
          uncoveredGates: uncoveredGates(
            controls.filter((c) => c.domain === r.domain),
            covered,
          ).map((c) => c.id),
          actions,
          draft: { status: r.draft_status, error: r.draft_error, content: parseDraft(r.draft_body) },
          canRequestDraft:
            drafterOn &&
            inReview &&
            (r.status === "pending" || r.status === "drafted") &&
            r.draft_status !== "queued" &&
            canSignDomain(actor, r.domain) &&
            !isCaseOwner,
        };
      }),
      readiness: focus && inReview ? await readinessFor(tx, focus) : null,
      controls: controls.map(({ when: _when, minTier: _minTier, ...control }) => {
        const exception = exceptions.get(control.id);
        const state = exception ? effectiveExceptionState(exception, now) : null;
        return {
          ...control,
          domainLabel: label(control.domain),
          evidence: evidence.filter((e) => e.control_id === control.id).map(toEvidence),
          exception:
            exception && state
              ? {
                  id: exception.id,
                  state,
                  requestedBy: { id: exception.requested_by, name: exception.requested_by_name },
                  decidedBy: exception.decided_by ? { id: exception.decided_by, name: exception.decided_by_name } : null,
                  reason: exception.note_body,
                  days: exception.days,
                  expiresAt: exception.expires_at ? new Date(exception.expires_at) : null,
                  actions: exceptionLifecycle
                    .available(state, actor, { caseOwnerId: exception.requested_by })
                    .filter((a) => a !== "expire"),
                }
              : null,
          covered: covered(control.id).evidence > 0 || covered(control.id).activeException,
        };
      }),
      conditions: conditionResult.rows.map((c) => ({
        id: c.id,
        caseId: c.case_id,
        text: c.note_body,
        due: c.due,
        state: c.state,
        evidence: evidence.filter((e) => e.condition_id === c.id).map(toEvidence),
        actions: conditionLifecycle
          .available(c.state, actor, { caseOwnerId: caseOwner.get(c.case_id) })
          .filter((a) => a !== "submit" || isOwner(actor, asset) || can(actor, "deployment.operate")),
      })),
      canContribute: canContribute(actor, asset),
      canRequestExceptions: canContribute(actor, asset) || can(actor, "case.decide"),
      drafterOn,
    };
  }

  /** Domains whose review is an agent draft nobody has signed. */
  async function unsignedDrafts(tx: Connection, caseId: string): Promise<string[]> {
    const { rows } = await tx.query<{ domain: string }>(
      "SELECT domain FROM domain_reviews WHERE case_id = $1 AND status = 'drafted' ORDER BY domain",
      [caseId],
    );
    return rows.map((r) => r.domain);
  }

  /* ------------------------------------------------------ transaction steps */

  /** Open one pending review per required domain when a case enters review, and queue drafts if the drafter is on. */
  async function openDomainReviews(tx: Connection, c: Case, at: Date, tenant: TenantId): Promise<void> {
    for (const domain of c.triage?.domains ?? []) {
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO domain_reviews (id, tenant_id, case_id, domain, updated_at)
         VALUES ($1, current_tenant_id(), $2, $3, $4) ON CONFLICT (tenant_id, case_id, domain) DO NOTHING RETURNING id`,
        [randomUUID(), c.id, domain, at.toISOString()],
      );
      if (rows[0]) await drafts.queueDraft(tx, tenant, rows[0].id);
    }
  }

  function validateConditions(conditions: readonly NewCondition[]): NewCondition[] {
    const clean = conditions
      .map((c) => ({ text: trimmed(c.text), due: c.due }))
      .filter((c) => c.text.length > 0);
    if (clean.length === 0) throw new GovernanceError("invalid", "a conditional approval needs at least one condition");
    const bad = clean.find((c) => !CONDITION_DUES.includes(c.due));
    if (bad) throw new GovernanceError("invalid", `unknown condition due: ${bad.due}`);
    return clean;
  }

  async function addConditions(tx: Connection, actor: Principal, c: Case, conditions: readonly NewCondition[], at: Date) {
    for (const condition of conditions) {
      const id = randomUUID();
      const note = (await k.writeNote(tx, actor, { assetId: c.assetId, caseId: c.id }, condition.text))!;
      await tx.query(
        `INSERT INTO conditions (id, tenant_id, asset_id, case_id, note_id, due, created_at, updated_at)
         VALUES ($1, current_tenant_id(), $2, $3, $4, $5, $6, $6)`,
        [id, c.assetId, c.id, note.id, condition.due, at.toISOString()],
      );
      await appendAudit(tx, {
        assetId: c.assetId,
        caseId: c.id,
        actorKind: actor.kind,
        actorId: actorId(actor),
        action: "condition.add",
        after: "open",
        note,
        payload: { conditionId: id, due: condition.due },
        at,
      });
    }
  }

  /**
   * Evidence or an exception changed for a control, so a draft of that
   * control's domain review is out of date: draft it again, if the drafter
   * is on and the review still waits for a signature.
   */
  async function redraftFor(tx: Connection, tenant: TenantId, assetId: string, controlId: string): Promise<void> {
    const focus = focusCase(await k.loadCases(tx, assetId));
    if (!focus || focus.state !== "in_review") return;
    const { controls } = await controlsFor(tx, focus);
    const control = controls.find((c) => c.id === controlId);
    if (!control) return;
    const { rows } = await tx.query<{ id: string }>(
      "SELECT id FROM domain_reviews WHERE case_id = $1 AND domain = $2 AND status IN ('pending', 'drafted')",
      [focus.id, control.domain],
    );
    if (rows[0]) await drafts.queueDraft(tx, tenant, rows[0].id);
  }

  /** Mark approved exceptions past their expiry as expired, as the system. */
  async function expireDue(tx: Connection, actor: Principal, assetId: string, at: Date): Promise<void> {
    const { rows } = await tx.query<{ id: string; control_id: string }>(
      `UPDATE control_exceptions SET state = 'expired', updated_at = $2
       WHERE asset_id = $1 AND state = 'approved' AND expires_at <= $2 RETURNING id, control_id`,
      [assetId, at.toISOString()],
    );
    for (const row of rows) {
      await appendAudit(tx, {
        assetId,
        actorKind: "system",
        actorId: actorId(system(actor, "exception-expiry")),
        action: "exception.expire",
        before: "approved",
        after: "expired",
        payload: { exceptionId: row.id, controlId: row.control_id },
        at,
      });
    }
  }

  /* ---------------------------------------------------------------- writes */

  return {
    view,
    clearanceFor,
    readinessFor,
    unsignedDrafts,
    openDomainReviews,
    validateConditions,
    addConditions,

    /**
     * A domain reviewer signs, returns with a question, abstains or resumes;
     * the requester answers a returned review. Signing needs every gate
     * control in the domain evidenced or excepted.
     */
    reviewDomain(
      actor: Principal,
      caseId: string,
      domain: string,
      action: DomainReviewAction,
      input: { expectedRevision: number; note?: string; proposedConditions?: readonly string[] },
    ): Promise<{ status: DomainReviewStatus; revision: number }> {
      return k.inTenant(actor, async (tx) => {
        const c = await k.loadCase(tx, actor, caseId);
        const { rows } = await tx.query<ReviewRow>(
          `SELECT r.*, NULL AS reviewer_name, NULL AS note_body, d.body AS draft_body
           FROM domain_reviews r LEFT JOIN notes d ON d.id = r.draft_note_id
           WHERE r.case_id = $1 AND r.domain = $2 FOR UPDATE OF r`,
          [c.id, domain],
        );
        const row = rows[0];
        if (!row) throw new GovernanceError("not_found", `no ${domain} review on this case`);
        if (c.state !== "in_review") throw new GovernanceError("conflict", "this case is no longer in review");
        if (row.revision !== input.expectedRevision) {
          throw new GovernanceError("conflict", "this review changed since you opened it; refresh and try again");
        }
        const isCaseOwner = actor.kind === "human" && actor.userId === c.ownerId;
        if (action === "respond") {
          if (!isCaseOwner) throw new GovernanceError("forbidden", "only the case owner can answer a returned review");
        } else {
          if (actor.kind === "human" && !canSignDomain(actor, domain)) {
            throw new GovernanceError("forbidden", `only a ${domain} reviewer can act on this review`);
          }
          if (isCaseOwner) throw new GovernanceError("forbidden", "nobody reviews a case they submitted");
        }

        const at = k.now();
        if (action === "sign") {
          const { controls } = await controlsFor(tx, c);
          const missing = uncoveredGates(
            controls.filter((control) => control.domain === domain),
            coverage(await evidenceRows(tx, c.assetId), await exceptionRows(tx, c.assetId), at),
          );
          if (missing.length > 0) {
            throw new GovernanceError(
              "invalid",
              `attach evidence or approve an exception first: ${missing.map((m) => `${m.id} ${m.name}`).join(", ")}`,
            );
          }
        }
        const note = trimmed(input.note);
        const event = domainReviewLifecycle.transition(row.status, action, actor, {
          at,
          ...(note ? { reason: note } : {}),
        });
        const proposals =
          action === "sign" ? (input.proposedConditions ?? []).map(trimmed).filter((p) => p.length > 0).slice(0, 10) : row.proposed_conditions;
        const written = await k.writeNote(tx, actor, { assetId: c.assetId, caseId: c.id }, event.reason);
        const revision = row.revision + 1;
        // Signing a draft records whether the reviewer kept its memo, changed it, or wrote none.
        const fromDraft = action === "sign" && row.status === "drafted" ? draftUse(parseDraft(row.draft_body), note) : null;
        await tx.query(
          `UPDATE domain_reviews
           SET status = $2, revision = $3, reviewer_id = $4, note_id = $5, proposed_conditions = $6, updated_at = $7
           WHERE id = $1`,
          [
            row.id,
            event.after,
            revision,
            action === "respond" ? row.reviewer_id : actorId(actor),
            written?.id ?? (action === "resume" ? null : row.note_id),
            proposals,
            at.toISOString(),
          ],
        );
        await appendAudit(tx, {
          assetId: c.assetId,
          caseId: c.id,
          actorKind: actor.kind,
          actorId: actorId(actor),
          action: `review.${action}`,
          before: event.before,
          after: event.after,
          note: written,
          payload: { domain, revision, proposedConditions: proposals.length, ...(fromDraft ? { fromDraft } : {}) },
          at,
        });
        // A person acted: a draft in flight no longer applies. A review back at pending gets a fresh one.
        if (event.after === "pending") await drafts.queueDraft(tx, actor.tenantId, row.id);
        else await drafts.cancelDraft(tx, row.id);
        return { status: event.after, revision };
      });
    },

    /** Attach a link or a written attestation to a control or a condition. */
    addEvidence(
      actor: Principal,
      input: {
        assetId: string;
        controlId?: string;
        conditionId?: string;
        kind: "link" | "attestation";
        title: string;
        url?: string;
        detail?: string;
      },
    ): Promise<string> {
      return k.inTenant(actor, async (tx) => {
        const asset = await k.loadAsset(tx, actor, input.assetId, true);
        if (actor.kind !== "human" || !canContribute(actor, asset)) {
          throw new GovernanceError("forbidden", "only the owner, a reviewer or an operator can add evidence");
        }
        if (Boolean(input.controlId) === Boolean(input.conditionId)) {
          throw new GovernanceError("invalid", "evidence belongs to exactly one control or condition");
        }
        const title = trimmed(input.title);
        const url = trimmed(input.url) || null;
        const detail = trimmed(input.detail) || null;
        if (!title) throw new GovernanceError("invalid", "give the evidence a title");
        if (input.kind === "link" && !url?.startsWith("https://")) {
          throw new GovernanceError("invalid", "a link must start with https://");
        }
        if (input.kind === "attestation" && !detail) throw new GovernanceError("invalid", "write the attestation");
        if (input.kind !== "link" && input.kind !== "attestation") throw new GovernanceError("invalid", "unknown kind");

        if (input.controlId) {
          const { controls } = await controlsFor(tx, focusCase(await k.loadCases(tx, asset.id)));
          if (!controls.some((c) => c.id === input.controlId)) {
            throw new GovernanceError("invalid", `${input.controlId} is not required for this asset`);
          }
        } else {
          const found = await tx.query("SELECT 1 FROM conditions WHERE id = $1 AND asset_id = $2", [
            UUID.test(input.conditionId!) ? input.conditionId : null,
            asset.id,
          ]);
          if (found.rows.length === 0) throw new GovernanceError("not_found", "condition not found");
        }

        const id = randomUUID();
        const at = k.now();
        await tx.query(
          `INSERT INTO evidence (id, tenant_id, asset_id, control_id, condition_id, kind, title, url, detail, added_by, added_at)
           VALUES ($1, current_tenant_id(), $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [id, asset.id, input.controlId ?? null, input.conditionId ?? null, input.kind, title, input.kind === "link" ? url : null, detail, actor.userId, at.toISOString()],
        );
        await appendAudit(tx, {
          assetId: asset.id,
          actorKind: actor.kind,
          actorId: actorId(actor),
          action: "evidence.add",
          payload: {
            evidenceId: id,
            ...(input.controlId ? { controlId: input.controlId } : { conditionId: input.conditionId! }),
            kind: input.kind,
            contentSha256: sha256Hex(JSON.stringify([title, url, detail])),
          },
          at,
        });
        if (input.controlId) await redraftFor(tx, actor.tenantId, asset.id, input.controlId);
        return id;
      });
    },

    /** Whoever added evidence may withdraw it. */
    withdrawEvidence(actor: Principal, assetId: string, evidenceId: string): Promise<void> {
      return k.inTenant(actor, async (tx) => {
        const asset = await k.loadAsset(tx, actor, assetId, true);
        const { rows } = await tx.query<{ added_by: string; control_id: string | null }>(
          "DELETE FROM evidence WHERE id = $1 AND asset_id = $2 AND added_by = $3 RETURNING added_by, control_id",
          [UUID.test(evidenceId) ? evidenceId : null, asset.id, actor.kind === "human" ? actor.userId : null],
        );
        if (rows.length === 0) throw new GovernanceError("not_found", "evidence not found, or not yours to withdraw");
        await appendAudit(tx, {
          assetId: asset.id,
          actorKind: actor.kind,
          actorId: actorId(actor),
          action: "evidence.withdraw",
          payload: { evidenceId },
          at: k.now(),
        });
        if (rows[0]!.control_id) await redraftFor(tx, actor.tenantId, asset.id, rows[0]!.control_id);
      });
    },

    /** Ask for a time-boxed exception for a gate control that cannot be met yet. */
    requestException(
      actor: Principal,
      input: { assetId: string; controlId: string; reason: string; days?: number },
    ): Promise<string> {
      return k.inTenant(actor, async (tx) => {
        const asset = await k.loadAsset(tx, actor, input.assetId, true);
        // Anyone with a stake may ask (Jeeves); nobody decides their own request.
        if (actor.kind !== "human" || !(canContribute(actor, asset) || can(actor, "case.decide"))) {
          throw new GovernanceError("forbidden", "only the owner, a reviewer, an approver or an operator can request an exception");
        }
        const { controls } = await controlsFor(tx, focusCase(await k.loadCases(tx, asset.id)));
        const control = controls.find((c) => c.id === input.controlId);
        if (!control || control.enforcement !== "gate") {
          throw new GovernanceError("invalid", `${input.controlId} is not a gate control required for this asset`);
        }
        const days = input.days ?? DEFAULT_EXCEPTION_DAYS;
        if (!Number.isInteger(days) || days < 1 || days > MAX_EXCEPTION_DAYS) {
          throw new GovernanceError("invalid", `an exception lasts 1 to ${MAX_EXCEPTION_DAYS} days`);
        }
        const reason = trimmed(input.reason);
        if (!reason) throw new GovernanceError("invalid", "explain why the control cannot be met yet");

        const at = k.now();
        await expireDue(tx, actor, asset.id, at);
        const live = await tx.query(
          "SELECT 1 FROM control_exceptions WHERE asset_id = $1 AND control_id = $2 AND state IN ('requested', 'approved')",
          [asset.id, control.id],
        );
        if (live.rows.length > 0) throw new GovernanceError("conflict", `${control.id} already has a live exception`);

        const id = randomUUID();
        const note = (await k.writeNote(tx, actor, { assetId: asset.id }, reason))!;
        await tx.query(
          `INSERT INTO control_exceptions (id, tenant_id, asset_id, control_id, requested_by, note_id, days, created_at, updated_at)
           VALUES ($1, current_tenant_id(), $2, $3, $4, $5, $6, $7, $7)`,
          [id, asset.id, control.id, actor.userId, note.id, days, at.toISOString()],
        );
        await appendAudit(tx, {
          assetId: asset.id,
          actorKind: actor.kind,
          actorId: actorId(actor),
          action: "exception.request",
          after: "requested",
          note,
          payload: { exceptionId: id, controlId: control.id, days },
          at,
        });
        return id;
      });
    },

    /** An approver, never the requester, decides; an approver or operator may revoke. */
    actOnException(actor: Principal, exceptionId: string, action: "approve" | "reject" | "revoke", reason?: string): Promise<ExceptionState> {
      return k.inTenant(actor, async (tx) => {
        const { rows } = await tx.query<ExceptionRow & { asset_id: string }>(
          `SELECT x.*, NULL AS requested_by_name, NULL AS decided_by_name, NULL AS note_body
           FROM control_exceptions x WHERE id = $1 FOR UPDATE`,
          [UUID.test(exceptionId) ? exceptionId : null],
        );
        const row = rows[0];
        if (!row) throw new GovernanceError("not_found", "exception not found");
        await k.loadAsset(tx, actor, row.asset_id, true);
        const at = k.now();
        if (row.state === "approved" && effectiveExceptionState(row, at) === "expired") {
          throw new GovernanceError("conflict", "this exception has already expired");
        }
        const event = exceptionLifecycle.transition(row.state, action, actor, {
          at,
          caseOwnerId: row.requested_by,
          ...(trimmed(reason) ? { reason: trimmed(reason) } : {}),
        });
        const expiresAt = action === "approve" ? new Date(at.getTime() + row.days * 86_400_000) : row.expires_at;
        const note = await k.writeNote(tx, actor, { assetId: row.asset_id }, event.reason);
        await tx.query(
          "UPDATE control_exceptions SET state = $2, decided_by = COALESCE(decided_by, $3), expires_at = $4, updated_at = $5 WHERE id = $1",
          [
            row.id,
            event.after,
            action === "revoke" ? null : actorId(actor),
            expiresAt ? new Date(expiresAt).toISOString() : null,
            at.toISOString(),
          ],
        );
        await appendAudit(tx, {
          assetId: row.asset_id,
          actorKind: actor.kind,
          actorId: actorId(actor),
          action: `exception.${action}`,
          before: event.before,
          after: event.after,
          note,
          payload: {
            exceptionId: row.id,
            controlId: row.control_id,
            ...(expiresAt ? { expiresAt: new Date(expiresAt).toISOString() } : {}),
          },
          at,
        });
        if (action !== "reject") await redraftFor(tx, actor.tenantId, row.asset_id, row.control_id);
        return event.after;
      });
    },

    /** The owner shows a condition is met (with evidence); an approver accepts, returns or waives it. */
    actOnCondition(actor: Principal, conditionId: string, action: ConditionAction, reason?: string): Promise<ConditionState> {
      return k.inTenant(actor, async (tx) => {
        const { rows } = await tx.query<ConditionRow>(
          "SELECT id, asset_id, case_id, due, state, NULL AS note_body FROM conditions WHERE id = $1 FOR UPDATE",
          [UUID.test(conditionId) ? conditionId : null],
        );
        const row = rows[0];
        if (!row) throw new GovernanceError("not_found", "condition not found");
        const asset = await k.loadAsset(tx, actor, row.asset_id, true);
        const c = await k.loadCase(tx, actor, row.case_id);
        if (action === "submit") {
          if (!isOwner(actor, asset) && !can(actor, "deployment.operate")) {
            throw new GovernanceError("forbidden", "only the owner or an operator can submit a condition");
          }
          const evidence = await tx.query("SELECT 1 FROM evidence WHERE condition_id = $1", [row.id]);
          if (evidence.rows.length === 0) throw new GovernanceError("invalid", "attach evidence before submitting");
        }
        const at = k.now();
        const event = conditionLifecycle.transition(row.state, action, actor, {
          at,
          caseOwnerId: c.ownerId,
          ...(trimmed(reason) ? { reason: trimmed(reason) } : {}),
        });
        const note = await k.writeNote(tx, actor, { assetId: row.asset_id, caseId: row.case_id }, event.reason);
        await tx.query("UPDATE conditions SET state = $2, updated_at = $3 WHERE id = $1", [row.id, event.after, at.toISOString()]);
        await appendAudit(tx, {
          assetId: row.asset_id,
          caseId: row.case_id,
          actorKind: actor.kind,
          actorId: actorId(actor),
          action: `condition.${action}`,
          before: event.before,
          after: event.after,
          note,
          payload: { conditionId: row.id, due: row.due, settled: conditionSettled(event.after) },
          at,
        });
        return event.after;
      });
    },
  };
}

export type AssuranceService = ReturnType<typeof createAssurance>;
