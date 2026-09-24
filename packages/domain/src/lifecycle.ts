import { can, type Permission, type Principal } from "./roles";

/**
 * A declarative lifecycle engine. Ported from Jeeves' transition table and
 * generalized so both case kinds (AI initiatives and content reviews) share
 * one set of authority rules:
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

export interface Lifecycle<S extends string, A extends string> {
  readonly table: TransitionTable<S, A>;
  transition(state: S, action: A, actor: Principal, context: TransitionContext): TransitionEvent<S, A>;
  /** Actions this actor may take from this state; drives which buttons the UI shows. */
  available(state: S, actor: Principal): A[];
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
    if (
      rule.by.includes("case.decide") &&
      actor.kind === "human" &&
      context.caseOwnerId !== undefined &&
      context.caseOwnerId === actor.userId
    ) {
      throw new IllegalTransitionError(`'${action}' cannot be performed on a case you submitted`);
    }
    if (rule.requiresReason && !filled(context.reason)) {
      throw new IllegalTransitionError(`'${action}' requires a written reason`);
    }
    if (rule.requiresFastLanePolicy && (!filled(context.policyId) || !filled(context.accountableApprover))) {
      throw new IllegalTransitionError(`'${action}' requires a policyId and a named accountable approver`);
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

  function available(state: S, actor: Principal): A[] {
    if (actor.kind === "agent") return [];
    const rules: Partial<Record<A, TransitionRule<S>>> = table[state] ?? {};
    return (Object.keys(rules) as A[]).filter((action) => authorized(actor, rules[action]!.by));
  }

  return { table, transition, available };
}

/* ---------------------------------------------------------------------------
 * AI initiative lifecycle (from Jeeves)
 * ------------------------------------------------------------------------ */

export type InitiativeState =
  | "intake_draft"
  | "submitted"
  | "triaged"
  | "in_review"
  | "fast_lane_approved"
  | "approved"
  | "conditionally_approved"
  | "rejected"
  | "deployed"
  | "paused"
  | "re_review"
  | "retired";

export type InitiativeAction =
  | "submit"
  | "triage"
  | "start_review"
  | "fast_lane_approve"
  | "approve"
  | "conditionally_approve"
  | "reject"
  | "deploy"
  | "pause"
  | "resume"
  | "open_reassessment"
  | "retire";

const decide = { by: ["case.decide"] } as const;
const operate = ["deployment.operate", "system"] as const;

export const initiativeLifecycle = defineLifecycle<InitiativeState, InitiativeAction>({
  intake_draft: { submit: { to: "submitted", by: ["case.submit"] } },
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
  approved: { deploy: { to: "deployed", by: operate } },
  conditionally_approved: { deploy: { to: "deployed", by: operate } },
  fast_lane_approved: { deploy: { to: "deployed", by: operate } },
  deployed: {
    pause: { to: "paused", by: operate, requiresReason: true },
    retire: { to: "retired", by: ["deployment.operate"], requiresReason: true },
  },
  paused: {
    resume: { to: "deployed", by: operate, requiresReason: true },
    open_reassessment: { to: "re_review", by: operate },
    retire: { to: "retired", by: ["deployment.operate"], requiresReason: true },
  },
  re_review: {
    approve: { to: "approved", ...decide },
    resume: { to: "deployed", by: operate, requiresReason: true },
    retire: { to: "retired", by: ["deployment.operate"], requiresReason: true },
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
