import { defineLifecycle } from "./lifecycle";

/**
 * Conditions and control exceptions: what keeps an approval honest after
 * the decision.
 */

/* ---------------------------------------------------------------------------
 * Conditions attached to a conditional approval
 * ------------------------------------------------------------------------ */

/** before_use conditions block clearance until met; ongoing ones are tracked. */
export const CONDITION_DUES = ["before_use", "ongoing"] as const;
export type ConditionDue = (typeof CONDITION_DUES)[number];

export type ConditionState = "open" | "submitted" | "met" | "waived";
export type ConditionAction = "submit" | "accept" | "return" | "waive";

const waive = { to: "waived", by: ["case.decide"], requiresReason: true } as const;

/** The owner shows a condition is met; an approver, never the owner, accepts it. */
export const conditionLifecycle = defineLifecycle<ConditionState, ConditionAction>({
  open: {
    submit: { to: "submitted", by: ["case.submit", "deployment.operate"] },
    waive,
  },
  submitted: {
    accept: { to: "met", by: ["case.decide"] },
    return: { to: "open", by: ["case.decide"], requiresReason: true },
    waive,
  },
});

export const conditionSettled = (state: ConditionState) => state === "met" || state === "waived";

/* ---------------------------------------------------------------------------
 * Control exceptions (from Jeeves): a gate control that cannot be met yet
 * may be covered by a time-boxed, accountable exception.
 * ------------------------------------------------------------------------ */

export type ExceptionState = "requested" | "approved" | "rejected" | "revoked" | "expired";
export type ExceptionAction = "approve" | "reject" | "revoke" | "expire";

export const DEFAULT_EXCEPTION_DAYS = 90;
export const MAX_EXCEPTION_DAYS = 365;

/** Nobody decides an exception they requested; pass the requester as caseOwnerId. */
export const exceptionLifecycle = defineLifecycle<ExceptionState, ExceptionAction>({
  requested: {
    approve: { to: "approved", by: ["case.decide"] },
    reject: { to: "rejected", by: ["case.decide"], requiresReason: true },
  },
  approved: {
    revoke: { to: "revoked", by: ["case.decide", "deployment.operate"], requiresReason: true },
    expire: { to: "expired", by: ["system"] },
  },
});

/** An approved exception past its expiry no longer covers anything, even before a job marks it expired. */
export function exceptionActive(state: ExceptionState, expiresAt: Date | null, now: Date): boolean {
  return state === "approved" && expiresAt !== null && expiresAt > now;
}

/* ---------------------------------------------------------------------------
 * Readiness for use, beyond the decision itself
 * ------------------------------------------------------------------------ */

export function useBlockers(input: {
  readonly pendingConditions: number;
  readonly uncoveredGates: readonly { readonly id: string; readonly name: string }[];
}): string[] {
  const blockers: string[] = [];
  if (input.pendingConditions > 0) {
    blockers.push(
      `${input.pendingConditions} condition${input.pendingConditions === 1 ? "" : "s"} must be met before use`,
    );
  }
  for (const control of input.uncoveredGates) {
    blockers.push(`${control.id} ${control.name} has no evidence or exception`);
  }
  return blockers;
}
