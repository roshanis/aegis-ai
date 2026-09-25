import { ASSET_KINDS, TIERS, controlApplies, fastLaneEligibility, referencedFields, requiredControls, triage, type Tier } from "@aegis/domain";
import { describe, expect, it } from "vitest";
import { BUILT_IN_PACKS, financialCommunicationsPack, healthcareAiPack } from "./index";

/* Reference oracle: Jeeves' original hard-coded rules, verbatim in logic. */
interface Flags {
  phi: boolean;
  memberFacing: boolean;
  careCoverageInfluence: boolean;
  humanInLoop: boolean;
  vendorHosted: boolean;
  individualImpact: boolean;
}
function jeevesTier(f: Flags): Tier {
  if (f.careCoverageInfluence && !f.humanInLoop) return "critical";
  if (f.careCoverageInfluence && f.humanInLoop) return "high";
  if (f.phi) return "high";
  if (f.memberFacing && f.individualImpact) return "high";
  if (f.individualImpact) return "medium";
  if (f.memberFacing) return "medium";
  return "low";
}
const LOW_BASE = ["data-governance", "security"];
const MED_HIGH_BASE = ["data-governance", "security", "tech-architecture", "responsible-ai", "legal"];
const ALL = [
  "legal",
  "procurement",
  "tech-architecture",
  "responsible-ai",
  "security",
  "privacy-hipaa",
  "clinical-safety",
  "data-governance",
];
function jeevesDomains(tier: Tier, f: Flags): string[] {
  const d = new Set(tier === "low" ? LOW_BASE : tier === "critical" ? ALL : MED_HIGH_BASE);
  if (f.phi) d.add("privacy-hipaa");
  if (f.vendorHosted) {
    d.add("procurement");
    d.add("legal");
  }
  if (f.careCoverageInfluence) d.add("clinical-safety");
  return [...d].sort();
}
function jeevesFastLane(tier: Tier, complete: boolean, f: Flags): boolean {
  return tier === "low" && complete && !f.phi && !f.memberFacing && !f.careCoverageInfluence;
}

const KEYS = ["phi", "memberFacing", "careCoverageInfluence", "humanInLoop", "vendorHosted", "individualImpact"] as const;
const allFlagCombos: Flags[] = Array.from({ length: 1 << KEYS.length }, (_, n) =>
  Object.fromEntries(KEYS.map((k, i) => [k, Boolean(n & (1 << i))])) as unknown as Flags,
);

describe("healthcare-ai pack", () => {
  it("matches Jeeves' tiers, domains and fast lane for all 64 answer combinations", () => {
    for (const flags of allFlagCombos) {
      const result = triage(healthcareAiPack.triage, { ...flags });
      const tier = jeevesTier(flags);
      expect(result.tier, JSON.stringify(flags)).toBe(tier);
      expect(result.domains, JSON.stringify(flags)).toEqual(jeevesDomains(tier, flags));
      for (const complete of [true, false]) {
        const fast = fastLaneEligibility(healthcareAiPack.fastLane, { tier, intakeComplete: complete, answers: { ...flags } });
        expect(fast.eligible).toBe(jeevesFastLane(tier, complete, flags));
      }
    }
  });

  it("asks a question for every field its rules read", () => {
    const asked = healthcareAiPack.questions.map((q) => q.field).sort();
    expect(referencedFields(healthcareAiPack.triage)).toEqual(asked);
  });

  it("only routes to domains it defines", () => {
    const defined = Object.keys(healthcareAiPack.domains);
    const used = [
      ...Object.values(healthcareAiPack.triage.baseDomains).flat(),
      ...healthcareAiPack.triage.domainRules.flatMap((r) => r.add),
    ];
    expect(used.filter((d) => !defined.includes(d))).toEqual([]);
  });
});

/* Reference oracle: Jeeves' control applicability strings (lib/services/applicability.ts). */
const JEEVES_APPLICABILITY: Record<string, string> = {
  "L-01": "vendor=Y",
  "L-02": "member-facing=Y",
  "P-01": "vendor=Y",
  "P-02": "vendor=Y",
  "T-01": "tier>=medium",
  "T-02": "tier>=high",
  "R-01": "member-facing=Y or care-coverage=Y",
  "R-02": "tier>=medium",
  "S-01": "tier>=high",
  "S-02": "all",
  "H-01": "PHI=Y",
  "H-02": "PHI=Y and vendor=Y",
  "C-01": "care-coverage=Y",
  "C-02": "care-coverage=Y",
  "D-01": "tier>=medium",
  "D-02": "PHI=Y",
};
function jeevesApplies(applicability: string, tier: Tier, f: Flags): boolean {
  const atom = (a: string): boolean => {
    if (a === "all") return true;
    if (a === "vendor=Y") return f.vendorHosted;
    if (a === "member-facing=Y") return f.memberFacing;
    if (a === "care-coverage=Y") return f.careCoverageInfluence;
    if (a === "PHI=Y") return f.phi;
    const min = a.match(/^tier>=(\w+)$/)?.[1] as Tier;
    return TIERS.indexOf(tier) >= TIERS.indexOf(min);
  };
  if (applicability.includes(" or ")) return applicability.split(" or ").some(atom);
  if (applicability.includes(" and ")) return applicability.split(" and ").every(atom);
  return atom(applicability);
}

