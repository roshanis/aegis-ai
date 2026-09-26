import { defineLifecycle } from "./lifecycle";

/**
 * Domain reviews: one per required review domain on a risk review case.
 * Ported from Jeeves' review cycle. A reviewer signs, returns the review to
 * the requester with a question, or abstains (for example over a conflict
 * of interest) with a recorded reason. `drafted` is where an agent's draft
 * waits for a person; agents never sign.
 */

export const DOMAIN_REVIEW_STATUSES = ["pending", "drafted", "signed", "returned", "abstained"] as const;
export type DomainReviewStatus = (typeof DOMAIN_REVIEW_STATUSES)[number];
export type DomainReviewAction = "sign" | "return" | "abstain" | "resume" | "respond" | "draft";

const review = {
  sign: { to: "signed", by: ["review.sign"] },
  return: { to: "returned", by: ["review.sign"], requiresReason: true },
  abstain: { to: "abstained", by: ["review.sign"], requiresReason: true },
  // The review drafter writes (or rewrites) a draft for a person to sign, edit or discard.
  draft: { to: "drafted", by: ["agent"] },
} as const;

export const domainReviewLifecycle = defineLifecycle<DomainReviewStatus, DomainReviewAction>(
  {
    pending: review,
    drafted: review,
    returned: {
      respond: { to: "pending", by: ["case.submit"], requiresReason: true },
      abstain: review.abstain,
    },
    abstained: { resume: { to: "pending", by: ["review.sign"] } },
  },
  { draftStates: ["drafted"] },
);

export interface ReviewReadinessInput {
  /** The case's lifecycle state; decisions exist only while it is in review. */
  readonly caseState: string;
  /** Domains triage required. Missing or empty fails closed. */
  readonly requiredDomains: readonly string[] | null;
  readonly reviews: readonly {
    readonly domain: string;
    readonly status: DomainReviewStatus;
    /** True only when the abstention's reason was recorded. */
    readonly abstentionRecorded?: boolean;
  }[];
}

export interface DecisionReadiness {
  readonly canApprove: boolean;
  readonly canConditionallyApprove: boolean;
  readonly canReject: boolean;
  readonly hasRequiredDomains: boolean;
  /** Unmet obligations for approval, as "domain:status". */
  readonly approvalBlockers: readonly string[];
  readonly conditionalBlockers: readonly string[];
  /** One sentence for the approver. */
  readonly reason: string;
}

/**
 * Whether an approver may decide yet. Readiness is a projection, not
 * authorization: the service still checks the actor and the case inside the
 * decision's transaction.
 *
 * - Approval needs every required domain signed, or abstained with a
 *   recorded reason.
 * - Conditional approval also accepts agent drafts still awaiting a
 *   signature.
 * - A recorded abstention never blocks, but never hides another domain's
 *   obligation either.
 */
export function decisionReadiness(input: ReviewReadinessInput): DecisionReadiness {
  const open = input.caseState === "in_review";
  const required = input.requiredDomains ?? [];
  const hasRequiredDomains = required.length > 0;
  const byDomain = new Map(input.reviews.map((r) => [r.domain, r]));
  const abstained = (domain: string) => {
    const row = byDomain.get(domain);
    return row?.status === "abstained" && row.abstentionRecorded === true;
  };
  const blockers = (accepted: readonly DomainReviewStatus[]) =>
    required.flatMap((domain) => {
      const status = byDomain.get(domain)?.status ?? "missing";
      return accepted.includes(status as DomainReviewStatus) || abstained(domain) ? [] : [`${domain}:${status}`];
    });

  const approvalBlockers = blockers(["signed"]);
  const conditionalBlockers = blockers(["signed", "drafted"]);
  const canApprove = open && hasRequiredDomains && approvalBlockers.length === 0;
  const canConditionallyApprove = open && hasRequiredDomains && conditionalBlockers.length === 0;
  const abstentions = required.filter(abstained).length;

  const reason = !open
    ? "No review is awaiting a decision."
    : !hasRequiredDomains
      ? "Required review domains are unavailable."
      : canApprove
        ? abstentions === required.length
          ? "Every required reviewer abstained; ready for an approver decision."
          : abstentions > 0
            ? `All participating reviews signed; ${abstentions} abstained. Ready for an approver decision.`
            : "All required reviews signed; ready for approval."
        : canConditionallyApprove
          ? "Ready for conditional approval; signatures still pending."
          : "Required reviews are incomplete.";

  return {
    canApprove,
    canConditionallyApprove,
    canReject: open,
    hasRequiredDomains,
    approvalBlockers,
    conditionalBlockers,
    reason,
  };
}
