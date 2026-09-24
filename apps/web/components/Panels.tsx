"use client";

import type { CaseTrigger, Clearance } from "@aegis/domain";
import { useActionState, useEffect, useState } from "react";
import { decide, openReview, operate } from "@/app/(console)/registry/actions";
import { IDLE, type ActionState } from "@/lib/action-state";
import { DECISIONS, OPERATIONS, TRIGGER, type Tone } from "@/lib/labels";

const BUTTON: Record<Tone, string> = {
  good: "btn btn-good",
  bad: "btn btn-bad",
  warn: "btn btn-warn",
  accent: "btn btn-primary",
  info: "btn",
  neutral: "btn",
};

/** Choose an action, give a reason when it needs one, then confirm: nothing happens on a single stray click. */
function useChoice(state: ActionState) {
  const [choice, setChoice] = useState<string | null>(null);
  useEffect(() => {
    if (!state.error) setChoice(null);
  }, [state]);
  return [choice, setChoice] as const;
}

export function DecisionPanel({ caseId, actions }: { caseId: string; actions: readonly string[] }) {
  const [state, action, pending] = useActionState(decide, IDLE);
  const [choice, setChoice] = useChoice(state);
  const meta = choice ? DECISIONS[choice] : null;

  return (
    <form action={action} className="stack">
      <input type="hidden" name="caseId" value={caseId} />
      <input type="hidden" name="action" value={choice ?? ""} />
      <div className="row">
        {actions.map((a) => (
          <button
            key={a}
            type="button"
            className={BUTTON[DECISIONS[a]?.tone ?? "neutral"]}
            aria-pressed={choice === a}
            style={choice && choice !== a ? { opacity: 0.55 } : undefined}
            onClick={() => setChoice(a)}
          >
            {DECISIONS[a]?.label ?? a}
          </button>
        ))}
      </div>
      {choice && meta ? (
        <>
          <div className="field">
            <label htmlFor="decision-reason">
              {meta.needsReason ? "Why? The requester and auditors will read this." : "Note (optional)"}
            </label>
            <textarea
              id="decision-reason"
              name="reason"
              required={meta.needsReason}
              placeholder={
                choice === "conditionally_approve"
                  ? "The conditions that must hold, e.g. retention control C-12 live before launch"
                  : choice === "reject"
                    ? "What would have to change for this to pass"
                    : ""
              }
              autoFocus
            />
          </div>
          {state.error ? <div className="error">{state.error}</div> : null}
          <div className="row">
            <button className="btn btn-primary" type="submit" disabled={pending}>
              {pending ? "Recording…" : `Confirm: ${meta.label.toLowerCase()}`}
            </button>
            <button className="btn" type="button" onClick={() => setChoice(null)}>
              Cancel
            </button>
          </div>
        </>
      ) : null}
    </form>
  );
}

export function OperatePanel({
  assetId,
  actions,
  clearance,
}: {
  assetId: string;
  actions: readonly string[];
  clearance: Clearance;
}) {
  const [state, action, pending] = useActionState(operate, IDLE);
  const [choice, setChoice] = useChoice(state);
  const meta = choice ? OPERATIONS[choice] : null;
  const blocked = (a: string) => Boolean(OPERATIONS[a]?.needsClearance) && !clearance.cleared;

  if (actions.length === 0) return <p className="muted">Only admins change whether this is in use.</p>;
  return (
    <form action={action} className="stack">
      <input type="hidden" name="assetId" value={assetId} />
      <input type="hidden" name="action" value={choice ?? ""} />
      <div className="row">
        {actions.map((a) => (
          <button
            key={a}
            type="button"
            className={BUTTON[OPERATIONS[a]?.tone ?? "neutral"]}
            aria-pressed={choice === a}
            disabled={blocked(a)}
            onClick={() => setChoice(a)}
          >
            {OPERATIONS[a]?.label ?? a}
          </button>
        ))}
      </div>
      {actions.some(blocked) && !clearance.cleared ? (
        <p className="faint" style={{ fontSize: 13 }}>
          Can&apos;t be put in use: {clearance.reason}.
        </p>
      ) : null}
      {choice && meta ? (
        <>
          {meta.needsReason ? (
            <div className="field">
              <label htmlFor="operate-reason">Why?</label>
              <textarea id="operate-reason" name="reason" required autoFocus />
            </div>
          ) : null}
          {state.error ? <div className="error">{state.error}</div> : null}
          <div className="row">
            <button className="btn btn-primary" type="submit" disabled={pending}>
              {pending ? "Saving…" : `Confirm: ${meta.label.toLowerCase()}`}
            </button>
            <button className="btn" type="button" onClick={() => setChoice(null)}>
              Cancel
            </button>
          </div>
        </>
      ) : null}
    </form>
  );
}

export function OpenReviewForm({ assetId, triggers }: { assetId: string; triggers: readonly CaseTrigger[] }) {
  const [state, action, pending] = useActionState(openReview, IDLE);
  const [trigger, setTrigger] = useState<CaseTrigger>(triggers[0] ?? "change");

  return (
    <form action={action} className="stack">
      <input type="hidden" name="assetId" value={assetId} />
      <input type="hidden" name="trigger" value={trigger} />
      {triggers.length > 1 ? (
        <div className="segmented" role="group" aria-label="Why re-review">
          {triggers.map((t) => (
            <button key={t} type="button" aria-pressed={trigger === t} onClick={() => setTrigger(t)}>
              {TRIGGER[t]}
            </button>
          ))}
        </div>
      ) : null}
      {trigger === "incident" ? (
        <p className="faint" style={{ fontSize: 13 }}>
          An open incident review takes away clearance until it is decided.
        </p>
      ) : null}
      {state.error ? <div className="error">{state.error}</div> : null}
      <div>
        <button className="btn btn-primary" type="submit" disabled={pending}>
          {pending ? "Opening…" : triggers[0] === "initial" ? "Start the review" : `Open ${TRIGGER[trigger].toLowerCase()}`}
        </button>
      </div>
    </form>
  );
}
