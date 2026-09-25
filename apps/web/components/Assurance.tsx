"use client";

import { draftMemo, type ReviewDraft } from "@aegis/domain";
import { useActionState, useEffect, useState, type ReactNode } from "react";
import {
  addEvidence,
  conditionAction,
  exceptionAction,
  requestDraft,
  requestException,
  reviewAction,
  withdrawEvidence,
} from "@/app/(console)/registry/actions";
import { IDLE, type ActionState } from "@/lib/action-state";
import { CONDITION_ACTIONS, REVIEW_ACTIONS, type Tone } from "@/lib/labels";

type ServerAction = (state: ActionState, form: FormData) => Promise<ActionState>;

export const BUTTON: Record<Tone, string> = {
  good: "btn btn-good",
  bad: "btn btn-bad",
  warn: "btn btn-warn",
  accent: "btn btn-primary",
  info: "btn",
  neutral: "btn",
};

export interface Choice {
  readonly value: string;
  readonly label: string;
  readonly tone: Tone;
  readonly needsNote: boolean;
  readonly notePrompt?: string;
  /** Text the note starts with, such as an agent's draft, for the person to edit. */
  readonly defaultNote?: string;
  /** Why this choice is unavailable right now, if it is. */
  readonly disabledReason?: string | null;
}

/**
 * Choose an action, write a note when it needs one, then confirm. Nothing
 * happens on a single stray click, and the form resets once it succeeds.
 */
