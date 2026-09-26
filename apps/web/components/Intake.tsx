"use client";

import { fastLaneEligibility, triage, type AssetKind, type IntakeSuggestion } from "@aegis/domain";
import type { InitiativePack, IntakeQuestion } from "@aegis/frameworks";
import { Fragment, startTransition, useActionState, useEffect, useMemo, useState } from "react";
import { registerAndSubmit, submitIntake, suggestAnswers, type SuggestState } from "@/app/(console)/registry/actions";
import { IDLE } from "@/lib/action-state";
import { ASSET_KIND, becauseText, plural } from "@/lib/labels";
import { asPurpose } from "@/lib/purpose";
import { Meter, TIER_NAME } from "./ds";

type Mode = { kind: "register" } | { kind: "case"; caseId: string; previous: Record<string, unknown> };

const KINDS: { kind: AssetKind; available: boolean }[] = [
  { kind: "ai_system", available: true },
  { kind: "agent", available: true },
  { kind: "vendor_model", available: true },
  { kind: "content_item", available: false },
];

const NO_SUGGESTIONS: SuggestState = { error: null };

/**
 * The intake assistant's suggestions. It fills in only what the requester
 * has not answered, marks what it filled, and the requester submits every
 * answer themselves.
 */
function useSuggestions(setAnswers: (update: (answers: Record<string, boolean>) => Record<string, boolean>) => void) {
  const [state, dispatch, pending] = useActionState(suggestAnswers, NO_SUGGESTIONS);
  // What was answered when the assistant was asked, and what the requester changed since: neither counts as its work.
  const [before, setBefore] = useState<ReadonlySet<string>>(new Set());
  const [touched, setTouched] = useState<ReadonlySet<string>>(new Set());
  const suggestions = useMemo(
    () => new Map<string, IntakeSuggestion>(state.runId ? state.suggestions.map((s) => [s.field, s]) : []),
    [state],
  );
  useEffect(() => {
    if (!state.runId) return;
    setTouched(new Set());
    setAnswers((answers) => {
      const next = { ...answers };
      for (const s of state.suggestions) {
        if (typeof next[s.field] !== "boolean" && s.answer !== "unsure") next[s.field] = s.answer === "yes";
      }
      return next;
    });
  }, [state, setAnswers]);
  const filled = new Set(
    state.runId
      ? state.suggestions.filter((s) => s.answer !== "unsure" && !before.has(s.field) && !touched.has(s.field)).map((s) => s.field)
      : [],
  );
  const ask = (description: string, answered: readonly string[]) => {
    setBefore(new Set(answered));
    const form = new FormData();
    form.set("description", description);
    startTransition(() => dispatch(form));
  };
  return {
    ask,
    pending,
    error: state.error,
    runId: state.runId ?? null,
    suggestions,
    filled,
    clear: (field: string) => setTouched((t) => new Set([...t, field])),
  };
}

/**
 * Filing a system as one sentence. Each highlighted phrase answers one of
 * the policy pack's questions; select it to change it. Triage runs here
 * with the pack's own rules as the requester writes, and again on the
 * server when they submit. Rules set the tier, never AI.
 */
