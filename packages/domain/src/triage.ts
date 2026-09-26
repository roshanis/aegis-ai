/**
 * Deterministic triage driven by policy packs.
 *
 * Jeeves hard-coded its tier rules in TypeScript. Here the same logic is
 * data: a pack lists ordered tier rules (first match wins), base review
 * domains per tier, and flag-driven domain additions. Tenants can adopt,
 * fork and version packs without a deploy. No LLM is involved in triage;
 * every result explains which rule fired so the requester sees why.
 */

export const TIERS = ["low", "medium", "high", "critical"] as const;
export type Tier = (typeof TIERS)[number];

export type Answers = Readonly<Record<string, unknown>>;

export type Condition =
  | { readonly all: readonly Condition[] }
  | { readonly any: readonly Condition[] }
  | { readonly not: Condition }
  | { readonly yes: string }
  | { readonly equals: readonly [field: string, value: string | number | boolean] };

export interface TierRule {
  readonly id: string;
  readonly when: Condition;
  readonly tier: Tier;
  /** Plain-language reason shown to the requester. */
  readonly because: string;
}

export interface DomainRule {
  readonly when: Condition;
  readonly add: readonly string[];
  readonly because: string;
}

export interface TriagePolicy {
  readonly tierRules: readonly TierRule[];
  /** Tier used when no rule matches. */
  readonly defaultTier: Tier;
  readonly baseDomains: Readonly<Record<Tier, readonly string[]>>;
  readonly domainRules: readonly DomainRule[];
}

export interface TriageResult {
  readonly tier: Tier;
  readonly tierRuleId: string | null;
  readonly domains: readonly string[];
  /** Ordered, human-readable explanation of every rule that shaped the result. */
  readonly explanation: readonly string[];
}

export function evaluate(condition: Condition, answers: Answers): boolean {
  if ("all" in condition) return condition.all.every((c) => evaluate(c, answers));
  if ("any" in condition) return condition.any.some((c) => evaluate(c, answers));
  if ("not" in condition) return !evaluate(condition.not, answers);
  if ("yes" in condition) return answers[condition.yes] === true;
  const [field, value] = condition.equals;
  return answers[field] === value;
}

/** `labels` names review domains in the explanation, e.g. "privacy-hipaa" as "Privacy / HIPAA". */
export function triage(
  policy: TriagePolicy,
  answers: Answers,
  labels: Readonly<Record<string, string>> = {},
): TriageResult {
  const matched = policy.tierRules.find((rule) => evaluate(rule.when, answers));
  const tier = matched?.tier ?? policy.defaultTier;
  const explanation = [
    matched ? `${tier} tier: ${matched.because}` : `${tier} tier: no risk rule matched`,
  ];

  const domains = new Set(policy.baseDomains[tier]);
  for (const rule of policy.domainRules) {
    if (!evaluate(rule.when, answers)) continue;
    const added = rule.add.filter((d) => !domains.has(d));
    rule.add.forEach((d) => domains.add(d));
    if (added.length > 0) explanation.push(`adds ${added.map((d) => labels[d] ?? d).join(", ")}: ${rule.because}`);
  }

  return { tier, tierRuleId: matched?.id ?? null, domains: [...domains].sort(), explanation };
}

/** Every field a policy reads; intake forms use this to know what to ask. */
export function referencedFields(policy: TriagePolicy): string[] {
  const fields = new Set<string>();
  const walk = (c: Condition): void => {
    if ("all" in c) c.all.forEach(walk);
    else if ("any" in c) c.any.forEach(walk);
    else if ("not" in c) walk(c.not);
    else if ("yes" in c) fields.add(c.yes);
    else fields.add(c.equals[0]);
  };
  policy.tierRules.forEach((r) => walk(r.when));
  policy.domainRules.forEach((r) => walk(r.when));
  return [...fields].sort();
}

/* ---------------------------------------------------------------------------
 * Fast lane (from Jeeves): low-risk work skips full review under a
 * pre-approved policy that still names an accountable person.
 * ------------------------------------------------------------------------ */

export interface FastLanePolicy {
  readonly policyId: string;
  readonly accountableApprover: string;
  readonly maxTier: Tier;
  /** Answers that disqualify the fast lane, each with the reason to show. */
  readonly disqualifiers: readonly { readonly when: Condition; readonly reason: string }[];
}

export interface FastLaneResult {
  readonly eligible: boolean;
  /** Every failed criterion, so the requester sees everything to change. */
  readonly reasons: readonly string[];
  readonly policyId: string;
  readonly accountableApprover: string;
}

export function fastLaneEligibility(
  policy: FastLanePolicy,
  input: { readonly tier: Tier; readonly intakeComplete: boolean; readonly answers: Answers },
): FastLaneResult {
  const reasons: string[] = [];
  if (TIERS.indexOf(input.tier) > TIERS.indexOf(policy.maxTier)) {
    reasons.push(`tier is above ${policy.maxTier}`);
  }
  if (!input.intakeComplete) reasons.push("intake is not complete");
  for (const d of policy.disqualifiers) {
    if (evaluate(d.when, input.answers)) reasons.push(d.reason);
  }
  return {
    eligible: reasons.length === 0,
    reasons,
    policyId: policy.policyId,
    accountableApprover: policy.accountableApprover,
  };
}
