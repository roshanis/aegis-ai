import { fastLaneEligibility, referencedFields, triage, type Tier } from "@aegis/domain";
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
