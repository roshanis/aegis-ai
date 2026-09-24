import type { InitiativePack } from "./types";

/**
 * AI initiative governance for healthcare payers. Rules ported one-for-one
 * from Jeeves (lib/triage/rules.ts, lib/triage/routing.ts,
 * lib/approval/eligibility.ts); the equivalence test proves it.
 */
export const healthcareAiPack: InitiativePack = {
  kind: "initiative",
  id: "healthcare-ai",
  version: "1.0.0",
  title: "Healthcare AI initiatives",
  summary: "Risk tiers and review routing for AI that touches members, PHI, or care and coverage decisions.",
  frameworkRefs: ["NIST AI RMF 1.0", "HIPAA Privacy Rule", "ISO/IEC 42001", "EU AI Act (Annex III)"],
  questions: [
    { field: "phi", label: "Does it use protected health information?", help: "Any PHI, including de-identified data that could be re-identified." },
    { field: "memberFacing", label: "Will members see or interact with it?", help: "Chat, letters, portals, or anything a member receives." },
    { field: "careCoverageInfluence", label: "Could it influence care or coverage decisions?", help: "Prior auth, claims, care management, eligibility." },
    { field: "humanInLoop", label: "Does a person review every output before it takes effect?", help: "A qualified person, not spot checks." },
    { field: "vendorHosted", label: "Is the model or service hosted by a vendor?", help: "Any third-party API or SaaS." },
    { field: "individualImpact", label: "Could it materially affect an individual?", help: "Money, access, health, or reputation." },
  ],
  domains: {
    legal: "Legal",
    procurement: "Procurement",
    "tech-architecture": "Tech Architecture",
    "responsible-ai": "Responsible AI",
    security: "Security",
    "privacy-hipaa": "Privacy / HIPAA",
    "clinical-safety": "Clinical Safety",
    "data-governance": "Data Governance",
  },
  triage: {
    tierRules: [
      {
        id: "care-without-human",
        when: { all: [{ yes: "careCoverageInfluence" }, { not: { yes: "humanInLoop" } }] },
        tier: "critical",
        because: "influences care or coverage with no person reviewing each output",
      },
      {
        id: "care-with-human",
        when: { all: [{ yes: "careCoverageInfluence" }, { yes: "humanInLoop" }] },
        tier: "high",
        because: "influences care or coverage, with a person reviewing each output",
      },
      { id: "phi", when: { yes: "phi" }, tier: "high", because: "uses protected health information" },
      {
        id: "member-impact",
        when: { all: [{ yes: "memberFacing" }, { yes: "individualImpact" }] },
        tier: "high",
        because: "member-facing and can materially affect individuals",
      },
      { id: "individual-impact", when: { yes: "individualImpact" }, tier: "medium", because: "can materially affect individuals" },
      { id: "member-facing", when: { yes: "memberFacing" }, tier: "medium", because: "members see or interact with it" },
    ],
    defaultTier: "low",
    baseDomains: {
      low: ["data-governance", "security"],
      medium: ["data-governance", "security", "tech-architecture", "responsible-ai", "legal"],
      high: ["data-governance", "security", "tech-architecture", "responsible-ai", "legal"],
      critical: [
        "legal",
        "procurement",
        "tech-architecture",
        "responsible-ai",
        "security",
        "privacy-hipaa",
        "clinical-safety",
        "data-governance",
      ],
    },
    domainRules: [
      { when: { yes: "phi" }, add: ["privacy-hipaa"], because: "uses PHI" },
      { when: { yes: "vendorHosted" }, add: ["procurement", "legal"], because: "vendor-hosted" },
      { when: { yes: "careCoverageInfluence" }, add: ["clinical-safety"], because: "influences care or coverage" },
    ],
  },
  fastLane: {
    policyId: "healthcare-ai/fast-lane/v1",
    accountableApprover: "VP, AI Governance",
    maxTier: "low",
    disqualifiers: [
      { when: { yes: "phi" }, reason: "initiative touches PHI" },
      { when: { yes: "memberFacing" }, reason: "initiative is member-facing" },
      { when: { yes: "careCoverageInfluence" }, reason: "initiative influences care or coverage decisions" },
    ],
  },
};
