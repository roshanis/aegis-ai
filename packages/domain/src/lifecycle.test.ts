import { describe, expect, it } from "vitest";
import { contentLifecycle, IllegalTransitionError, initiativeLifecycle } from "./lifecycle";
import { agent, human, system } from "./test-principals";

const at = new Date("2026-09-24T12:00:00Z");

describe("initiative lifecycle", () => {
  it("walks the happy path with the right people", () => {
    const requester = human(["requester"]);
    const approver = human(["approver"]);
    const admin = human(["admin"]);
    const steps = [
      initiativeLifecycle.transition("intake_draft", "submit", requester, { at }),
      initiativeLifecycle.transition("submitted", "triage", system, { at }),
      initiativeLifecycle.transition("triaged", "start_review", system, { at }),
      initiativeLifecycle.transition("in_review", "conditionally_approve", approver, {
        at,
        reason: "Retention control C-12 must be live before launch",
        caseOwnerId: requester.userId,
      }),
      initiativeLifecycle.transition("conditionally_approved", "deploy", admin, { at }),
      initiativeLifecycle.transition("deployed", "pause", system, { at, reason: "hallucination rate breach" }),
    ];
    expect(steps.map((s) => s.after)).toEqual([
      "submitted",
      "triaged",
      "in_review",
      "conditionally_approved",
      "deployed",
      "paused",
    ]);
    expect(steps[3]!.reason).toBe("Retention control C-12 must be live before launch");
  });

  it("never lets an agent move a case", () => {
    expect(() => initiativeLifecycle.transition("in_review", "approve", agent, { at })).toThrow(
      /agents only draft/,
    );
    expect(initiativeLifecycle.available("in_review", agent)).toEqual([]);
  });

  it("keeps admins out of approvals", () => {
    expect(() => initiativeLifecycle.transition("in_review", "approve", human(["admin"]), { at })).toThrow(
      IllegalTransitionError,
    );
  });

  it("blocks approving your own case", () => {
    const approver = human(["approver", "reviewer"]);
    expect(() =>
      initiativeLifecycle.transition("in_review", "approve", approver, { at, caseOwnerId: approver.userId }),
    ).toThrow(/case you submitted/);
  });

  it("requires a reason to pause and to reject", () => {
    expect(() => initiativeLifecycle.transition("deployed", "pause", system, { at, reason: "  " })).toThrow(
      /written reason/,
    );
    expect(() => initiativeLifecycle.transition("in_review", "reject", human(["approver"]), { at })).toThrow(
      /written reason/,
    );
  });

  it("requires a named accountable approver for the fast lane", () => {
    expect(() =>
      initiativeLifecycle.transition("triaged", "fast_lane_approve", system, { at, policyId: "fl-1" }),
    ).toThrow(/accountable approver/);
    const ok = initiativeLifecycle.transition("triaged", "fast_lane_approve", system, {
      at,
      policyId: "fl-1",
      accountableApprover: "VP, AI Governance",
    });
    expect(ok.after).toBe("fast_lane_approved");
  });

  it("treats rejected and retired as terminal", () => {
    expect(initiativeLifecycle.available("rejected", human(["admin"]))).toEqual([]);
    expect(initiativeLifecycle.available("retired", system)).toEqual([]);
  });

  it("offers each role only its own actions", () => {
    expect(initiativeLifecycle.available("in_review", human(["approver"]))).toEqual([
      "approve",
      "conditionally_approve",
      "reject",
    ]);
    expect(initiativeLifecycle.available("paused", human(["admin"]))).toEqual([
      "resume",
      "open_reassessment",
      "retire",
    ]);
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