export function ActionChooser({
  action,
  hidden,
  choices,
  extra,
  small,
  noteField = "reason",
}: {
  action: ServerAction;
  hidden: Record<string, string>;
  choices: readonly Choice[];
  extra?: (choice: string) => ReactNode;
  small?: boolean;
  /** The form field the note is sent as. */
  noteField?: string;
}) {
  const [state, submit, pending] = useActionState(action, IDLE);
  const [choice, setChoice] = useState<string | null>(null);
  useEffect(() => {
    if (!state.error) setChoice(null);
  }, [state]);
  const chosen = choices.find((c) => c.value === choice) ?? null;
  const blocked = choices.filter((c) => c.disabledReason);

  return (
    <form action={submit} className="stack" style={{ gap: 10 }}>
      {Object.entries(hidden).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      <input type="hidden" name="action" value={choice ?? ""} />
      <div className="row" style={{ gap: 8 }}>
        {choices.map((c) => (
          <button
            key={c.value}
            type="button"
            className={`${BUTTON[c.tone]}${small ? " btn-sm" : ""}`}
            aria-pressed={choice === c.value}
            disabled={Boolean(c.disabledReason)}
            title={c.disabledReason ?? undefined}
            style={choice && choice !== c.value ? { opacity: 0.55 } : undefined}
            onClick={() => setChoice(c.value)}
          >
            {c.label}
          </button>
        ))}
      </div>
      {!chosen && blocked.length > 0 ? (
        <p className="faint" style={{ fontSize: 13 }}>
          {blocked.map((c) => `${c.label}: ${c.disabledReason}`).join(" · ")}
        </p>
      ) : null}
      {chosen ? (
        <>
          {chosen.needsNote || chosen.notePrompt ? (
            <div className="field">
              <label htmlFor={`note-${Object.values(hidden).join("-")}`}>{chosen.notePrompt ?? "Why?"}</label>
              <textarea
                key={chosen.value}
                id={`note-${Object.values(hidden).join("-")}`}
                name={noteField}
                required={chosen.needsNote}
                defaultValue={chosen.defaultNote}
                rows={chosen.defaultNote ? Math.min(12, chosen.defaultNote.split("\n").length + 2) : undefined}
                autoFocus
              />
            </div>
          ) : null}
          {extra?.(chosen.value)}
          {state.error ? <div className="error">{state.error}</div> : null}
          <div className="row">
            <button className="btn btn-primary" type="submit" disabled={pending}>
              {pending ? "Saving…" : `Confirm: ${chosen.label.toLowerCase()}`}
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

/* ------------------------------------------------------------ domain reviews */

export function ReviewActions({
  caseId,
  domain,
  revision,
  actions,
  uncoveredGates,
  draft,
}: {
  caseId: string;
  domain: string;
  revision: number;
  actions: readonly string[];
  uncoveredGates: readonly string[];
  /** The drafter's draft, which the memo and proposals start from. */
  draft?: ReviewDraft | null;
}) {
  const defaults: Record<string, string | undefined> = {
    sign: draft ? draftMemo(draft) : undefined,
    return: draft && draft.questionsForOwner.length > 0 ? draft.questionsForOwner.join("\n") : undefined,
  };
  return (
    <ActionChooser
      action={reviewAction}
      hidden={{ caseId, domain, revision: String(revision) }}
      noteField="note"
      small
      choices={actions.map((a) => ({
        value: a,
        ...REVIEW_ACTIONS[a]!,
        ...(defaults[a]
          ? {
              defaultNote: defaults[a],
              notePrompt:
                a === "sign" ? "Memo for the approver, starting from the draft. Edit it as you see fit." : "Your question for the owner, from the draft",
            }
          : {}),
        disabledReason:
          a === "sign" && uncoveredGates.length > 0 ? `needs evidence or an exception for ${uncoveredGates.join(", ")}` : null,
      }))}
      extra={(choice) =>
        choice === "sign" ? (
          <div className="field">
            <label htmlFor={`proposals-${domain}`}>Conditions you want attached (optional, one per line)</label>
            <textarea
              id={`proposals-${domain}`}
              name="proposals"
              placeholder="e.g. Keep PHI inside our Azure tenant"
              defaultValue={draft?.proposedConditions.join("\n")}
            />
          </div>
        ) : null
      }
    />
  );
}

/** Ask the review drafter for a fresh draft. */
export function RequestDraft({ caseId, domain, again }: { caseId: string; domain: string; again: boolean }) {
  const [state, submit, pending] = useActionState(requestDraft, IDLE);
  return (
    <form action={submit} className="row" style={{ gap: 8 }}>
      <input type="hidden" name="caseId" value={caseId} />
      <input type="hidden" name="domain" value={domain} />
      <button className="link-button" type="submit" disabled={pending}>
        {pending ? "Asking…" : again ? "Draft it again" : "Ask the drafter"}
      </button>
      {state.error ? <span className="error-inline">{state.error}</span> : null}
    </form>
  );
}

/* ------------------------------------------------------------------ evidence */

export function EvidenceForm({
  assetId,
  controlId,
  conditionId,
  hint,
}: {
  assetId: string;
  controlId?: string;
  conditionId?: string;
  hint?: string;
}) {
  const [state, submit, pending] = useActionState(addEvidence, IDLE);
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<"link" | "attestation">("link");
  useEffect(() => {
    if (!state.error) setOpen(false);
  }, [state]);

  if (!open) {
    return (
      <button className="btn btn-sm" type="button" onClick={() => setOpen(true)}>
        + Add evidence
      </button>
    );
  }
  return (
    <form action={submit} className="stack evidence-form" style={{ gap: 10 }}>
      <input type="hidden" name="assetId" value={assetId} />
      {controlId ? <input type="hidden" name="controlId" value={controlId} /> : null}
      {conditionId ? <input type="hidden" name="conditionId" value={conditionId} /> : null}
      <input type="hidden" name="kind" value={kind} />
      <div className="segmented" role="group" aria-label="Evidence kind">
        <button type="button" aria-pressed={kind === "link"} onClick={() => setKind("link")}>
          Link to a document
        </button>
        <button type="button" aria-pressed={kind === "attestation"} onClick={() => setKind("attestation")}>
          Written attestation
        </button>
      </div>
      <div className="field">
        <label htmlFor={`title-${controlId ?? conditionId}`}>Title</label>
        <input id={`title-${controlId ?? conditionId}`} name="title" type="text" placeholder={hint} required autoFocus />
      </div>
      {kind === "link" ? (
        <div className="field">
          <label htmlFor={`url-${controlId ?? conditionId}`}>Link</label>
          <input id={`url-${controlId ?? conditionId}`} name="url" type="text" placeholder="https://" required />
        </div>
      ) : (
        <div className="field">
          <label htmlFor={`detail-${controlId ?? conditionId}`}>What you attest to</label>
          <textarea id={`detail-${controlId ?? conditionId}`} name="detail" required />
        </div>
      )}
      {state.error ? <div className="error">{state.error}</div> : null}
      <div className="row">
        <button className="btn btn-primary" type="submit" disabled={pending}>
          {pending ? "Adding…" : "Add evidence"}
        </button>
        <button className="btn" type="button" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </form>
  );
}

export function WithdrawEvidence({ assetId, evidenceId }: { assetId: string; evidenceId: string }) {
  const [state, submit, pending] = useActionState(withdrawEvidence, IDLE);
  return (
    <form action={submit} style={{ display: "inline" }}>
      <input type="hidden" name="assetId" value={assetId} />
      <input type="hidden" name="evidenceId" value={evidenceId} />
      <button className="link-button" type="submit" disabled={pending} title={state.error ?? "Withdraw this evidence"}>
        Withdraw
      </button>
    </form>
  );
}

/* ---------------------------------------------------------------- exceptions */

export function ExceptionRequestForm({ assetId, controlId }: { assetId: string; controlId: string }) {
  const [state, submit, pending] = useActionState(requestException, IDLE);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!state.error) setOpen(false);
  }, [state]);

  if (!open) {
    return (
      <button className="btn btn-sm" type="button" onClick={() => setOpen(true)}>
        Request exception
      </button>
    );
  }
  return (
    <form action={submit} className="stack evidence-form" style={{ gap: 10 }}>
      <input type="hidden" name="assetId" value={assetId} />
      <input type="hidden" name="controlId" value={controlId} />
      <div className="field">
        <label htmlFor={`reason-${controlId}`}>Why can&apos;t this control be met yet?</label>
        <textarea id={`reason-${controlId}`} name="reason" required autoFocus />
      </div>
      <div className="field" style={{ maxWidth: 200 }}>
        <label htmlFor={`days-${controlId}`}>For how many days?</label>
        <input id={`days-${controlId}`} name="days" type="text" inputMode="numeric" defaultValue="90" />
      </div>
      <p className="faint" style={{ fontSize: 13 }}>
        An approver other than you decides. The exception stops covering the control when it expires.
      </p>
      {state.error ? <div className="error">{state.error}</div> : null}
      <div className="row">
        <button className="btn btn-primary" type="submit" disabled={pending}>
          {pending ? "Requesting…" : "Request exception"}
        </button>
        <button className="btn" type="button" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </form>
  );
}

const EXCEPTION_CHOICES: Record<string, Omit<Choice, "value">> = {
  approve: { label: "Approve exception", tone: "good", needsNote: false },
  reject: { label: "Reject", tone: "bad", needsNote: true },
  revoke: { label: "Revoke", tone: "warn", needsNote: true },
};

export function ExceptionActions({ exceptionId, actions }: { exceptionId: string; actions: readonly string[] }) {
  return (
    <ActionChooser
      action={exceptionAction}
      hidden={{ exceptionId }}
      small
      choices={actions.map((a) => ({ value: a, ...EXCEPTION_CHOICES[a]! }))}
    />
  );
}

/* ---------------------------------------------------------------- conditions */

export function ConditionActions({
  conditionId,
  actions,
  evidenceCount,
}: {
  conditionId: string;
  actions: readonly string[];
  evidenceCount: number;
}) {
  return (
    <ActionChooser
      action={conditionAction}
      hidden={{ conditionId }}
      small
      choices={actions.map((a) => ({
        value: a,
        ...CONDITION_ACTIONS[a]!,
        disabledReason: a === "submit" && evidenceCount === 0 ? "add evidence first" : null,
      }))}
    />
  );
}

/** The conditions an approver attaches to a conditional approval; reviewers' proposals are filled in. */
export function ConditionsEditor({ proposals }: { proposals: readonly string[] }) {
  type Row = { text: string; due: "before_use" | "ongoing" };
  const [rows, setRows] = useState<Row[]>(() =>
    proposals.length > 0 ? proposals.map((text) => ({ text, due: "before_use" })) : [{ text: "", due: "before_use" }],
  );
  const update = (i: number, patch: Partial<Row>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  return (
    <div className="stack" style={{ gap: 8 }}>
      <input type="hidden" name="conditions" value={JSON.stringify(rows.filter((r) => r.text.trim()))} />
      <span className="label">Conditions</span>
      {proposals.length > 0 ? (
        <p className="faint" style={{ fontSize: 13, marginTop: -4 }}>
          Reviewers proposed these. Edit, remove or add to them.
        </p>
      ) : null}
      {rows.map((row, i) => (
        <div className="condition-row" key={i}>
          <input
            type="text"
            aria-label={`Condition ${i + 1}`}
            value={row.text}
            placeholder="What must hold"
            onChange={(e) => update(i, { text: e.target.value })}
          />
          <div className="segmented" role="group" aria-label={`When condition ${i + 1} is due`}>
            <button type="button" aria-pressed={row.due === "before_use"} onClick={() => update(i, { due: "before_use" })}>
              Before use
            </button>
            <button type="button" aria-pressed={row.due === "ongoing"} onClick={() => update(i, { due: "ongoing" })}>
              Ongoing
            </button>
          </div>
          <button
            className="link-button"
            type="button"
            aria-label={`Remove condition ${i + 1}`}
            onClick={() => setRows(rows.filter((_, j) => j !== i))}
          >
            Remove
          </button>
        </div>
      ))}
      <div>
        <button className="btn btn-sm" type="button" onClick={() => setRows([...rows, { text: "", due: "before_use" }])}>
          + Add a condition
        </button>
      </div>
    </div>
  );
}
