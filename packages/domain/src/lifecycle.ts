import { can, type Permission, type Principal } from "./roles";

/**
 * A declarative lifecycle engine. Ported from Jeeves' transition table and
 * generalized so registry assets and both case kinds (risk reviews and
 * content reviews) share one set of authority rules:
 *
 * - AI agents can never move a case. They draft; people and deterministic
 *   system jobs act.
 * - Nobody decides a case they submitted.
 * - Actions marked `requiresReason` need a written note, which lands in the
 *   audit event.
 * - The pure function never reads the clock; callers pass `at`.
 */

export type Authority = Permission | "system";

export interface TransitionRule<S extends string> {
  readonly to: S;
  readonly by: readonly Authority[];
  readonly requiresReason?: boolean;
  /** Fast-lane approvals must name the pre-approved policy and an accountable person. */
  readonly requiresFastLanePolicy?: boolean;
  /** Putting an asset into use must cite the review case that cleared it. */
  readonly requiresClearance?: boolean;
}

export type TransitionTable<S extends string, A extends string> = Partial<
  Record<S, Partial<Record<A, TransitionRule<S>>>>
>;

export interface TransitionContext {
  readonly at: Date;
  readonly reason?: string;
  readonly policyId?: string;
  readonly accountableApprover?: string;
  /** Who submitted the case; used to block self-approval. */
  readonly caseOwnerId?: string;
  /** The approved review case that clears an asset for use. */
  readonly clearingCaseId?: string;
}

export interface TransitionEvent<S extends string, A extends string> {
  readonly action: A;
  readonly before: S;
  readonly after: S;
  readonly actor: Principal;
  readonly reason: string | null;
  readonly at: Date;
}

export class IllegalTransitionError extends Error {
  constructor(readonly violation: string) {
    super(`Illegal transition: ${violation}`);
    this.name = "IllegalTransitionError";
  }
}

const filled = (value: string | undefined) =>
  typeof value === "string" && value.trim().length > 0;

function authorized(actor: Principal, by: readonly Authority[]): boolean {
  return by.some((authority) =>
    authority === "system" ? actor.kind === "system" : can(actor, authority),
  );
}

function decidesOwnCase(actor: Principal, by: readonly Authority[], caseOwnerId: string | undefined): boolean {
  return (
    by.includes("case.decide") &&
    actor.kind === "human" &&
    caseOwnerId !== undefined &&
    caseOwnerId === actor.userId
  );
}

export interface Lifecycle<S extends string, A extends string> {
  readonly table: TransitionTable<S, A>;
  transition(state: S, action: A, actor: Principal, context: TransitionContext): TransitionEvent<S, A>;
  /** Actions this actor may take from this state; drives which buttons the UI shows. */
  available(state: S, actor: Principal, context?: Pick<TransitionContext, "caseOwnerId">): A[];
}

export function defineLifecycle<S extends string, A extends string>(
  table: TransitionTable<S, A>,
): Lifecycle<S, A> {
  function transition(state: S, action: A, actor: Principal, context: TransitionContext) {
    const rule = table[state]?.[action];
    if (!rule) throw new IllegalTransitionError(`no '${action}' from '${state}'`);
    if (actor.kind === "agent") {
      throw new IllegalTransitionError(`agent '${actor.agent}' cannot perform '${action}'; agents only draft`);
    }
    if (!authorized(actor, rule.by)) {
      throw new IllegalTransitionError(`'${action}' requires one of [${rule.by.join(", ")}]`);
    }
    if (decidesOwnCase(actor, rule.by, context.caseOwnerId)) {
      throw new IllegalTransitionError(`'${action}' cannot be performed on a case you submitted`);
    }
    if (rule.requiresReason && !filled(context.reason)) {
      throw new IllegalTransitionError(`'${action}' requires a written reason`);
    }
    if (rule.requiresFastLanePolicy && (!filled(context.policyId) || !filled(context.accountableApprover))) {
      throw new IllegalTransitionError(`'${action}' requires a policyId and a named accountable approver`);
    }
    if (rule.requiresClearance && !filled(context.clearingCaseId)) {
      throw new IllegalTransitionError(`'${action}' requires an approved review case`);
    }
    return {
      action,
      before: state,
      after: rule.to,
      actor,
      reason: filled(context.reason) ? context.reason!.trim() : null,
      at: context.at,
    };
  }

  function available(state: S, actor: Principal, context: Pick<TransitionContext, "caseOwnerId"> = {}): A[] {
    if (actor.kind === "agent") return [];
    const rules: Partial<Record<A, TransitionRule<S>>> = table[state] ?? {};
    return (Object.keys(rules) as A[]).filter((action) => {
      const { by } = rules[action]!;
      return authorized(actor, by) && !decidesOwnCase(actor, by, context.caseOwnerId);
    });
  }

  return { table, transition, available };
}

/* ---------------------------------------------------------------------------
 * Risk review case lifecycle (from Jeeves)
 *
 * One review of one registered asset. Jeeves kept review and operating
 * state on a single record; here the asset's operating state (active,
 * paused, retired) lives in the registry, and each re-review is a new case.
 * ------------------------------------------------------------------------ */

export type RiskReviewState =
  | "draft"
  | "submitted"
  | "triaged"
  | "in_review"
  | "fast_lane_approved"
  | "approved"
  | "conditionally_approved"
  | "rejected";

export type RiskReviewAction =
  | "submit"
  | "triage"
  | "start_review"
  | "fast_lane_approve"
  | "approve"
  | "conditionally_approve"
  | "reject";

const decide = { by: ["case.decide"] } as const;

export const riskReviewLifecycle = defineLifecycle<RiskReviewState, RiskReviewAction>({
  draft: { submit: { to: "submitted", by: ["case.submit"] } },
  submitted: { triage: { to: "triaged", by: ["system"] } },
  triaged: {
    start_review: { to: "in_review", by: ["system", "review.sign"] },
    fast_lane_approve: { to: "fast_lane_approved", by: ["system"], requiresFastLanePolicy: true },
  },
  in_review: {
    approve: { to: "approved", ...decide },
    conditionally_approve: { to: "conditionally_approved", ...decide, requiresReason: true },
    reject: { to: "rejected", ...decide, requiresReason: true },
  },
});

/* ---------------------------------------------------------------------------
 * Content review lifecycle (from Cleared)
 * ------------------------------------------------------------------------ */

export type ContentState =
  | "draft"
  | "submitted"
  | "ai_reviewed"
  | "approved"
  | "changes_requested"
  | "rejected";

export type ContentAction =
  | "submit"
  | "record_ai_review"
  | "approve"
  | "request_changes"
  | "reject"
  | "resubmit";

/** Every officer decision needs a note, as in Cleared. */
export const contentLifecycle = defineLifecycle<ContentState, ContentAction>({
  draft: { submit: { to: "submitted", by: ["case.submit"] } },
  submitted: { record_ai_review: { to: "ai_reviewed", by: ["system"] } },
  ai_reviewed: {
    approve: { to: "approved", ...decide, requiresReason: true },
    request_changes: { to: "changes_requested", ...decide, requiresReason: true },
    reject: { to: "rejected", ...decide, requiresReason: true },
  },
  changes_requested: { resubmit: { to: "submitted", by: ["case.submit"] } },
});
