import { describe, expect, it } from "vitest";
import { contentLifecycle, IllegalTransitionError, riskReviewLifecycle } from "./lifecycle";
import { agent, human, system } from "./test-principals";

const at = new Date("2026-09-24T12:00:00Z");

describe("risk review lifecycle", () => {
  it("walks the happy path with the right people", () => {
    const requester = human(["requester"]);
    const approver = human(["approver"]);
    const steps = [
      riskReviewLifecycle.transition("draft", "submit", requester, { at }),
      riskReviewLifecycle.transition("submitted", "triage", system, { at }),
      riskReviewLifecycle.transition("triaged", "start_review", system, { at }),
      riskReviewLifecycle.transition("in_review", "conditionally_approve", approver, {
        at,
        reason: "Retention control C-12 must be live before launch",
        caseOwnerId: requester.userId,
      }),
    ];
    expect(steps.map((s) => s.after)).toEqual(["submitted", "triaged", "in_review", "conditionally_approved"]);
    expect(steps[3]!.reason).toBe("Retention control C-12 must be live before launch");
  });

  it("never lets an agent move a case", () => {
    expect(() => riskReviewLifecycle.transition("in_review", "approve", agent, { at })).toThrow(/agents only draft/);
    expect(riskReviewLifecycle.available("in_review", agent)).toEqual([]);
  });

  it("keeps admins out of approvals", () => {
    expect(() => riskReviewLifecycle.transition("in_review", "approve", human(["admin"]), { at })).toThrow(
      IllegalTransitionError,
    );
  });

  it("blocks approving your own case, and hides the buttons for it", () => {
    const approver = human(["approver", "reviewer"]);
    expect(() =>
      riskReviewLifecycle.transition("in_review", "approve", approver, { at, caseOwnerId: approver.userId }),
    ).toThrow(/case you submitted/);
    expect(riskReviewLifecycle.available("in_review", approver, { caseOwnerId: approver.userId })).toEqual([]);
  });

  it("requires a reason to reject", () => {
    expect(() => riskReviewLifecycle.transition("in_review", "reject", human(["approver"]), { at })).toThrow(
      /written reason/,
    );
  });

  it("requires a named accountable approver for the fast lane", () => {
    expect(() =>
      riskReviewLifecycle.transition("triaged", "fast_lane_approve", system, { at, policyId: "fl-1" }),
    ).toThrow(/accountable approver/);
    const ok = riskReviewLifecycle.transition("triaged", "fast_lane_approve", system, {
      at,
      policyId: "fl-1",
      accountableApprover: "VP, AI Governance",
    });
    expect(ok.after).toBe("fast_lane_approved");
  });

  it("treats every decision as terminal", () => {
    for (const state of ["approved", "conditionally_approved", "fast_lane_approved", "rejected"] as const) {
      expect(riskReviewLifecycle.available(state, human(["approver"]))).toEqual([]);
      expect(riskReviewLifecycle.available(state, system)).toEqual([]);
    }
  });

  it("offers each role only its own actions", () => {
    expect(riskReviewLifecycle.available("in_review", human(["approver"]))).toEqual([
      "approve",
      "conditionally_approve",
      "reject",
    ]);
    expect(riskReviewLifecycle.available("in_review", human(["reviewer"]))).toEqual([]);
    expect(riskReviewLifecycle.available("triaged", human(["reviewer"]))).toEqual(["start_review"]);
  });
});

describe("content lifecycle", () => {
  it("routes a document through AI review to a noted officer decision and back", () => {
    const author = human(["requester"]);
    const officer = human(["approver"]);
    expect(contentLifecycle.transition("draft", "submit", author, { at }).after).toBe("submitted");
    expect(contentLifecycle.transition("submitted", "record_ai_review", system, { at }).after).toBe("ai_reviewed");
    expect(() => contentLifecycle.transition("ai_reviewed", "approve", officer, { at })).toThrow(/written reason/);
    const changes = contentLifecycle.transition("ai_reviewed", "request_changes", officer, {
      at,
      reason: "C2: remove 'guaranteed'",
    });
    expect(changes.after).toBe("changes_requested");
    expect(contentLifecycle.transition("changes_requested", "resubmit", author, { at }).after).toBe("submitted");
  });
});