export function Intake({
  pack,
  mode,
  assistant = false,
}: {
  pack: InitiativePack;
  mode: Mode;
  assistant?: boolean;
}) {
  const [state, action, pending] = useActionState(mode.kind === "register" ? registerAndSubmit : submitIntake, IDLE);
  const [name, setName] = useState("");
  const [assetKind, setAssetKind] = useState<AssetKind>("ai_system");
  const [purpose, setPurpose] = useState("");
  const [view, setView] = useState<"sentence" | "questions">(pack.sentence ? "sentence" : "questions");
  const [answers, setAnswers] = useState<Record<string, boolean>>(() =>
    mode.kind === "case"
      ? Object.fromEntries(Object.entries(mode.previous).filter((entry): entry is [string, boolean] => typeof entry[1] === "boolean"))
      : {},
  );
  const suggest = useSuggestions(setAnswers);

  const answer = (field: string, value: boolean) => {
    suggest.clear(field);
    setAnswers((a) => ({ ...a, [field]: value }));
  };
  const left = pack.questions.filter((q) => typeof answers[q.field] !== "boolean");
  const complete = left.length === 0;
  const result = useMemo(() => triage(pack.triage, answers, pack.domains), [pack, answers]);
  const fastLane = fastLaneEligibility(pack.fastLane, { tier: result.tier, intakeComplete: complete, answers });
  const ready = complete && (mode.kind === "case" || name.trim().length > 0);
  const domains = result.domains.map((d) => pack.domains[d] ?? d).sort();

  return (
    <form action={action} className="stack" style={{ gap: 36 }}>
      <input type="hidden" name="answers" value={JSON.stringify(answers)} />
      {suggest.runId ? <input type="hidden" name="suggestionRunId" value={suggest.runId} /> : null}
      {mode.kind === "case" ? <input type="hidden" name="caseId" value={mode.caseId} /> : null}

      <div className="intake-top">
        {mode.kind === "register" ? (
          <div className="stack" style={{ gap: 18 }}>
            <div className="field">
              <label htmlFor="name">What is it called?</label>
              <input
                id="name"
                name="name"
                type="text"
                placeholder="e.g. Prior-auth letter summarizer"
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoComplete="off"
              />
            </div>
            <div className="field">
              <span className="label" id="kind-label">
                What kind of thing is it?
              </span>
              <input type="hidden" name="kind" value={assetKind} />
              <div className="seg seg-sm" role="group" aria-labelledby="kind-label">
                {KINDS.map(({ kind, available }) => (
                  <button
                    key={kind}
                    type="button"
                    aria-pressed={assetKind === kind}
                    disabled={!available}
                    title={available ? undefined : "Member communications review arrives in a later release"}
                    onClick={() => setAssetKind(kind)}
                  >
                    {ASSET_KIND[kind]}
                  </button>
                ))}
              </div>
            </div>
          </div>
        ) : null}
        <div className="field">
          <label htmlFor="purpose">What does it do? In your words</label>
          <textarea
            id="purpose"
            rows={3}
            maxLength={2000}
            value={purpose}
            onChange={(e) => setPurpose(e.target.value)}
            placeholder="e.g. Summarizes provider letters for prior-auth nurses, who read every summary before deciding. Runs on our Azure OpenAI deployment."
          />
          <div className="row" style={{ gap: 12 }}>
            {assistant ? (
              <button className="btn btn-sm" type="button" disabled={suggest.pending || purpose.trim().length < 20} onClick={() => suggest.ask(purpose, Object.keys(answers))}>
                {suggest.pending ? "Suggesting…" : suggest.runId ? "Suggest the phrases again" : "Suggest the phrases"}
              </button>
            ) : null}
            <span className="hint">
              {assistant
                ? "The intake assistant can suggest the phrases from this. Your words stay on this page; only the answers are saved."
                : "Your words stay on this page; only the answers are saved."}
            </span>
          </div>
          {suggest.error ? <p className="error">{suggest.error}</p> : null}
        </div>
      </div>

      {suggest.runId ? (
        <div className="agent-note" role="status">
          <span className="mark mark-agent" style={{ "--size": "20px" } as React.CSSProperties} aria-hidden="true" />
          <span>
            <strong>Draft by intake assistant.</strong>{" "}
            {suggest.filled.size > 0
              ? `It suggested ${plural(suggest.filled.size, "phrase")}, outlined in dashes. Check each one: you submit the answers, not the assistant.`
              : "It had nothing to add to what you answered."}
          </span>
        </div>
      ) : null}

      <section aria-labelledby="describe" className="stack" style={{ gap: 18 }}>
        <div className="spread">
          <h2 id="describe" className="eyebrow">
            {view === "sentence" ? "Describe the system. Select a highlighted phrase to change it." : "Answer each question"}
          </h2>
          {pack.sentence ? (
            <button className="link-button" type="button" onClick={() => setView(view === "sentence" ? "questions" : "sentence")}>
              {view === "sentence" ? "Answer as questions instead" : "Answer as a sentence instead"}
            </button>
          ) : null}
        </div>
        {view === "sentence" && pack.sentence ? (
          <Sentence
            pack={pack}
            answers={answers}
            suggested={suggest.filled}
            suggestions={suggest.suggestions}
            purpose={purpose}
            onAnswer={answer}
          />
        ) : (
          <Questions questions={pack.questions} answers={answers} suggestions={suggest.suggestions} onAnswer={answer} />
        )}
      </section>

      <section className="result" aria-live="polite" aria-labelledby="result-h" data-tier={result.tier}>
        <div className="stack" style={{ gap: 10 }}>
          <h2 id="result-h" className="eyebrow">
            {complete ? "Result" : `Provisional · ${left.length} left`}
          </h2>
          <Meter tier={result.tier} />
          <span className="mono-s muted">rule: {result.tierRuleId ?? "none matched"}</span>
        </div>
        <div className="stack" style={{ gap: 14 }}>
          <p className="result-verdict" data-testid="verdict">
            <em>{TIER_NAME[result.tier]} risk</em>, because it {becauseText(pack, result.tierRuleId)}.
          </p>
          <p className="result-line">
            <strong>{plural(domains.length, "team")}</strong> will review it: {domains.join(", ")}.
          </p>
          <p className="result-line muted">
            {!complete
              ? `Answer the ${plural(left.length, "remaining question")} to see whether the fast lane applies.`
              : fastLane.eligible
                ? `Eligible for the fast lane under ${fastLane.policyId}: approved when you submit. Accountable: ${fastLane.accountableApprover}.`
                : `Not eligible for the fast lane: ${fastLane.reasons.join(", ")}.`}
          </p>
        </div>
      </section>

      {state.error ? <p className="error">{state.error}</p> : null}
      <div className="intake-actions">
        <button className="btn btn-primary btn-lg" type="submit" disabled={!ready || pending}>
          {pending ? "Submitting…" : fastLane.eligible && complete ? "Submit and approve in the fast lane" : "Submit for review"}
        </button>
        {!ready ? (
          <span className="hint">
            {mode.kind === "register" && !name.trim() ? "Name it" : ""}
            {mode.kind === "register" && !name.trim() && !complete ? " and answer " : !complete ? "Answer " : ""}
            {!complete ? `${plural(left.length, "more question")}` : ""} to submit.
          </span>
        ) : null}
        <span className="note mono-s muted">
          Each phrase answers one question in {pack.id}@{pack.version}.
          <br />
          Rules set the tier, not AI.
        </span>
      </div>
    </form>
  );
}

