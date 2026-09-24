"use client";

import { fastLaneEligibility, triage, type AssetKind } from "@aegis/domain";
import type { InitiativePack } from "@aegis/frameworks";
import { useActionState, useMemo, useState } from "react";
import { registerAndSubmit, submitIntake } from "@/app/(console)/registry/actions";
import { IDLE } from "@/lib/action-state";
import { ASSET_KIND, TIER } from "@/lib/labels";

type Mode = { kind: "register" } | { kind: "case"; caseId: string; previous: Record<string, unknown> };

const KINDS: { kind: AssetKind; available: boolean }[] = [
  { kind: "ai_system", available: true },
  { kind: "agent", available: true },
  { kind: "vendor_model", available: true },
  { kind: "content_item", available: false },
];

/**
 * The requester's form. Triage runs here as they answer, with the tenant's
 * own policy pack, so they see the tier, the reviews it triggers, and why,
 * before submitting. The server runs the same rules again on submit.
 */
export function IntakeForm({ pack, mode }: { pack: InitiativePack; mode: Mode }) {
  const [state, action, pending] = useActionState(mode.kind === "register" ? registerAndSubmit : submitIntake, IDLE);
  const [name, setName] = useState("");
  const [assetKind, setAssetKind] = useState<AssetKind>("ai_system");
  const [answers, setAnswers] = useState<Record<string, boolean>>(() => {
    if (mode.kind !== "case") return {};
    return Object.fromEntries(
      Object.entries(mode.previous).filter((entry): entry is [string, boolean] => typeof entry[1] === "boolean"),
    );
  });

  const left = pack.questions.filter((q) => typeof answers[q.field] !== "boolean").length;
  const complete = left === 0;
  const result = useMemo(() => triage(pack.triage, answers, pack.domains), [pack, answers]);
  const fastLane = fastLaneEligibility(pack.fastLane, { tier: result.tier, intakeComplete: complete, answers });
  const ready = complete && (mode.kind === "case" || name.trim().length > 0);

  return (
    <form action={action} className="grid-2">
      <input type="hidden" name="answers" value={JSON.stringify(answers)} />
      {mode.kind === "case" ? <input type="hidden" name="caseId" value={mode.caseId} /> : null}

      <div className="stack" style={{ gap: 20 }}>
        {mode.kind === "register" ? (
          <div className="card stack" style={{ gap: 18 }}>
            <div className="field">
              <label htmlFor="name">What is it called?</label>
              <input
                id="name"
                name="name"
                type="text"
                placeholder="e.g. Prior-auth letter drafter"
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoFocus
                autoComplete="off"
              />
            </div>
            <div className="field">
              <span className="label">What kind of thing is it?</span>
              <input type="hidden" name="kind" value={assetKind} />
              <div className="segmented" role="group" aria-label="Kind">
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

        <div className="stack">
          <div className="row" style={{ justifyContent: "space-between" }}>
            {mode.kind === "register" ? (
              <h2>Six questions decide the review</h2>
            ) : (
              <p className="muted">Your answers from last time are filled in. Change anything that is different now.</p>
            )}
            <span className="faint">{complete ? "All answered" : `${left} left`}</span>
          </div>
          {pack.questions.map((q) => (
            <div className="question" key={q.field} data-answered={typeof answers[q.field] === "boolean"}>
              <div className="question-text">
                <strong>{q.label}</strong>
                <span>{q.help}</span>
              </div>
              <div className="yesno" role="group" aria-label={q.label}>
                <button
                  type="button"
                  className="yes"
                  aria-pressed={answers[q.field] === true}
                  onClick={() => setAnswers({ ...answers, [q.field]: true })}
                >
                  Yes
                </button>
                <button
                  type="button"
                  aria-pressed={answers[q.field] === false}
                  onClick={() => setAnswers({ ...answers, [q.field]: false })}
                >
                  No
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>

      <aside className="card triage" aria-live="polite">
        <div className="stack" style={{ gap: 8 }}>
          <span className="eyebrow">{complete ? "Triage" : "Provisional triage"}</span>
          <div className="tier-big">{TIER[result.tier].label}</div>
          <div className="tier-meter" data-tier={result.tier}>
            <span />
            <span />
            <span />
            <span />
          </div>
        </div>

        <ul className="reasons">
          {result.explanation.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>

        <div className="stack" style={{ gap: 8 }}>
          <span className="label">Reviews required</span>
          <div className="row" style={{ gap: 6 }}>
            {result.domains.map((d) => (
              <span className="chip" key={d}>
                {pack.domains[d] ?? d}
              </span>
            ))}
          </div>
        </div>

        <div className={`banner ${fastLane.eligible ? "tone-good" : "tone-info"}`}>
          <span className="banner-icon" aria-hidden>
            {fastLane.eligible ? "⚡" : "◷"}
          </span>
          <div className="stack" style={{ gap: 4 }}>
            <strong>{fastLane.eligible ? "Fast lane: approved on submit" : "Full review"}</strong>
            <p className="muted" style={{ fontSize: 13 }}>
              {fastLane.eligible
                ? `Low risk under ${fastLane.policyId}. Accountable: ${fastLane.accountableApprover}.`
                : `Not fast-lane eligible: ${fastLane.reasons.join("; ")}.`}
            </p>
          </div>
        </div>

        {state.error ? <div className="error">{state.error}</div> : null}
        <button className="btn btn-primary btn-lg btn-block" type="submit" disabled={!ready || pending}>
          {pending ? "Submitting…" : fastLane.eligible ? "Submit and approve" : "Submit for review"}
        </button>
        <p className="faint" style={{ fontSize: 12.5 }}>
          Policy {pack.id} v{pack.version}. Triage is deterministic: the same answers always give the same result.
        </p>
      </aside>
    </form>
  );
}
