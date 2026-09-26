"use client";

import { draftMemo, type CaseTrigger, type Clearance, type DecisionReadiness, type ReviewDraft } from "@aegis/domain";
import Link from "next/link";
import { useActionState, useEffect, useState, type ReactNode } from "react";
import {
  addEvidence,
  conditionAction,
  decide,
  exceptionAction,
  openReview,
  operate,
  requestDraft,
  requestException,
  reviewAction,
  withdrawEvidence,
} from "@/app/(console)/registry/actions";
import { IDLE, type ActionState } from "@/lib/action-state";
import { CONDITION_ACTIONS, DECISIONS, OPERATIONS, TRIGGER, plural } from "@/lib/labels";
import { AgentDraftFrame } from "./ds";

type ServerAction = (state: ActionState, form: FormData) => Promise<ActionState>;

function Hidden({ values }: { values: Record<string, string> }) {
  return (
    <>
      {Object.entries(values).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
    </>
  );
}

function Refusal({ state }: { state: ActionState }) {
  return state.error ? (
    <p className="error" role="alert">
      {state.error}
    </p>
  ) : null;
}

export interface Choice {
  readonly value: string;
  readonly label: string;
  readonly primary?: boolean;
  readonly needsNote: boolean;
  readonly notePrompt?: string;
  /** Why this choice is unavailable right now, if it is. */
  readonly disabledReason?: string | null;
}

/**
 * Choose an action, write a note when it needs one, then confirm: nothing
 * happens on a single stray click. The confirm button says exactly what
 * will happen, and the form resets once it succeeds.
 */
export function ActionChooser({
  action,
  hidden,
  choices,
  small,
  noteField = "reason",
}: {
  action: ServerAction;
  hidden: Record<string, string>;
  choices: readonly Choice[];
  small?: boolean;
  noteField?: string;
}) {
  const [state, submit, pending] = useActionState(action, IDLE);
  const [choice, setChoice] = useState<string | null>(null);
  useEffect(() => {
    if (!state.error) setChoice(null);
  }, [state]);
  const chosen = choices.find((c) => c.value === choice) ?? null;
  const blocked = choices.filter((c) => c.disabledReason);
  const id = `note-${Object.values(hidden).join("-")}`;
  const size = small ? " btn-sm" : "";

  return (
    <form action={submit} className="stack" style={{ gap: 10 }}>
      <Hidden values={hidden} />
      <input type="hidden" name="action" value={choice ?? ""} />
      {!chosen ? (
        <div className="row" style={{ gap: 8 }}>
          {choices.map((c) => (
            <button
              key={c.value}
              type="button"
              className={`btn${c.primary ? " btn-primary" : ""}${size}`}
              disabled={Boolean(c.disabledReason)}
              onClick={() => setChoice(c.value)}
            >
              {c.label}
            </button>
          ))}
        </div>
      ) : null}
      {!chosen && blocked.length > 0 ? <p className="hint">{blocked.map((c) => `${c.label}: ${c.disabledReason}`).join(" · ")}</p> : null}
      {chosen ? (
        <>
          {chosen.needsNote || chosen.notePrompt ? (
            <div className="field">
              <label htmlFor={id}>{chosen.notePrompt ?? "Why?"}</label>
              <textarea id={id} name={noteField} required={chosen.needsNote} rows={3} autoFocus />
            </div>
          ) : null}
          <Refusal state={state} />
          <div className="row" style={{ gap: 8 }}>
            <button className={`btn btn-primary${size}`} type="submit" disabled={pending}>
              {pending ? "Saving…" : chosen.label}
            </button>
            <button className={`btn${size}`} type="button" onClick={() => setChoice(null)}>
              Cancel
            </button>
          </div>
        </>
      ) : null}
    </form>
  );
}

/* ------------------------------------------------------------ a review seat */

const SEVERITY: Record<string, { label: string; sev: "major" | "minor" | "note" }> = {
  missing_evidence: { label: "Major", sev: "major" },
  risk: { label: "Major", sev: "major" },
  weak_evidence: { label: "Minor", sev: "minor" },
  note: { label: "Note", sev: "note" },
};

/**
 * The reviewer's seat: the drafter's draft in its dashed frame, findings to
 * keep or dismiss, the conditions they want attached, a memo, and buttons
 * that say exactly what happens. The draft never signs anything; the
 * person does.
 */
export function SeatForm({
  caseId,
  domain,
  label,
  revision,
  actions,
  draft,
  drafterMeta,
  uncoveredGates,
  controlsHref,
}: {
  caseId: string;
  domain: string;
  label: string;
  revision: number;
  actions: readonly string[];
  draft: ReviewDraft | null;
  drafterMeta: string;
  uncoveredGates: readonly string[];
  controlsHref: string;
}) {
  const [state, submit, pending] = useActionState(reviewAction, IDLE);
  const [dismissed, setDismissed] = useState<ReadonlySet<number>>(new Set());
  const [conditions, setConditions] = useState(() => (draft?.proposedConditions ?? []).map((text) => ({ text, keep: true })));
  const [extra, setExtra] = useState("");
  const [memoEdited, setMemoEdited] = useState(false);
  const kept = (d: ReviewDraft) => ({ ...d, findings: d.findings.filter((_, i) => !dismissed.has(i)) });
  const [memo, setMemo] = useState(draft ? draftMemo(draft) : "");
  const [mode, setMode] = useState<"sign" | "return" | "abstain">("sign");
  useEffect(() => {
    if (draft && !memoEdited) setMemo(draftMemo(kept(draft)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dismissed, draft, memoEdited]);

  const chosen = [...conditions.filter((c) => c.keep).map((c) => c.text), ...(extra.trim() ? [extra.trim()] : [])];
  const canSign = actions.includes("sign");
  const signLabel = chosen.length > 0 ? `Sign with ${plural(chosen.length, "condition")}` : "Sign without conditions";
  const questions = draft?.questionsForOwner.join("\n") ?? "";

  return (
    <form action={submit} className="stack" style={{ gap: 16 }}>
      <Hidden values={{ caseId, domain, revision: String(revision) }} />
      <input type="hidden" name="proposals" value={chosen.join("\n")} />

      {draft ? (
        <AgentDraftFrame agent="review drafter" meta={drafterMeta}>
          <p className="agent-draft-summary">{draft.summary}</p>
          {draft.findings.map((f, i) => {
            const sev = SEVERITY[f.concern] ?? SEVERITY.note!;
            const isDismissed = dismissed.has(i);
            return (
              <div className="finding" key={i}>
                <span className="sev" data-sev={sev.sev}>
                  {sev.label.toUpperCase()}
                </span>
                <span className="finding-text" data-dismissed={isDismissed}>
                  {f.controlId ? <span className="mono">{f.controlId} </span> : null}
                  {f.text}
                  {isDismissed ? <span className="visually-hidden"> (dismissed)</span> : null}
                </span>
                <div className="seg seg-sm" role="group" aria-label={`Finding ${i + 1}`}>
                  <button
                    type="button"
                    aria-pressed={!isDismissed}
                    onClick={() => setDismissed((d) => new Set([...d].filter((x) => x !== i)))}
                  >
                    Keep
                  </button>
                  <button type="button" aria-pressed={isDismissed} onClick={() => setDismissed((d) => new Set([...d, i]))}>
                    Dismiss
                  </button>
                </div>
              </div>
            );
          })}
          {draft.questionsForOwner.length > 0 ? (
            <div className="stack" style={{ gap: 4 }}>
              <span className="label">It would ask the owner</span>
              <ul style={{ listStyle: "disc", paddingLeft: 18 }}>
                {draft.questionsForOwner.map((q) => (
                  <li key={q}>{q}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </AgentDraftFrame>
      ) : null}

      {mode === "sign" && canSign ? (
        <>
          <fieldset className="stack" style={{ gap: 2 }}>
            <legend>Your conditions</legend>
            {conditions.map((c, i) => (
              <label className="check" key={i}>
                <input
                  type="checkbox"
                  checked={c.keep}
                  onChange={(e) => setConditions(conditions.map((x, j) => (j === i ? { ...x, keep: e.target.checked } : x)))}
                />
                {c.text}
              </label>
            ))}
            <input
              type="text"
              aria-label="Add a condition"
              placeholder="Add a condition the approver should attach"
              value={extra}
              onChange={(e) => setExtra(e.target.value)}
            />
          </fieldset>
          <div className="field">
            <label htmlFor={`memo-${domain}`}>{draft ? "Memo for the approver, from the draft" : "Memo for the approver"}</label>
            <textarea
              id={`memo-${domain}`}
              name="note"
              rows={Math.min(10, memo.split("\n").length + 2)}
              value={memo}
              onChange={(e) => {
                setMemo(e.target.value);
                setMemoEdited(true);
              }}
            />
          </div>
          {uncoveredGates.length > 0 ? (
            <p className="hint">
              Signing waits on evidence or an exception for{" "}
              <Link href={controlsHref}>{uncoveredGates.join(", ")}</Link>.
            </p>
          ) : null}
          <Refusal state={state} />
          <div className="row" style={{ gap: 10 }}>
            <button className="btn btn-primary btn-pill" type="submit" name="action" value="sign" disabled={pending || uncoveredGates.length > 0}>
              {pending ? "Signing…" : signLabel}
            </button>
            {actions.includes("return") ? (
              <button className="btn btn-pill" type="button" onClick={() => setMode("return")}>
                Ask the owner
              </button>
            ) : null}
            {actions.includes("abstain") ? (
              <button className="btn btn-pill btn-quiet" type="button" onClick={() => setMode("abstain")}>
                Abstain
              </button>
            ) : null}
          </div>
        </>
      ) : null}

      {mode === "return" ? (
        <>
          <div className="field">
            <label htmlFor={`question-${domain}`}>Your question for the owner</label>
            <textarea id={`question-${domain}`} name="note" rows={4} defaultValue={questions} required autoFocus />
            <span className="hint">The review waits until the owner answers. You resume it after.</span>
          </div>
          <Refusal state={state} />
          <div className="row" style={{ gap: 10 }}>
            <button className="btn btn-primary btn-pill" type="submit" name="action" value="return" disabled={pending}>
              {pending ? "Sending…" : "Send the question"}
            </button>
            <button className="btn btn-pill" type="button" onClick={() => setMode("sign")}>
              Cancel
            </button>
          </div>
        </>
      ) : null}

      {mode === "abstain" ? (
        <>
          <div className="field">
            <label htmlFor={`abstain-${domain}`}>Why you cannot review this</label>
            <textarea id={`abstain-${domain}`} name="note" rows={3} required autoFocus placeholder="For example, a conflict of interest" />
          </div>
          <Refusal state={state} />
          <div className="row" style={{ gap: 10 }}>
            <button className="btn btn-primary btn-pill" type="submit" name="action" value="abstain" disabled={pending}>
              {pending ? "Saving…" : `Abstain from ${label}`}
            </button>
            <button className="btn btn-pill" type="button" onClick={() => setMode("sign")}>
              Cancel
            </button>
          </div>
        </>
      ) : null}
    </form>
  );
}

/** One button for a review action with no note, such as resuming. */
export function ReviewButton({
  caseId,
  domain,
  revision,
  action,
  label,
}: {
  caseId: string;
  domain: string;
  revision: number;
  action: string;
  label: string;
}) {
  const [state, submit, pending] = useActionState(reviewAction, IDLE);
  return (
    <form action={submit} className="stack" style={{ gap: 8 }}>
      <Hidden values={{ caseId, domain, revision: String(revision), action }} />
      <Refusal state={state} />
      <div>
        <button className="btn btn-pill" type="submit" disabled={pending}>
          {pending ? "Saving…" : label}
        </button>
      </div>
    </form>
  );
}

/** The owner answers a reviewer's question. */
export function RespondForm({ caseId, domain, revision }: { caseId: string; domain: string; revision: number }) {
  const [state, submit, pending] = useActionState(reviewAction, IDLE);
  return (
    <form action={submit} className="stack" style={{ gap: 10 }}>
      <Hidden values={{ caseId, domain, revision: String(revision), action: "respond" }} />
      <div className="field">
        <label htmlFor={`answer-${domain}`}>Your answer for the reviewer</label>
        <textarea id={`answer-${domain}`} name="note" rows={4} required />
      </div>
      <Refusal state={state} />
      <div>
        <button className="btn btn-primary btn-pill" type="submit" disabled={pending}>
          {pending ? "Sending…" : "Send the answer"}
        </button>
      </div>
    </form>
  );
}

/** Ask the review drafter for a fresh draft. */
export function RequestDraft({ caseId, domain, again }: { caseId: string; domain: string; again: boolean }) {
  const [state, submit, pending] = useActionState(requestDraft, IDLE);
  return (
    <form action={submit} className="row" style={{ gap: 8 }}>
      <Hidden values={{ caseId, domain }} />
      <button className="link-button" type="submit" disabled={pending}>
        {pending ? "Asking…" : again ? "Ask the drafter to draft it again" : "Ask the drafter for a draft"}
      </button>
      {state.error ? <span className="error-inline">{state.error}</span> : null}
    </form>
  );
}

/* ------------------------------------------------------------- the decision */

type Row = { text: string; due: "before_use" | "ongoing" };

/** The conditions an approver attaches; reviewers' proposals are filled in. */
function ConditionsEditor({ rows, setRows }: { rows: Row[]; setRows: (rows: Row[]) => void }) {
  const update = (i: number, patch: Partial<Row>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <fieldset className="stack" style={{ gap: 8 }}>
      <legend>Conditions</legend>
      {rows.map((row, i) => (
        <div className="condition-row" key={i}>
          <input
            type="text"
            aria-label={`Condition ${i + 1}`}
            value={row.text}
            placeholder="What must hold"
            onChange={(e) => update(i, { text: e.target.value })}
          />
          <div className="seg seg-sm" role="group" aria-label={`When condition ${i + 1} is due`}>
            <button type="button" aria-pressed={row.due === "before_use"} onClick={() => update(i, { due: "before_use" })}>
              Before use
            </button>
            <button type="button" aria-pressed={row.due === "ongoing"} onClick={() => update(i, { due: "ongoing" })}>
              Ongoing
            </button>
          </div>
          <button className="link-button" type="button" aria-label={`Remove condition ${i + 1}`} onClick={() => setRows(rows.filter((_, j) => j !== i))}>
            Remove
          </button>
        </div>
      ))}
      <div>
        <button className="btn btn-sm" type="button" onClick={() => setRows([...rows, { text: "", due: "before_use" }])}>
          Add a condition
        </button>
      </div>
    </fieldset>
  );
}

/**
 * The approver's seat. The primary button follows the conditions: with any,
 * it approves with them; with none, it approves outright. Reject is always
 * a separate, deliberate choice.
 */
const BLOCKER_STATUS: Record<string, string> = {
  pending: "not reviewed",
  drafted: "a draft nobody has signed",
  returned: "a question for the owner",
  abstained: "abstained without a reason",
  missing: "no review",
};

export function DecisionForm({
  caseId,
  actions,
  readiness,
  proposals,
  labels,
}: {
  caseId: string;
  actions: readonly string[];
  readiness: DecisionReadiness | null;
  proposals: readonly string[];
  /** Review domain names, to say what approving waits on. */
  labels: Readonly<Record<string, string>>;
}) {
  const [state, submit, pending] = useActionState(decide, IDLE);
  const [rows, setRows] = useState<Row[]>(() => proposals.map((text) => ({ text, due: "before_use" })));
  const [reason, setReason] = useState("");
  const [missing, setMissing] = useState<string | null>(null);
  const filled = rows.filter((r) => r.text.trim());
  const conditional = filled.length > 0;
  const approveAction = conditional ? "conditionally_approve" : "approve";
  const words = (blockers: readonly string[]) =>
    blockers
      .map((b) => {
        const [domain = "", status = ""] = b.split(":");
        return `${labels[domain] ?? domain} (${BLOCKER_STATUS[status] ?? status})`;
      })
      .join(", ");
  const blocked = (action: string): string | null => {
    if (!readiness) return null;
    if (action === "approve" && !readiness.canApprove) return `waiting on ${words(readiness.approvalBlockers)}`;
    if (action === "conditionally_approve" && !readiness.canConditionallyApprove) return `waiting on ${words(readiness.conditionalBlockers)}`;
    return null;
  };
  const approveBlocked = actions.includes(approveAction) ? blocked(approveAction) : "not available";

  return (
    <form
      action={submit}
      className="stack"
      style={{ gap: 14 }}
      onSubmit={(event) => {
        const action = ((event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null)?.value ?? "";
        if (DECISIONS[action]?.needsReason && !reason.trim()) {
          event.preventDefault();
          setMissing(`Write a reason first. ${DECISIONS[action]!.label} needs one.`);
        } else setMissing(null);
      }}
    >
      <Hidden values={{ caseId }} />
      <input type="hidden" name="conditions" value={JSON.stringify(filled)} />
      {readiness ? <p className={readiness.canApprove || readiness.canConditionallyApprove ? "" : "hint"}>{readiness.reason}</p> : null}
      {actions.includes("conditionally_approve") ? <ConditionsEditor rows={rows} setRows={setRows} /> : null}
      <div className="field">
        <label htmlFor={`reason-${caseId}`}>Reason {conditional ? "(required)" : "(required to reject or to attach conditions)"}</label>
        <textarea id={`reason-${caseId}`} name="reason" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
        <span className="hint">The requester and auditors read this. It is kept as a note; the audit log keeps its fingerprint.</span>
      </div>
      {missing ? <p className="error">{missing}</p> : null}
      <Refusal state={state} />
      <div className="row" style={{ gap: 10 }}>
        {actions.includes("approve") || actions.includes("conditionally_approve") ? (
          <button className="btn btn-primary btn-pill" type="submit" name="action" value={approveAction} disabled={pending || Boolean(approveBlocked)}>
            {pending ? "Saving…" : conditional ? `Approve with ${plural(filled.length, "condition")}` : "Approve"}
          </button>
        ) : null}
        {actions.includes("reject") ? (
          <button className="btn btn-pill" type="submit" name="action" value="reject" disabled={pending}>
            Reject
          </button>
        ) : null}
        {actions.includes("request_changes") ? (
          <button className="btn btn-pill" type="submit" name="action" value="request_changes" disabled={pending}>
            Request changes
          </button>
        ) : null}
      </div>
      {approveBlocked && approveBlocked !== "not available" ? (
        <p className="hint">
          {conditional ? "Approving with conditions" : "Approving"} is {approveBlocked}.
          {!conditional && readiness?.canConditionallyApprove && actions.includes("conditionally_approve")
            ? " Add a condition to approve with conditions now; the unsigned drafts are recorded with the decision."
            : ""}
        </p>
      ) : null}
    </form>
  );
}

/** Start a review that no automation starts, such as a content review. */
export function StartReview({ caseId }: { caseId: string }) {
  const [state, submit, pending] = useActionState(decide, IDLE);
  return (
    <form action={submit} className="stack" style={{ gap: 8 }}>
      <Hidden values={{ caseId, action: "start_review" }} />
      <Refusal state={state} />
      <div>
        <button className="btn btn-primary" type="submit" disabled={pending}>
          {pending ? "Starting…" : "Start the review"}
        </button>
      </div>
    </form>
  );
}

/* ---------------------------------------------------------------- operating */

export function OperatePanel({ assetId, actions, clearance }: { assetId: string; actions: readonly string[]; clearance: Clearance }) {
  if (actions.length === 0) return <p className="hint">Only admins change whether this is in use.</p>;
  return (
    <ActionChooser
      action={operate}
      hidden={{ assetId }}
      small
      choices={actions.map((a) => ({
        value: a,
        label: OPERATIONS[a]?.label ?? a,
        primary: a === "activate" || a === "resume",
        needsNote: OPERATIONS[a]?.needsReason ?? false,
        notePrompt: OPERATIONS[a]?.needsReason ? `Why ${OPERATIONS[a]!.label.toLowerCase()} it?` : undefined,
        disabledReason: OPERATIONS[a]?.needsClearance && !clearance.cleared ? clearance.reason : null,
      }))}
    />
  );
}

export function OpenReviewForm({ assetId, triggers }: { assetId: string; triggers: readonly CaseTrigger[] }) {
  const [state, action, pending] = useActionState(openReview, IDLE);
  const [trigger, setTrigger] = useState<CaseTrigger>(triggers[0] ?? "change");
  return (
    <form action={action} className="stack" style={{ gap: 10 }}>
      <Hidden values={{ assetId, trigger }} />
      {triggers.length > 1 ? (
        <div className="seg seg-sm" role="group" aria-label="Why re-review">
          {triggers.map((t) => (
            <button key={t} type="button" aria-pressed={trigger === t} onClick={() => setTrigger(t)}>
              {TRIGGER[t]}
            </button>
          ))}
        </div>
      ) : null}
      {trigger === "incident" ? <p className="hint">An open incident review takes away clearance until it is decided.</p> : null}
      <Refusal state={state} />
      <div>
        <button className="btn btn-primary" type="submit" disabled={pending}>
          {pending ? "Opening…" : triggers[0] === "initial" ? "Start its first review" : `Open a ${TRIGGER[trigger].toLowerCase()}`}
        </button>
      </div>
    </form>
  );
}

/* ----------------------------------------------------------------- evidence */

export function EvidenceForm({ assetId, controlId, conditionId, hint }: { assetId: string; controlId?: string; conditionId?: string; hint?: string }) {
  const [state, submit, pending] = useActionState(addEvidence, IDLE);
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<"link" | "attestation">("link");
  useEffect(() => {
    if (!state.error) setOpen(false);
  }, [state]);
  const key = controlId ?? conditionId;

  if (!open) {
    return (
      <button className="btn btn-sm" type="button" onClick={() => setOpen(true)}>
        Add evidence
      </button>
    );
  }
  return (
    <form action={submit} className="stack raised" style={{ gap: 10, width: "100%" }}>
      <Hidden values={{ assetId, kind, ...(controlId ? { controlId } : {}), ...(conditionId ? { conditionId } : {}) }} />
      <div className="seg seg-sm" role="group" aria-label="Evidence kind">
        <button type="button" aria-pressed={kind === "link"} onClick={() => setKind("link")}>
          Link to a document
        </button>
        <button type="button" aria-pressed={kind === "attestation"} onClick={() => setKind("attestation")}>
          Written attestation
        </button>
      </div>
      <div className="field">
        <label htmlFor={`title-${key}`}>Title</label>
        <input id={`title-${key}`} name="title" type="text" placeholder={hint} required autoFocus />
      </div>
      {kind === "link" ? (
        <div className="field">
          <label htmlFor={`url-${key}`}>Link</label>
          <input id={`url-${key}`} name="url" type="text" placeholder="https://" required />
        </div>
      ) : (
        <div className="field">
          <label htmlFor={`detail-${key}`}>What you attest to</label>
          <textarea id={`detail-${key}`} name="detail" required />
        </div>
      )}
      <Refusal state={state} />
      <div className="row" style={{ gap: 8 }}>
        <button className="btn btn-primary btn-sm" type="submit" disabled={pending}>
          {pending ? "Adding…" : "Add this evidence"}
        </button>
        <button className="btn btn-sm" type="button" onClick={() => setOpen(false)}>
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
      <Hidden values={{ assetId, evidenceId }} />
      <button className="link-button" type="submit" disabled={pending} title={state.error ?? "Withdraw this evidence"}>
        Withdraw
      </button>
    </form>
  );
}

/* --------------------------------------------------------------- exceptions */

export function ExceptionRequestForm({ assetId, controlId }: { assetId: string; controlId: string }) {
  const [state, submit, pending] = useActionState(requestException, IDLE);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!state.error) setOpen(false);
  }, [state]);

  if (!open) {
    return (
      <button className="btn btn-sm" type="button" onClick={() => setOpen(true)}>
        Request an exception
      </button>
    );
  }
  return (
    <form action={submit} className="stack raised" style={{ gap: 10, width: "100%" }}>
      <Hidden values={{ assetId, controlId }} />
      <div className="field">
        <label htmlFor={`reason-${controlId}`}>Why can&apos;t {controlId} be met yet?</label>
        <textarea id={`reason-${controlId}`} name="reason" required autoFocus />
      </div>
      <div className="field" style={{ maxWidth: 220 }}>
        <label htmlFor={`days-${controlId}`}>For how many days?</label>
        <input id={`days-${controlId}`} name="days" type="text" inputMode="numeric" defaultValue="90" />
      </div>
      <p className="hint">An approver other than you decides. The exception stops covering the control when it expires.</p>
      <Refusal state={state} />
      <div className="row" style={{ gap: 8 }}>
        <button className="btn btn-primary btn-sm" type="submit" disabled={pending}>
          {pending ? "Requesting…" : "Request the exception"}
        </button>
        <button className="btn btn-sm" type="button" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </form>
  );
}

const EXCEPTION_CHOICES: Record<string, Omit<Choice, "value">> = {
  approve: { label: "Approve the exception", primary: true, needsNote: false },
  reject: { label: "Reject the exception", needsNote: true, notePrompt: "Why reject it?" },
  revoke: { label: "Revoke the exception", needsNote: true, notePrompt: "Why revoke it?" },
};

export function ExceptionActions({ exceptionId, actions }: { exceptionId: string; actions: readonly string[] }) {
  return (
    <ActionChooser action={exceptionAction} hidden={{ exceptionId }} small choices={actions.map((a) => ({ value: a, ...EXCEPTION_CHOICES[a]! }))} />
  );
}

/* --------------------------------------------------------------- conditions */

export function ConditionActions({ conditionId, actions, evidenceCount }: { conditionId: string; actions: readonly string[]; evidenceCount: number }) {
  return (
    <ActionChooser
      action={conditionAction}
      hidden={{ conditionId }}
      small
      choices={actions.map((a) => ({
        value: a,
        label: CONDITION_ACTIONS[a]?.label ?? a,
        primary: a === "accept" || a === "submit",
        needsNote: CONDITION_ACTIONS[a]?.needsNote ?? false,
        notePrompt: CONDITION_ACTIONS[a]?.needsNote ? "Why?" : undefined,
        disabledReason: a === "submit" && evidenceCount === 0 ? "add evidence first" : null,
      }))}
    />
  );
}

export function Pending({ children }: { children: ReactNode }) {
  return (
    <p className="agent-note" role="status">
      <span className="mark mark-agent spin" style={{ "--size": "20px" } as React.CSSProperties} aria-hidden="true" />
      {children}
    </p>
  );
}
