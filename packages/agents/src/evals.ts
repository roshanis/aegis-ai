import type { ModelProvider } from "@openai/agents-core";
import { TIERS, triage, type IntakeSuggestion, type ReviewDraft } from "@aegis/domain";
import type { DraftGoldenCase, GoldenSet, InitiativePack, IntakeGoldenCase } from "@aegis/frameworks";
import type { AgentId } from "./catalog";
import { buildDraftContext, draftReview, type DraftContext } from "./drafter";
import { AgentFailure, classifyFailure } from "./errors";
import { suggestIntake } from "./intake";
import type { RunOptions } from "./run";

/**
 * The golden-set gate. Each case is run through the same code path as
 * production and graded in code. A critical failure on any case fails the
 * whole set, whatever the score: an intake suggestion that would have
 * under-triaged a case, or a draft that asserts a decision, cites a control
 * the case does not have, or misses a gate control with nothing on file.
 */

export interface EvalCaseResult {
  readonly caseId: string;
  readonly passed: boolean;
  /** 0 to 1. */
  readonly score: number;
  /** Codes that fail the set on their own, such as "under_triage" or "missed_gate:R-01". */
  readonly critical: readonly string[];
  /** Codes that cost score, such as "wrong:phi" or "no_question". */
  readonly misses: readonly string[];
}

export interface EvalSummary {
  readonly total: number;
  readonly score: number;
  readonly criticalFailures: number;
  readonly passed: boolean;
}

export type AnyGoldenSet = GoldenSet<IntakeGoldenCase> | GoldenSet<DraftGoldenCase>;

export function goldenSetFor(pack: InitiativePack, agent: AgentId): AnyGoldenSet | null {
  const sets = pack.goldenSets;
  if (!sets) return null;
  return agent === "intake" ? sets.intake : sets.reviewDrafter;
}

/** Identifies the exact golden set an evaluation ran, e.g. "healthcare-ai/intake@1". */
export const goldenSetKey = (set: AnyGoldenSet) => `${set.id}@${set.version}`;

const rank = (tier: string) => TIERS.indexOf(tier as (typeof TIERS)[number]);

export function gradeIntake(pack: InitiativePack, c: IntakeGoldenCase, suggestions: readonly IntakeSuggestion[], threshold: number): EvalCaseResult {
  const byField = new Map(suggestions.map((s) => [s.field, s.answer]));
  const misses: string[] = [];
  let points = 0;
  const expected = Object.entries(c.expected);
  for (const [field, want] of expected) {
    const got = byField.get(field) ?? "unsure";
    if (got === "unsure") {
      points += 0.5;
      misses.push(`unsure:${field}`);
    } else if ((got === "yes") === want) {
      points += 1;
    } else {
      misses.push(`wrong:${field}`);
    }
  }
  // Would a requester who kept every confident suggestion have landed lower
  // than the truth? Unsure answers are left to the person, so they count as right.
  const truth: Record<string, boolean> = {};
  const kept: Record<string, boolean> = {};
  for (const q of pack.questions) {
    const got = byField.get(q.field) ?? "unsure";
    truth[q.field] = c.expected[q.field] ?? got === "yes";
    kept[q.field] = got === "unsure" ? truth[q.field]! : got === "yes";
  }
  const right = triage(pack.triage, truth);
  const suggested = triage(pack.triage, kept);
  const critical =
    rank(suggested.tier) < rank(right.tier) || right.domains.some((d) => !suggested.domains.includes(d)) ? ["under_triage"] : [];
  const score = expected.length === 0 ? 1 : points / expected.length;
  return { caseId: c.id, passed: critical.length === 0 && score >= threshold, score, critical, misses };
}

export function gradeDraft(context: DraftContext, c: DraftGoldenCase, draft: ReviewDraft, threshold: number): EvalCaseResult {
  const critical: string[] = [];
  const misses: string[] = [];
  const flagged = (id: string) => draft.findings.some((f) => f.controlId === id && f.concern === "missing_evidence");
  for (const control of context.controls) {
    const bare = control.evidence.length === 0 && control.exception !== "approved";
    if (control.enforcement === "gate" && bare && !flagged(control.id)) critical.push(`missed_gate:${control.id}`);
  }
  let checks = 1;
  let passedChecks = 0;
  const contradicted = context.controls.filter((control) => control.evidence.length > 0 && flagged(control.id));
  if (contradicted.length === 0) passedChecks++;
  else misses.push(...contradicted.map((control) => `contradicts_evidence:${control.id}`));
  if (c.asksOwner) {
    checks++;
    if (draft.questionsForOwner.length > 0) passedChecks++;
    else misses.push("no_question");
  }
  const score = passedChecks / checks;
  return { caseId: c.id, passed: critical.length === 0 && score >= threshold, score, critical, misses };
}

const failed = (caseId: string, error: unknown): EvalCaseResult => ({
  caseId,
  passed: false,
  score: 0,
  critical: [classifyFailure(error).code],
  misses: [],
});

/** Run and grade one golden case. Model failures are results, not exceptions, except ones worth retrying. */
export async function evalCase(
  agent: AgentId,
  provider: ModelProvider,
  model: string,
  pack: InitiativePack,
  caseId: string,
  options: RunOptions & { readonly throwTransient?: boolean } = {},
): Promise<EvalCaseResult> {
  const set = goldenSetFor(pack, agent);
  if (!set) throw new AgentFailure("bad_request", `the ${pack.id} pack has no golden set for ${agent}`);
  try {
    if (agent === "intake") {
      const c = (set as GoldenSet<IntakeGoldenCase>).cases.find((x) => x.id === caseId);
      if (!c) throw new AgentFailure("bad_request", `no golden case ${caseId}`);
      const { suggestions } = await suggestIntake(provider, model, pack.questions, c.description, options);
      return gradeIntake(pack, c, suggestions, set.threshold);
    }
    const c = (set as GoldenSet<DraftGoldenCase>).cases.find((x) => x.id === caseId);
    if (!c) throw new AgentFailure("bad_request", `no golden case ${caseId}`);
    const context = buildDraftContext(pack, {
      asset: c.asset,
      answers: c.answers,
      domain: c.domain,
      evidence: c.evidence,
      exceptions: Object.fromEntries((c.exceptions ?? []).map((id) => [id, "approved" as const])),
      thread: c.thread ?? null,
    });
    const { draft } = await draftReview(provider, model, context, options);
    return gradeDraft(context, c, draft, set.threshold);
  } catch (error) {
    const failure = classifyFailure(error);
    if (options.throwTransient && failure.transient) throw failure;
    if (failure.code === "bad_request" && error instanceof AgentFailure && /golden/.test(error.message)) throw error;
    return failed(caseId, failure);
  }
}

export function summarize(set: Pick<AnyGoldenSet, "threshold">, results: readonly EvalCaseResult[]): EvalSummary {
  const total = results.length;
  const score = total === 0 ? 0 : results.reduce((sum, r) => sum + r.score, 0) / total;
  const criticalFailures = results.filter((r) => r.critical.length > 0).length;
  return { total, score, criticalFailures, passed: total > 0 && criticalFailures === 0 && score >= set.threshold };
}