describe("healthcare-ai controls", () => {
  it("carries Jeeves' review-time catalog and applies it identically for every tier and answer combination", () => {
    expect(healthcareAiPack.controls.map((c) => c.id).sort()).toEqual(Object.keys(JEEVES_APPLICABILITY).sort());
    for (const control of healthcareAiPack.controls) {
      for (const tier of TIERS) {
        for (const flags of allFlagCombos) {
          expect(controlApplies(control, tier, { ...flags }), `${control.id} ${tier} ${JSON.stringify(flags)}`).toBe(
            jeevesApplies(JEEVES_APPLICABILITY[control.id]!, tier, flags),
          );
        }
      }
    }
  });

  it("assigns every control to a domain the pack defines, and reads only asked questions", () => {
    const asked = new Set(healthcareAiPack.questions.map((q) => q.field));
    for (const control of healthcareAiPack.controls) {
      expect(Object.keys(healthcareAiPack.domains)).toContain(control.domain);
      const fields = referencedFields({ tierRules: [{ id: "x", when: control.when, tier: "low", because: "" }], defaultTier: "low", baseDomains: { low: [], medium: [], high: [], critical: [] }, domainRules: [] });
      expect(fields.filter((f) => !asked.has(f))).toEqual([]);
    }
  });
});

describe("healthcare-ai golden sets", () => {
  const sets = healthcareAiPack.goldenSets!;
  const fields = healthcareAiPack.questions.map((q) => q.field);

  it("score only questions the pack asks, with unique case ids", () => {
    for (const set of [sets.intake, sets.reviewDrafter]) {
      const ids = set.cases.map((c) => c.id);
      expect(new Set(ids).size, set.id).toBe(ids.length);
      expect(set.threshold).toBeGreaterThan(0);
      expect(set.threshold).toBeLessThanOrEqual(1);
    }
    for (const c of sets.intake.cases) {
      expect(Object.keys(c.expected).filter((f) => !fields.includes(f)), c.id).toEqual([]);
      expect(Object.keys(c.expected).length, c.id).toBeGreaterThanOrEqual(3);
    }
  });

  it("include intake cases that land in the critical, high and low tiers", () => {
    const tiers = sets.intake.cases.map((c) => triage(healthcareAiPack.triage, c.expected).tier);
    expect(tiers).toEqual(expect.arrayContaining(["critical", "high", "low"]));
  });

  it("draft only domains triage requires, against controls the case really has", () => {
    for (const c of sets.reviewDrafter.cases) {
      expect(fields.every((f) => typeof c.answers[f] === "boolean"), c.id).toBe(true);
      expect(ASSET_KINDS).toContain(c.asset.kind);
      const result = triage(healthcareAiPack.triage, c.answers);
      expect(result.domains, c.id).toContain(c.domain);
      const inDomain = requiredControls(healthcareAiPack.controls, result, c.answers)
        .filter((control) => control.domain === c.domain)
        .map((control) => control.id);
      expect(inDomain.length, c.id).toBeGreaterThan(0);
      expect(Object.keys(c.evidence).filter((id) => !inDomain.includes(id)), c.id).toEqual([]);
      expect((c.exceptions ?? []).filter((id) => !inDomain.includes(id)), c.id).toEqual([]);
    }
  });

  it("include drafts with a gate control missing and drafts with every gate covered", () => {
    const gaps = sets.reviewDrafter.cases.map((c) => {
      const result = triage(healthcareAiPack.triage, c.answers);
      return requiredControls(healthcareAiPack.controls, result, c.answers).filter(
        (control) =>
          control.domain === c.domain &&
          control.enforcement === "gate" &&
          !(control.id in c.evidence) &&
          !(c.exceptions ?? []).includes(control.id),
      ).length;
    });
    expect(gaps.filter((n) => n > 0).length).toBeGreaterThanOrEqual(3);
    expect(gaps.filter((n) => n === 0).length).toBeGreaterThanOrEqual(3);
  });
});

describe("financial-communications pack", () => {
  it("only tags criteria with markets it supports", () => {
    const tagged = financialCommunicationsPack.rubric.criteria.flatMap((c) => c.jurisdictions ?? []);
    expect(tagged.filter((m) => !financialCommunicationsPack.markets.includes(m))).toEqual([]);
  });
});

describe("built-in packs", () => {
  it("have unique ids and semantic versions", () => {
    const ids = BUILT_IN_PACKS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const pack of BUILT_IN_PACKS) expect(pack.version).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
