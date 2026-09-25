/**
 * What agents hand to people, and the rules their output must pass before
 * anyone sees it. Checked in code on every run, never left to the prompt.
 */

export const DRAFT_CONCERNS = ["missing_evidence", "weak_evidence", "risk", "note"] as const;
export type DraftConcern = (typeof DRAFT_CONCERNS)[number];

export interface DraftFinding {
  /** A control on this case, or null for a concern that is not about one control. */
  readonly controlId: string | null;
  readonly concern: DraftConcern;
  readonly text: string;
}

/** An agent's draft of one domain review. A reviewer signs, edits or ignores it. */
export interface ReviewDraft {
  readonly summary: string;
  readonly findings: readonly DraftFinding[];
  readonly questionsForOwner: readonly string[];
  readonly proposedConditions: readonly string[];
}

export type IntakeAnswer = "yes" | "no" | "unsure";

export interface IntakeSuggestion {
  readonly field: string;
  readonly answer: IntakeAnswer;
  readonly why: string;
}

/**
 * Phrases that assert a decision or certify compliance. Agents may point
 * out what is missing and recommend; they may not say the system is
 * approved, cleared, compliant, or needs no further review.
 */
export const DECISION_PATTERNS: readonly RegExp[] = [
  /\b(?:approved|cleared|authori[sz]ed|certified)\s+for\s+(?:use|production|deployment|launch|release|go-live)\b/i,
  /\b(?:this|the)\s+(?:system|tool|model|assistant|agent|review|case|initiative)\s+(?:is|has\s+been|was)\s+(?:now\s+)?(?:approved|cleared|authori[sz]ed|signed\s+off)\b/i,
  /\b(?:I|we)\s+(?:hereby\s+)?(?:approve|certify|authori[sz]e|sign\s+off)\b/i,
  /\bno\s+(?:further|additional)\s+review\s+(?:is\s+)?(?:needed|required|necessary)\b/i,
  /\b(?:is|are)\s+(?:fully\s+)?(?:HIPAA[-\s])?compliant\b/i,
];

/** The first phrase that asserts a decision, or null. */
export function decisionLanguage(text: string): string | null {
  for (const pattern of DECISION_PATTERNS) {
    const match = text.match(pattern);
    if (match) return match[0];
  }
  return null;
}

const LIMITS = { summary: 1200, text: 500, findings: 12, questions: 5, conditions: 5 } as const;
const clip = (text: string, max: number) => {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean;
};
const unique = (items: readonly string[]) => [...new Set(items.filter((i) => i.length > 0))];

export type DraftCheck =
  | { readonly ok: true; readonly draft: ReviewDraft }
  | { readonly ok: false; readonly code: "decision_language" | "unknown_control" | "invalid_output"; readonly detail: string };

/**
 * Tidy a raw draft and enforce the rules: no decision language anywhere,
 * no control the case does not have, and a summary to read.
 */
export function checkDraft(raw: ReviewDraft, controlIds: readonly string[]): DraftCheck {
  const draft: ReviewDraft = {
    summary: clip(raw.summary ?? "", LIMITS.summary),
    findings: (raw.findings ?? [])
      .map((f) => ({
        controlId: f.controlId?.trim() ? f.controlId.trim().toUpperCase() : null,
        concern: DRAFT_CONCERNS.includes(f.concern) ? f.concern : "note",
        text: clip(f.text ?? "", LIMITS.text),
      }))
      .filter((f) => f.text.length > 0)
      .slice(0, LIMITS.findings),
    questionsForOwner: unique((raw.questionsForOwner ?? []).map((q) => clip(q, LIMITS.text))).slice(0, LIMITS.questions),
    proposedConditions: unique((raw.proposedConditions ?? []).map((c) => clip(c, LIMITS.text))).slice(0, LIMITS.conditions),
  };
  if (draft.summary.length === 0) return { ok: false, code: "invalid_output", detail: "the draft has no summary" };
  const unknown = draft.findings.map((f) => f.controlId).filter((id): id is string => id !== null && !controlIds.includes(id));
  if (unknown.length > 0) return { ok: false, code: "unknown_control", detail: unique(unknown).join(", ") };
  const texts = [draft.summary, ...draft.findings.map((f) => f.text), ...draft.questionsForOwner, ...draft.proposedConditions];
  for (const text of texts) {
    const phrase = decisionLanguage(text);
    if (phrase) return { ok: false, code: "decision_language", detail: phrase };
  }
  return { ok: true, draft };
}

/** The draft as a signing memo, which the reviewer starts from and edits. */
export function draftMemo(draft: ReviewDraft): string {
  const findings = draft.findings.map((f) => `- ${f.controlId ? `${f.controlId}: ` : ""}${f.text}`);
  return [draft.summary, ...(findings.length > 0 ? ["", ...findings] : [])].join("\n");
}

export type DraftUse = "none" | "not_used" | "as_drafted" | "edited";

/**
 * How a signature relates to the agent's draft, for the audit log: there
 * was none, the reviewer wrote no memo, kept the memo as drafted, or
 * changed it.
 */
export function draftUse(draft: ReviewDraft | null, memo: string): DraftUse {
  if (!draft) return "none";
  const normalize = (text: string) => text.replace(/\s+/g, " ").trim();
  if (normalize(memo) === "") return "not_used";
  return normalize(memo) === normalize(draftMemo(draft)) ? "as_drafted" : "edited";
}
