/**
 * Content-review verdict rules, ported from Cleared. Applied in code, never
 * by the model:
 * - a high-confidence finding at a fail-level severity fails the document
 * - any other finding routes to a person; the agent never guesses "pass"
 *   when it found something
 * - no findings passes, but only if every criterion was actually checked
 */

export const SEVERITIES = ["critical", "major", "minor"] as const;
export type Severity = (typeof SEVERITIES)[number];

export const VERDICTS = ["pass", "fail", "needs_human_review"] as const;
export type Verdict = (typeof VERDICTS)[number];

export interface Criterion {
  readonly id: string;
  readonly severity: Severity;
  readonly description: string;
  /** Markets this criterion applies to; absent means every market. */
  readonly jurisdictions?: readonly string[];
  /** A short name for screens, e.g. "Federal contracting statement". */
  readonly title?: string;
  /** What the writer should do when the criterion is not met. */
  readonly recommendation?: string;
  /** A rule Aegis can check in code. Without one, a person (or a model) has to check it. */
  readonly check?: CriterionCheck;
}

/**
 * A text rule, as data. Patterns are regular expression sources, matched
 * case-insensitively. `requires` means every pattern must appear; `forbids`
 * means none may. `when` limits the rule to documents that match it, such
 * as a disclaimer required only when Star Ratings are mentioned. A rule
 * that cannot tell for sure says so with confidence "low", and a person
 * decides.
 */
export interface CriterionCheck {
  readonly when?: string;
  readonly requires?: readonly string[];
  readonly forbids?: readonly string[];
  readonly confidence?: "high" | "low";
}

export interface Rubric {
  readonly criteria: readonly Criterion[];
  readonly failOn: readonly Severity[];
}

export interface Finding {
  readonly criterionId: string;
  readonly severity: Severity;
  /** Exact source text, or empty when the finding is about missing language. */
  readonly quote: string;
  readonly explanation: string;
  readonly recommendation: string;
  readonly confidence?: "high" | "low";
}

export type CoverageStatus = "checked" | "finding" | "not_applicable" | "uncertain" | "unsupported" | "omitted";

export interface Coverage {
  readonly criterionId: string;
  readonly status: CoverageStatus;
}

export function decideVerdict(
  findings: readonly Finding[],
  rubric: Pick<Rubric, "failOn">,
  coverage?: readonly Coverage[],
): Verdict {
  const failing = findings.filter((f) => rubric.failOn.includes(f.severity));
  if (failing.some((f) => (f.confidence ?? "high") === "high")) return "fail";
  if (findings.length > 0) return "needs_human_review";
  // Zero findings only means pass when the reviewer actually covered every rule.
  if (coverage?.some((c) => c.status === "uncertain" || c.status === "unsupported" || c.status === "omitted")) {
    return "needs_human_review";
  }
  return "pass";
}

/** Keep only the criteria that apply to the selected markets. */
export function sliceRubric(rubric: Rubric, jurisdictions: readonly string[]): Rubric {
  return {
    ...rubric,
    criteria: rubric.criteria.filter(
      (c) => !c.jurisdictions || c.jurisdictions.some((j) => jurisdictions.includes(j)),
    ),
  };
}

const rank: Record<Verdict, number> = { fail: 0, needs_human_review: 1, pass: 2 };

export function worstVerdict(verdicts: readonly Verdict[]): Verdict {
  return verdicts.reduce<Verdict>((worst, v) => (rank[v] < rank[worst] ? v : worst), "pass");
}

/** Per-market verdicts: a finding, or a criterion nobody could check, counts in every market its criterion applies to. */
export function verdictsByJurisdiction(
  findings: readonly Finding[],
  rubric: Rubric,
  jurisdictions: readonly string[],
  coverage?: readonly Coverage[],
): { jurisdiction: string; verdict: Verdict }[] {
  const byId = new Map(rubric.criteria.map((c) => [c.id, c]));
  const inMarket = (id: string, jurisdiction: string) => {
    const criterion = byId.get(id);
    return criterion !== undefined && (!criterion.jurisdictions || criterion.jurisdictions.includes(jurisdiction));
  };
  return jurisdictions.map((jurisdiction) => ({
    jurisdiction,
    verdict: decideVerdict(
      findings.filter((f) => inMarket(f.criterionId, jurisdiction)),
      rubric,
      coverage?.filter((c) => inMarket(c.criterionId, jurisdiction)),
    ),
  }));
}
