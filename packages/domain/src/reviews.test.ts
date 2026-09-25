import { describe, expect, it } from "vitest";
import { decisionReadiness, domainReviewLifecycle, type ReviewReadinessInput } from "./reviews";
import { agent, human } from "./test-principals";

const at = new Date("2026-09-25T12:00:00Z");

/*
 * Acceptance tests ported from Jeeves (lib/approval/review-readiness.test.ts).
 * Jeeves' closed-cycle and re_review cases map to a case that is no longer
 * in review, because a re-review is a new case here.
 */
const input: ReviewReadinessInput = {
  caseState: "in_review",
  requiredDomains: ["legal", "security"],
  reviews: [
    { domain: "legal", status: "signed" },
    { domain: "security", status: "signed" },
  ],
};

describe("decision readiness (Jeeves acceptance)", () => {
  it.each(["pending", "returned"] as const)("blocks approval and conditional approval for a %s required review", (status) => {
    expect(decisionReadiness({ ...input, reviews: [input.reviews[0]!, { domain: "security", status }] })).toMatchObject({
      canApprove: false,
      canConditionallyApprove: false,
      canReject: true,
      approvalBlockers: [`security:${status}`],
    });
  });

  it("requires every domain even when rows are missing", () => {
    expect(decisionReadiness({ ...input, reviews: [] })).toMatchObject({
      canApprove: false,
      canConditionallyApprove: false,
      approvalBlockers: ["legal:missing", "security:missing"],
    });
  });

  it.each([null, []])("fails closed without a required-domain set", (requiredDomains) => {
    expect(decisionReadiness({ ...input, requiredDomains })).toMatchObject({
      hasRequiredDomains: false,
      canApprove: false,
      canConditionallyApprove: false,
      canReject: true,
    });
  });

  it("allows conditional approval after all domains are drafted or signed", () => {
    expect(
      decisionReadiness({ ...input, reviews: [input.reviews[0]!, { domain: "security", status: "drafted" }] }),
    ).toMatchObject({ canApprove: false, canConditionallyApprove: true, conditionalBlockers: [] });
  });

  it("allows full approval only once every domain is signed", () => {
    expect(decisionReadiness(input)).toMatchObject({ canApprove: true, canConditionallyApprove: true });
  });

  it.each(["conditionally_approved", "approved", "fast_lane_approved", "rejected", "triaged"])(
    "offers no decision once the case is %s",
    (caseState) => {
      expect(decisionReadiness({ ...input, caseState })).toMatchObject({
        canApprove: false,
        canConditionallyApprove: false,
        canReject: false,
      });
    },
  );
});

describe("recorded abstention (Jeeves acceptance)", () => {
  it.each(["signed", "drafted"] as const)("continues with a %s participating reviewer and a recorded abstention", (status) => {
    const result = decisionReadiness({
      ...input,
      reviews: [
        { domain: "legal", status },
        { domain: "security", status: "abstained", abstentionRecorded: true },
      ],
    });
    expect(result).toMatchObject({ canApprove: status === "signed", canConditionallyApprove: true, conditionalBlockers: [] });
    expect(result.reason).toMatch(/abstain|pending/i);
    expect(result.reason).not.toMatch(/all required reviews signed/i);
  });

  it("lets a person decide when every required reviewer abstained", () => {
    const reviews = input.reviews.map((r) => ({ ...r, status: "abstained" as const, abstentionRecorded: true }));
    expect(decisionReadiness({ ...input, reviews })).toMatchObject({
      canApprove: true,
      canConditionallyApprove: true,
      canReject: true,
    });
  });

  it("keeps an abstention without a recorded reason blocking", () => {
    expect(
      decisionReadiness({ ...input, reviews: [input.reviews[0]!, { domain: "security", status: "abstained" }] }),
    ).toMatchObject({ canApprove: false, canConditionallyApprove: false, approvalBlockers: ["security:abstained"] });
  });

  it.each(["pending", "returned", "missing"] as const)("does not hide another %s obligation", (status) => {
    const reviews = [
      { domain: "legal", status: "abstained" as const, abstentionRecorded: true },
      ...(status === "missing" ? [] : [{ domain: "security", status }]),
    ];
    expect(decisionReadiness({ ...input, reviews })).toMatchObject({
      canApprove: false,
      canConditionallyApprove: false,
      approvalBlockers: [`security:${status}`],
    });
  });
});

describe("domain review lifecycle", () => {
  const reviewer = human(["reviewer"], ["security"]);
  const requester = human(["requester"]);

  it("lets a reviewer sign, return with a question, or abstain with a reason", () => {
    expect(domainReviewLifecycle.transition("pending", "sign", reviewer, { at }).after).toBe("signed");
    expect(() => domainReviewLifecycle.transition("pending", "return", reviewer, { at })).toThrow(/written reason/);
    expect(domainReviewLifecycle.transition("drafted", "return", reviewer, { at, reason: "Need the BAA" }).after).toBe(
      "returned",
    );
    expect(domainReviewLifecycle.transition("pending", "abstain", reviewer, { at, reason: "I built it" }).after).toBe(
      "abstained",
    );
    expect(domainReviewLifecycle.transition("abstained", "resume", reviewer, { at }).after).toBe("pending");
  });

  it("sends a returned review back to pending when the requester answers", () => {
    expect(() => domainReviewLifecycle.transition("returned", "respond", reviewer, { at, reason: "x" })).toThrow(
      /case.submit/,
    );
    expect(
      domainReviewLifecycle.transition("returned", "respond", requester, { at, reason: "BAA attached" }).after,
    ).toBe("pending");
  });

  it("never lets an agent sign, and keeps signatures final", () => {
    expect(() => domainReviewLifecycle.transition("drafted", "sign", agent, { at })).toThrow(/agents only draft/);
    expect(domainReviewLifecycle.available("signed", reviewer)).toEqual([]);
  });

  it("lets only the drafter draft, and only a pending or drafted review", () => {
    expect(domainReviewLifecycle.transition("pending", "draft", agent, { at }).after).toBe("drafted");
    expect(domainReviewLifecycle.transition("drafted", "draft", agent, { at }).after).toBe("drafted");
    expect(domainReviewLifecycle.available("pending", agent)).toEqual(["draft"]);
    for (const state of ["returned", "abstained", "signed"] as const) {
      expect(domainReviewLifecycle.available(state, agent)).toEqual([]);
    }
    // People sign drafts; they do not write them through the agent's door.
    expect(() => domainReviewLifecycle.transition("pending", "draft", reviewer, { at })).toThrow(/requires one of \[agent\]/);
    expect(domainReviewLifecycle.available("drafted", reviewer)).not.toContain("draft");
  });
});
