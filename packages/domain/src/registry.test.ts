import { describe, expect, it } from "vitest";
import { assetLifecycle, caseKindFor, caseLabel, clearance, isDecided, parseCaseLabel, type CaseSummary } from "./registry";
import { agent, human, system } from "./test-principals";

const at = new Date("2026-09-24T12:00:00Z");
const day = (d: number) => new Date(Date.UTC(2026, 8, d));

const review = (id: string, state: string, decided: number | null, trigger: CaseSummary["trigger"] = "initial") =>
  ({ id, kind: "risk_review", trigger, state, decidedAt: decided === null ? null : day(decided) }) as const;

describe("asset lifecycle", () => {
  const admin = human(["admin"]);

  it("activates, pauses and resumes only with a clearing case", () => {
    expect(() => assetLifecycle.transition("registered", "activate", admin, { at })).toThrow(/approved review case/);
    const active = assetLifecycle.transition("registered", "activate", admin, { at, clearingCaseId: "c1" });
    expect(active.after).toBe("active");
    expect(assetLifecycle.transition("active", "pause", system, { at, reason: "drift alert" }).after).toBe("paused");
    expect(() => assetLifecycle.transition("paused", "resume", admin, { at, reason: "fixed" })).toThrow(
      /approved review case/,
    );
    expect(
      assetLifecycle.transition("paused", "resume", admin, { at, reason: "fixed", clearingCaseId: "c2" }).after,
    ).toBe("active");
  });

  it("requires a reason to pause or retire, and a person to retire", () => {
    expect(() => assetLifecycle.transition("active", "pause", system, { at, reason: "  " })).toThrow(/written reason/);
    expect(() => assetLifecycle.transition("active", "retire", system, { at, reason: "sunset" })).toThrow(
      /deployment.operate/,
    );
    expect(assetLifecycle.transition("active", "retire", admin, { at, reason: "sunset" }).after).toBe("retired");
    expect(assetLifecycle.available("retired", admin)).toEqual([]);
  });

  it("gives requesters, approvers and agents no operating actions", () => {
    for (const actor of [human(["requester"]), human(["approver"]), agent]) {
      expect(assetLifecycle.available("active", actor)).toEqual([]);
    }
  });
});

describe("cases", () => {
  it("routes content to content review and everything else to risk review", () => {
    expect(caseKindFor("content_item")).toBe("content_review");
    expect(caseKindFor("agent")).toBe("risk_review");
  });

  it("knows which states close a case", () => {
    expect(isDecided("risk_review", "fast_lane_approved")).toBe(true);
    expect(isDecided("risk_review", "in_review")).toBe(false);
    expect(isDecided("content_review", "changes_requested")).toBe(false);
    expect(isDecided("content_review", "rejected")).toBe(true);
  });
});

describe("clearance", () => {
  it("is withheld until a review approves", () => {
    expect(clearance([])).toEqual({ cleared: false, reason: "no review has approved it yet", caseId: null });
    expect(clearance([review("c1", "in_review", null)]).cleared).toBe(false);
  });

  it("follows the most recently decided case", () => {
    expect(clearance([review("c1", "conditionally_approved", 1)])).toEqual({ cleared: true, caseId: "c1" });
    const revoked = clearance([review("c1", "approved", 1), review("c2", "rejected", 5, "periodic")]);
    expect(revoked).toEqual({ cleared: false, reason: "its latest review was rejected", caseId: "c2" });
    const renewed = clearance([review("c2", "rejected", 5), review("c3", "approved", 9, "change")]);
    expect(renewed).toEqual({ cleared: true, caseId: "c3" });
  });

  it("keeps the current approval while a change review is open, but not an incident review", () => {
    const approved = review("c1", "approved", 1);
    expect(clearance([approved, review("c2", "in_review", null, "change")]).cleared).toBe(true);
    expect(clearance([approved, review("c3", "submitted", null, "incident")])).toEqual({
      cleared: false,
      reason: "an incident review is still open",
      caseId: "c3",
    });
  });
});

describe("case labels", () => {
  it("writes and reads case numbers the way people say them", () => {
    expect(caseLabel(7)).toBe("CASE-0007");
    expect(caseLabel(14207)).toBe("CASE-14207");
    for (const text of ["CASE-0142", "case 142", "Case-142", "#142", "142", " 0142 "]) {
      expect(parseCaseLabel(text)).toBe(142);
    }
    for (const text of ["", "CASE-", "CASE-0", "claims", "142a", "-3"]) expect(parseCaseLabel(text)).toBeNull();
  });
});
