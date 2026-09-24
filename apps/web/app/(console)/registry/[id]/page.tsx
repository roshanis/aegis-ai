import { GovernanceError, type Case, type HistoryEntry } from "@aegis/core";
import type { InitiativePack } from "@aegis/frameworks";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { IntakeForm } from "@/components/IntakeForm";
import { DecisionPanel, OpenReviewForm, OperatePanel } from "@/components/Panels";
import { Pill } from "@/components/Pill";
import { governance } from "@/lib/db";
import {
  ASSET_KIND,
  ASSET_STATE,
  CASE_STATE,
  TIER,
  TRIGGER,
  actorName,
  ago,
  describe,
  formatTime,
} from "@/lib/labels";
import { requireViewer } from "@/lib/viewer";

export const metadata: Metadata = { title: "Asset" };

const STEPS = ["Intake", "Triage", "Review", "Decision"];
const PROGRESS: Record<string, number> = {
  draft: 0,
  changes_requested: 0,
  submitted: 1,
  triaged: 2,
  in_review: 2,
  ai_reviewed: 2,
};

function Stepper({ review }: { review: Case }) {
  const at = review.decidedAt ? STEPS.length : (PROGRESS[review.state] ?? 0);
  return (
    <div className="stepper" style={{ gridTemplateColumns: `repeat(${STEPS.length}, 1fr)` }}>
      {STEPS.map((step, i) => (
        <span className="step" key={step} data-state={i < at ? "done" : i === at ? "current" : "todo"}>
          {step}
        </span>
      ))}
    </div>
  );
}