function Sentence({
  pack,
  answers,
  suggested,
  suggestions,
  purpose,
  onAnswer,
}: {
  pack: InitiativePack;
  answers: Record<string, boolean>;
  suggested: ReadonlySet<string>;
  suggestions: Map<string, IntakeSuggestion>;
  purpose: string;
  onAnswer: (field: string, value: boolean) => void;
}) {
  const sentence = pack.sentence!;
  const questions = new Map(pack.questions.map((q) => [q.field, q]));
  const parts = sentence.template.split(/\{(\w+)\}/);
  return (
    <p className="sentence">
      {parts.map((part, i) => {
        if (i % 2 === 0) return <Fragment key={i}>{part}</Fragment>;
        if (part === "purpose") {
          const words = asPurpose(purpose);
          return (
            <label key={i} htmlFor="purpose" className="purpose" data-empty={!words}>
              {words || "do what it does"}
            </label>
          );
        }
        const q = questions.get(part);
        const phrase = sentence.phrases[part];
        if (!q || !phrase) return <Fragment key={i}>{`{${part}}`}</Fragment>;
        const value = answers[part];
        const why = suggestions.get(part)?.why;
        if (typeof value !== "boolean") {
          return (
            <span key={i} className="choice" role="group" aria-label={q.label}>
              <button type="button" aria-label={`Yes: ${phrase.yes}`} onClick={() => onAnswer(part, true)}>
                {phrase.yes}
              </button>
              <span className="or" aria-hidden="true">
                or
              </span>
              <button type="button" aria-label={`No: ${phrase.no}`} onClick={() => onAnswer(part, false)}>
                {phrase.no}
              </button>
            </span>
          );
        }
        const shown = value ? phrase.yes : phrase.no;
        const other = value ? phrase.no : phrase.yes;
        return (
          <span key={i} role="group" aria-label={q.label}>
            <button
              type="button"
              className="chip"
              data-suggested={suggested.has(part)}
              title={why ? `Suggested by the intake assistant: ${why}` : q.help}
              aria-label={`${value ? "Yes" : "No"}: ${shown}. Change to ${other}`}
              onClick={() => onAnswer(part, !value)}
            >
              {shown}
            </button>
          </span>
        );
      })}
    </p>
  );
}

function Questions({
  questions,
  answers,
  suggestions,
  onAnswer,
}: {
  questions: readonly IntakeQuestion[];
  answers: Record<string, boolean>;
  suggestions: Map<string, IntakeSuggestion>;
  onAnswer: (field: string, value: boolean) => void;
}) {
  return (
    <div className="question-grid">
      {questions.map((q, i) => {
        const s = suggestions.get(q.field);
        const said = s && s.answer !== "unsure" ? s.answer === "yes" : null;
        const changed = said !== null && typeof answers[q.field] === "boolean" && answers[q.field] !== said;
        return (
          <div className="question" key={q.field} data-answered={typeof answers[q.field] === "boolean"}>
            <span className="eyebrow">Q{i + 1}</span>
            <strong>{q.label}</strong>
            <span className="hint">{q.help}</span>
            {s ? (
              <span className="suggestion">
                {said === null ? "The intake assistant isn't sure" : `Suggested: ${said ? "Yes" : "No"}`}
                {changed ? " · you changed it" : ""} · {s.why}
              </span>
            ) : null}
            <div className="seg" role="group" aria-label={q.label}>
              <button type="button" aria-pressed={answers[q.field] === true} onClick={() => onAnswer(q.field, true)}>
                Yes
              </button>
              <button type="button" aria-pressed={answers[q.field] === false} onClick={() => onAnswer(q.field, false)}>
                No
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
