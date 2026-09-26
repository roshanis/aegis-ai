/**
 * The requester's own words as the intake sentence's purpose clause: their
 * first sentence, its first verb read as "to …" ("Summarizes letters"
 * becomes "summarize letters"), kept short. For display only; nothing here
 * is saved or read by triage.
 */
export function asPurpose(text: string): string {
  const first = (text.trim().split(/(?<=[.!?])\s/)[0] ?? "").replace(/[.!?\s]+$/, "");
  if (!first) return "";
  const [verb = "", ...rest] = first.split(/\s+/);
  const lower = verb.charAt(0).toLowerCase() + verb.slice(1);
  const base = /ies$/.test(lower)
    ? lower.replace(/ies$/, "y")
    : /(ch|sh|x|ss)es$/.test(lower)
      ? lower.replace(/es$/, "")
      : /[^s]s$/.test(lower)
        ? lower.slice(0, -1)
        : lower;
  const clause = [base, ...rest].join(" ");
  return clause.length > 90 ? `${clause.slice(0, 90).replace(/\s+\S*$/, "")}…` : clause;
}
