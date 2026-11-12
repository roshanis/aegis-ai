import {
  decideVerdict,
  sliceRubric,
  verdictsByJurisdiction,
  type Coverage,
  type Criterion,
  type Finding,
  type Rubric,
  type Verdict,
} from "./verdict";

/**
 * Checking a member communication against a content pack's rubric, in
 * code. Criteria with a text rule are checked here; the rest are marked
 * "uncertain" so the verdict can never be "pass" until a person (or, later,
 * a model whose work a person checks) has covered them. Same document, same
 * pack, same result, every time.
 */

/** Longest communication Aegis checks, in characters. */
export const MAX_COMMUNICATION = 40_000;

export interface CheckResult {
  readonly findings: readonly Finding[];
  readonly coverage: readonly Coverage[];
  readonly verdict: Verdict;
  readonly byMarket: readonly { readonly jurisdiction: string; readonly verdict: Verdict }[];
}

const compile = (source: string) => new RegExp(source, "iu");

/** The sentence around a match, trimmed to a readable quote that appears verbatim in the text. */
function quoteAround(text: string, index: number, length: number): string {
  const before = text.lastIndexOf("\n", index);
  const after = text.indexOf("\n", index + length);
  let start = before === -1 ? 0 : before + 1;
  let end = after === -1 ? text.length : after;
  const sentenceStart = Math.max(text.lastIndexOf(". ", index), text.lastIndexOf("! ", index), text.lastIndexOf("? ", index));
  if (sentenceStart + 2 > start && sentenceStart + 2 <= index) start = sentenceStart + 2;
  const stop = text.slice(index + length, end).search(/[.!?](\s|$)/);
  if (stop !== -1) end = index + length + stop + 1;
  const quote = text.slice(start, end).trim();
  if (quote.length <= 240) return quote;
  // Keep the match itself in view.
  const from = Math.max(0, index - 80);
  return text.slice(from, Math.min(text.length, index + length + 80)).trim();
}

function checkOne(criterion: Criterion, text: string): { finding: Finding | null; status: Coverage["status"] } {
  const rule = criterion.check;
  if (!rule) return { finding: null, status: "uncertain" };
  if (rule.when && !compile(rule.when).test(text)) return { finding: null, status: "not_applicable" };
  const confidence = rule.confidence ?? "high";
  const base = {
    criterionId: criterion.id,
    severity: criterion.severity,
    recommendation: criterion.recommendation ?? criterion.description,
    confidence,
  } as const;
  for (const source of rule.forbids ?? []) {
    const match = compile(source).exec(text);
    if (match) {
      return {
        finding: { ...base, quote: quoteAround(text, match.index, match[0].length), explanation: `Says “${match[0]}”.` },
        status: "finding",
      };
    }
  }
  const missing = (rule.requires ?? []).filter((source) => !compile(source).test(text));
  if (missing.length > 0) {
    return {
      finding: { ...base, quote: "", explanation: "The required language is missing." },
      status: "finding",
    };
  }
  return { finding: null, status: "checked" };
}

/** Check a communication for the chosen markets. */
export function checkCommunication(rubric: Rubric, text: string, markets: readonly string[]): CheckResult {
  const sliced = sliceRubric(rubric, markets);
  const findings: Finding[] = [];
  const coverage: Coverage[] = [];
  for (const criterion of sliced.criteria) {
    const { finding, status } = checkOne(criterion, text);
    if (finding) findings.push(finding);
    coverage.push({ criterionId: criterion.id, status });
  }
  return {
    findings,
    coverage,
    verdict: decideVerdict(findings, sliced, coverage),
    byMarket: verdictsByJurisdiction(findings, sliced, markets, coverage),
  };
}

/** Every pattern in a rubric compiles; a pack with a broken rule is refused before anyone relies on it. */
export function rubricProblems(rubric: Rubric): string[] {
  const problems: string[] = [];
  for (const c of rubric.criteria) {
    for (const source of [c.check?.when, ...(c.check?.requires ?? []), ...(c.check?.forbids ?? [])]) {
      if (source === undefined) continue;
      try {
        compile(source);
      } catch {
        problems.push(`${c.id}: not a valid pattern: ${source}`);
      }
    }
    if (c.check && !c.check.requires?.length && !c.check.forbids?.length) problems.push(`${c.id}: a check needs requires or forbids`);
  }
  return problems;
}
