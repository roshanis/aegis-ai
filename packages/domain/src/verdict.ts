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

/** Per-market verdicts: a finding counts in every market its criterion applies to. */
export function verdictsByJurisdiction(
  findings: readonly Finding[],
  rubric: Rubric,
  jurisdictions: readonly string[],
): { jurisdiction: string; verdict: Verdict }[] {
  const byId = new Map(rubric.criteria.map((c) => [c.id, c]));
  return jurisdictions.map((jurisdiction) => ({
    jurisdiction,
    verdict: decideVerdict(
      findings.filter((f) => {
        const criterion = byId.get(f.criterionId);
        return criterion && (!criterion.jurisdictions || criterion.jurisdictions.includes(jurisdiction));
      }),
      rubric,
    ),
  }));
}