function TriageSummary({ review, labels }: { review: Case; labels: Readonly<Record<string, string>> }) {
  if (!review.triage) return null;
  const tier = TIER[review.triage.tier];
  return (
    <div className="stack" style={{ gap: 10 }}>
      <div className="row">
        <Pill tone={tier.tone}>{tier.label}</Pill>
        <span className="faint" style={{ fontSize: 13 }}>
          under {review.packId} v{review.packVersion}
        </span>
      </div>
      <ul className="reasons">
        {review.triage.explanation.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      <div className="row" style={{ gap: 6 }}>
        {review.triage.domains.map((d) => (
          <span className="chip" key={d}>
            {labels[d] ?? d}
          </span>
        ))}
      </div>
    </div>
  );
}

function Reason({ entry }: { entry: HistoryEntry }) {
  if (entry.reasonStatus === "none") return null;
  if (entry.reasonStatus === "erased") {
    return <p className="quote erased">Reason erased at a person&apos;s request. The log keeps its fingerprint.</p>;
  }
  return (
    <p className={`quote${entry.reasonStatus === "altered" ? " altered" : ""}`}>
      {entry.reason}
      {entry.reasonStatus === "altered" ? (
        <strong style={{ color: "var(--bad)", display: "block", fontSize: 12.5 }}>
          This text no longer matches what the audit log recorded.
        </strong>
      ) : null}
    </p>
  );
}

export default async function AssetPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { principal } = await requireViewer();
  const gov = await governance();

  let view;
  try {
    view = await gov.getAsset(principal, id);
  } catch (error) {
    if (error instanceof GovernanceError && error.code === "not_found") notFound();
    throw error;
  }
  const history = (await gov.assetHistory(principal, id)).slice().reverse();
  const { asset, openCase, clearance, actions } = view;
  const state = ASSET_STATE[asset.state];
  const mustAnswer = openCase && (actions.openCase.includes("submit") || actions.openCase.includes("resubmit"));
  const decisions = actions.openCase.filter((a) => a !== "submit" && a !== "resubmit");
  const latest = openCase ?? view.cases.at(-1) ?? null;
  const pack = latest ? ((await gov.policyPack(principal, { caseId: latest.id })) as InitiativePack | null) : null;
  const previous = view.cases.filter((c) => Object.keys(c.answers).length > 0).at(-1)?.answers ?? {};
  const triggerOf = new Map(view.cases.map((c) => [c.id, c.trigger]));

  return (
    <>
      <div className="page-head">
        <div>
          <div className="crumbs">
            <Link href="/registry">Registry</Link> / <span>{asset.name}</span>
          </div>
          <div className="row" style={{ marginTop: 6 }}>
            <h1>{asset.name}</h1>
            <Pill tone={state.tone}>{state.label}</Pill>
          </div>
          <p className="muted">
            {ASSET_KIND[asset.kind]} · owned by {view.ownerName ?? "a removed user"}
          </p>
        </div>
      </div>

      <div className={`banner tone-${clearance.cleared ? "good" : asset.state === "retired" ? "neutral" : "warn"}`}>
        <span className="banner-icon" aria-hidden>
          {clearance.cleared ? "✓" : "!"}
        </span>
        <p>
          {clearance.cleared ? (
            <>
              <strong>Cleared for use.</strong> Approved in its {TRIGGER[triggerOf.get(clearance.caseId) ?? "initial"].toLowerCase()}.
            </>
          ) : (
            <>
              <strong>Not cleared for use:</strong> {clearance.reason}.
            </>
          )}
        </p>
      </div>

      {mustAnswer && pack ? (
        <section className="stack">
          <h2>Answer the {TRIGGER[openCase.trigger].toLowerCase()}</h2>
          <IntakeForm pack={pack} mode={{ kind: "case", caseId: openCase.id, previous }} />
        </section>
      ) : null}

      <div className="grid-2">
        <section className="card stack" style={{ gap: 16 }}>
          <div className="card-head" style={{ marginBottom: 0 }}>
            <h2>{latest ? TRIGGER[latest.trigger] : "Review"}</h2>
            {latest ? (
              <Pill tone={CASE_STATE[latest.state]?.tone ?? "neutral"} plain>
                {CASE_STATE[latest.state]?.label ?? latest.state}
              </Pill>
            ) : null}
          </div>
          {latest ? <Stepper review={latest} /> : null}
          {latest ? (
            <TriageSummary review={latest} labels={pack?.domains ?? {}} />
          ) : (
            <p className="muted">No review has been started.</p>
          )}

          {openCase && decisions.length > 0 ? (
            <div className="stack" style={{ borderTop: "1px solid var(--border)", paddingTop: 16 }}>
              <h3>Your decision</h3>
              <DecisionPanel caseId={openCase.id} actions={decisions} />
            </div>
          ) : openCase && !mustAnswer ? (
            <p className="faint">
              {openCase.state === "draft" || openCase.state === "changes_requested"
                ? `Waiting on ${view.ownerName ?? "the owner"} to answer the intake.`
                : "Waiting on an approver's decision."}
            </p>
          ) : null}

          {!openCase && actions.newCase.length > 0 ? (
            <div className="stack" style={{ borderTop: "1px solid var(--border)", paddingTop: 16 }}>
              <h3>{actions.newCase[0] === "initial" ? "Start its review" : "Re-review"}</h3>
              <OpenReviewForm assetId={asset.id} triggers={actions.newCase} />
            </div>
          ) : null}
        </section>

        <div className="stack" style={{ gap: 20 }}>
          <section className="card stack">
            <h2>In use?</h2>
            <OperatePanel assetId={asset.id} actions={actions.asset} clearance={clearance} />
          </section>
          <section className="card stack">
            <h2>Reviews</h2>
            {view.cases.length === 0 ? <p className="muted">None yet.</p> : null}
            {view.cases.slice().reverse().map((c) => (
              <div className="row" key={c.id} style={{ justifyContent: "space-between" }}>
                <span>
                  {TRIGGER[c.trigger]}
                  <span className="faint" style={{ display: "block", fontSize: 12.5 }}>
                    {c.decidedAt ? `Decided ${formatTime(c.decidedAt)}` : "Under way"}
                    {c.tier ? ` · ${TIER[c.tier].label.toLowerCase()}` : ""}
                  </span>
                </span>
                <Pill tone={CASE_STATE[c.state]?.tone ?? "neutral"} plain>
                  {CASE_STATE[c.state]?.label ?? c.state}
                </Pill>
              </div>
            ))}
          </section>
        </div>
      </div>

      <section className="card">
        <div className="card-head">
          <div>
            <h2>History</h2>
            <p className="faint" style={{ fontSize: 13, marginTop: 4 }}>
              Every change, who made it, why, and under which policy. Newest first. Recorded in a tamper-evident log.
            </p>
          </div>
        </div>
        <ol className="timeline">
          {history.map((entry, i) => (
            <li className="event" key={i} data-decision={entry.decision}>
              <span className="dot" aria-hidden />
              <div className="event-body">
                <span>
                  <strong>{actorName(entry.actor)}</strong> {describe(entry)}
                  {entry.decision ? (
                    <>
                      {" "}
                      <Pill tone={CASE_STATE[entry.after ?? ""]?.tone ?? "neutral"} plain>
                        Decision
                      </Pill>
                    </>
                  ) : null}
                </span>
                <span className="event-meta">
                  <time dateTime={entry.at.toISOString()} title={formatTime(entry.at)}>
                    {formatTime(entry.at)} · {ago(entry.at)}
                  </time>
                  {entry.caseId ? <span>{TRIGGER[triggerOf.get(entry.caseId) ?? "initial"]}</span> : null}
                  {entry.policy ? (
                    <span>
                      Policy {entry.policy.packId} v{entry.policy.packVersion}
                    </span>
                  ) : null}
                </span>
                <Reason entry={entry} />
              </div>
            </li>
          ))}
        </ol>
      </section>
    </>
  );
}
