import { describe, expect, it } from "vitest";
import { evaluate, fastLaneEligibility, referencedFields, triage, type TriagePolicy } from "./triage";

const policy: TriagePolicy = {
  tierRules: [
    { id: "r1", when: { all: [{ yes: "a" }, { not: { yes: "b" } }] }, tier: "critical", because: "a without b" },
    { id: "r2", when: { any: [{ yes: "a" }, { equals: ["kind", "x"] }] }, tier: "high", because: "a or kind x" },
  ],
  defaultTier: "low",
  baseDomains: { low: ["security"], medium: ["security"], high: ["security", "legal"], critical: ["legal"] },
  domainRules: [{ when: { yes: "c" }, add: ["privacy", "security"], because: "c is set" }],
};

describe("triage", () => {
  it("uses the first matching tier rule and explains it", () => {
    const result = triage(policy, { a: true, c: true });
    expect(result.tier).toBe("critical");
    expect(result.tierRuleId).toBe("r1");
    expect(result.domains).toEqual(["legal", "privacy", "security"]);
    expect(result.explanation).toEqual(["critical tier: a without b", "adds privacy, security: c is set"]);
  });

  it("names domains with the pack's labels in the explanation", () => {
    const result = triage(policy, { c: true }, { privacy: "Privacy / HIPAA" });
    expect(result.explanation).toEqual(["low tier: no risk rule matched", "adds Privacy / HIPAA: c is set"]);
    expect(result.domains).toEqual(["privacy", "security"]);
  });

  it("falls back to the default tier", () => {
    const result = triage(policy, {});
    expect(result).toMatchObject({ tier: "low", tierRuleId: null, domains: ["security"] });
  });

  it("treats only literal true as yes", () => {
    expect(evaluate({ yes: "a" }, { a: "true" })).toBe(false);
    expect(evaluate({ equals: ["kind", "x"] }, { kind: "x" })).toBe(true);
  });

  it("lists every field the policy reads", () => {
    expect(referencedFields(policy)).toEqual(["a", "b", "c", "kind"]);
  });

  it("reports every fast-lane disqualifier at once", () => {
    const result = fastLaneEligibility(
      {
        policyId: "fl-1",
        accountableApprover: "VP",
        maxTier: "low",
        disqualifiers: [{ when: { yes: "c" }, reason: "c is set" }],
      },
      { tier: "high", intakeComplete: false, answers: { c: true } },
    );
    expect(result.eligible).toBe(false);
    expect(result.reasons).toEqual(["tier is above low", "intake is not complete", "c is set"]);
  });
});
