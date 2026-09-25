import { describe, expect, it } from "vitest";
import { conditionLifecycle, exceptionActive, exceptionLifecycle, useBlockers } from "./assurance";
import { controlApplies, requiredControls, uncoveredGates, type ControlDefinition } from "./controls";
import { human, system } from "./test-principals";

const at = new Date("2026-09-25T12:00:00Z");
const control = (id: string, domain: string, extra: Partial<ControlDefinition> = {}): ControlDefinition => ({
  id,
  domain,
  name: id,
  requiredEvidence: "doc",
  enforcement: "gate",
  cadence: "once",
  when: { all: [] },
  frameworkRefs: [],
  ...extra,
});

const catalog = [
  control("S-02", "security", { enforcement: "monitor" }),
  control("S-01", "security", { minTier: "high" }),
  control("H-01", "privacy-hipaa", { when: { yes: "phi" } }),
  control("L-01", "legal", { when: { yes: "vendorHosted" } }),
];

describe("controls", () => {
  it("applies by answers and minimum tier", () => {
    expect(controlApplies(catalog[1]!, "medium", {})).toBe(false);
    expect(controlApplies(catalog[1]!, "critical", {})).toBe(true);
    expect(controlApplies(catalog[2]!, "low", { phi: true })).toBe(true);
  });

  it("requires only controls in the case's review domains", () => {
    const ids = (r: ControlDefinition[]) => r.map((c) => c.id);
    expect(ids(requiredControls(catalog, { tier: "high", domains: ["security"] }, { phi: true }))).toEqual([
      "S-01",
      "S-02",
    ]);
    expect(
      ids(requiredControls(catalog, { tier: "high", domains: ["security", "privacy-hipaa"] }, { phi: true })),
    ).toEqual(["H-01", "S-01", "S-02"]);
  });

  it("counts a gate as covered by evidence or an active exception, and never blocks on monitor controls", () => {
    const coverage = new Map([
      ["S-01", { evidence: 1, activeException: false }],
      ["H-01", { evidence: 0, activeException: true }],
    ]);
    expect(uncoveredGates(catalog, (id) => coverage.get(id)).map((c) => c.id)).toEqual(["L-01"]);
  });
});

describe("conditions", () => {
  const owner = human(["requester"]);
  const approver = human(["approver"]);

  it("lets the owner submit and an approver accept, return or waive", () => {
    expect(conditionLifecycle.transition("open", "submit", owner, { at }).after).toBe("submitted");
    expect(() => conditionLifecycle.transition("submitted", "accept", owner, { at })).toThrow(/case.decide/);
    expect(
      conditionLifecycle.transition("submitted", "accept", approver, { at, caseOwnerId: owner.userId }).after,
    ).toBe("met");
    expect(() => conditionLifecycle.transition("submitted", "return", approver, { at })).toThrow(/written reason/);
    expect(conditionLifecycle.transition("open", "waive", approver, { at, reason: "Superseded by C-12" }).after).toBe(
      "waived",
    );
  });
});

describe("control exceptions (Jeeves acceptance)", () => {
  const requester = human(["approver"]);
  const approver = human(["approver"]);

  it("separation of duties: an approver cannot decide an exception they requested", () => {
    expect(() =>
      exceptionLifecycle.transition("requested", "approve", requester, { at, caseOwnerId: requester.userId }),
    ).toThrow(/case you submitted/);
    expect(
      exceptionLifecycle.transition("requested", "approve", approver, { at, caseOwnerId: requester.userId }).after,
    ).toBe("approved");
  });

  it("a non-decider cannot decide, and rejection needs a reason", () => {
    expect(() => exceptionLifecycle.transition("requested", "approve", human(["reviewer"]), { at })).toThrow(
      /case.decide/,
    );
    expect(() => exceptionLifecycle.transition("requested", "reject", approver, { at })).toThrow(/written reason/);
  });

  it("an approved exception can be revoked by an admin, and expires only by system", () => {
    expect(
      exceptionLifecycle.transition("approved", "revoke", human(["admin"]), { at, reason: "Evidence arrived" }).after,
    ).toBe("revoked");
    expect(exceptionLifecycle.transition("approved", "expire", system, { at }).after).toBe("expired");
    expect(() => exceptionLifecycle.transition("approved", "expire", approver, { at })).toThrow();
  });

  it("stops covering at its expiry even before it is marked expired", () => {
    expect(exceptionActive("approved", new Date("2026-10-01"), at)).toBe(true);
    expect(exceptionActive("approved", new Date("2026-09-01"), at)).toBe(false);
    expect(exceptionActive("requested", new Date("2026-10-01"), at)).toBe(false);
  });
});

describe("use blockers", () => {
  it("explains what still stands between an approval and use", () => {
    expect(useBlockers({ pendingConditions: 0, uncoveredGates: [] })).toEqual([]);
    expect(useBlockers({ pendingConditions: 2, uncoveredGates: [{ id: "H-01", name: "PHI minimization & BAA" }] })).toEqual([
      "2 conditions must be met before use",
      "H-01 PHI minimization & BAA has no evidence or exception",
    ]);
  });
});
