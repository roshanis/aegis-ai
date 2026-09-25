import {
  GovernanceError,
  type AssetView,
  type Case,
  type ConditionView,
  type ControlView,
  type EvidenceView,
  type HistoryEntry,
} from "@aegis/core";
import type { InitiativePack } from "@aegis/frameworks";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  ConditionActions,
  EvidenceForm,
  ExceptionActions,
  ExceptionRequestForm,
  ReviewActions,
  WithdrawEvidence,
} from "@/components/Assurance";
import { IntakeForm } from "@/components/IntakeForm";
import { DecisionPanel, OpenReviewForm, OperatePanel } from "@/components/Panels";
import { Pill } from "@/components/Pill";
import { governance } from "@/lib/db";
import {
  ASSET_KIND,
  ASSET_STATE,
  CASE_STATE,
  CONDITION_STATE,
  EXCEPTION_STATE,
  REVIEW_STATUS,
  TIER,
  TRIGGER,
  actorName,
  ago,
  describe,
  formatTime,
  nextStep,
} from "@/lib/labels";
import { requireViewer } from "@/lib/viewer";

export const metadata: Metadata = { title: "Asset" };

const TABS = [
  { id: "review", label: "Review" },
  { id: "controls", label: "Controls & evidence" },
  { id: "conditions", label: "Conditions" },
  { id: "history", label: "History" },
] as const;
type Tab = (typeof TABS)[number]["id"];

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

function TriageSummary({ review }: { review: Case }) {
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
    </div>
  );
}

function Evidence({ items, assetId }: { items: readonly EvidenceView[]; assetId: string }) {
  if (items.length === 0) return null;
  return (
    <ul className="evidence-list">
      {items.map((e) => (
        <li key={e.id}>
          <span className="evidence-kind" aria-hidden>
            {e.kind === "link" ? "↗" : "✎"}
          </span>
          <div className="stack" style={{ gap: 2 }}>
            {e.url ? (
              <a href={e.url} target="_blank" rel="noreferrer" className="evidence-title">
                {e.title}
              </a>
            ) : (
              <strong className="evidence-title">{e.title}</strong>
            )}
            {e.detail ? <span className="muted">{e.detail}</span> : null}
            <span className="faint" style={{ fontSize: 12.5 }}>
              {e.addedBy.name ?? "Someone removed"} · {ago(e.addedAt)}
              {e.canWithdraw ? (
                <>
                  {" · "}
                  <WithdrawEvidence assetId={assetId} evidenceId={e.id} />
                </>
              ) : null}
            </span>
          </div>
        </li>
      ))}
    </ul>
  );
}

function ControlStatus({ control }: { control: ControlView }) {
  if (control.exception && (control.exception.state === "approved" || control.exception.state === "requested")) {
    const x = EXCEPTION_STATE[control.exception.state];
    return <Pill tone={x.tone}>{x.label}</Pill>;
  }
  if (control.evidence.length > 0) return <Pill tone="good">Evidenced</Pill>;
  return control.enforcement === "gate" ? <Pill tone="bad">Missing evidence</Pill> : <Pill tone="neutral">Not yet evidenced</Pill>;
}

function ControlsTab({ view }: { view: AssetView }) {
  const { controls, canContribute, canRequestExceptions } = view.assurance;
  if (controls.length === 0) {
    return <p className="muted card">No controls apply yet. They appear once the intake is triaged.</p>;
  }
  const domains = [...new Set(controls.map((c) => c.domainLabel))];
  return (
    <div className="stack" style={{ gap: 20 }}>
      {domains.map((domain) => (
        <section className="card stack" key={domain} style={{ gap: 0, padding: 0 }}>
          <h2 style={{ padding: "16px 20px 4px" }}>{domain}</h2>
          {controls
            .filter((c) => c.domainLabel === domain)
            .map((control) => {
              const x = control.exception;
              const live = x && (x.state === "requested" || x.state === "approved");
              return (
                <article className="control" key={control.id} id={control.id}>
                  <div className="row" style={{ justifyContent: "space-between" }}>
                    <div className="row" style={{ gap: 8 }}>
                      <span className="mono chip">{control.id}</span>
                      <strong>{control.name}</strong>
                      <span className={`chip ${control.enforcement === "gate" ? "chip-gate" : ""}`}>
                        {control.enforcement === "gate" ? "Gate" : "Monitor"}
                      </span>
                    </div>
                    <ControlStatus control={control} />
                  </div>
                  <p className="faint" style={{ fontSize: 13 }}>
                    Expects: {control.requiredEvidence} · {control.cadence} · Helps evidence {control.frameworkRefs.join(", ")}
                  </p>
                  <Evidence items={control.evidence} assetId={view.asset.id} />
                  {x ? (
                    <div className={`exception tone-${EXCEPTION_STATE[x.state].tone}`}>
                      <div className="stack" style={{ gap: 4 }}>
                        <strong>
                          {EXCEPTION_STATE[x.state].label}
                          {x.state === "approved" && x.expiresAt ? ` until ${formatTime(x.expiresAt)}` : ` · ${x.days} days`}
                        </strong>
                        {x.reason ? <span style={{ color: "var(--text)" }}>{x.reason}</span> : null}
                        <span className="faint" style={{ fontSize: 12.5 }}>
                          Requested by {x.requestedBy.name ?? "someone removed"}
                          {x.decidedBy ? ` · decided by ${x.decidedBy.name ?? "someone removed"}` : ""}
                        </span>
                      </div>
                      {x.actions.length > 0 ? <ExceptionActions exceptionId={x.id} actions={x.actions} /> : null}
                    </div>
                  ) : null}
                  <div className="row" style={{ gap: 8 }}>
                    {canContribute && view.asset.state !== "retired" ? (
                      <EvidenceForm assetId={view.asset.id} controlId={control.id} hint={control.requiredEvidence} />
                    ) : null}
                    {canRequestExceptions && control.enforcement === "gate" && !control.covered && !live ? (
                      <ExceptionRequestForm assetId={view.asset.id} controlId={control.id} />
                    ) : null}
                  </div>
                </article>
              );
            })}
        </section>
      ))}
    </div>
  );
}

function ConditionsTab({ view }: { view: AssetView }) {
  const { conditions, canContribute } = view.assurance;
  if (conditions.length === 0) {
    return <p className="muted card">No conditions. They appear when a review is approved with conditions.</p>;
  }
  return (
    <section className="card stack" style={{ gap: 0, padding: 0 }}>
      {conditions.map((c: ConditionView) => {
        const state = CONDITION_STATE[c.state];
        return (
          <article className="control" key={c.id}>
            <div className="row" style={{ justifyContent: "space-between" }}>
              <strong>{c.text ?? "Condition text erased at a person's request"}</strong>
              <div className="row" style={{ gap: 6 }}>
                <span className="chip">{c.due === "before_use" ? "Before use" : "Ongoing"}</span>
                <Pill tone={state.tone}>{state.label}</Pill>
              </div>
            </div>
            <Evidence items={c.evidence} assetId={view.asset.id} />
            <div className="stack" style={{ gap: 8 }}>
              {canContribute && (c.state === "open" || c.state === "submitted") ? (
                <div>
                  <EvidenceForm assetId={view.asset.id} conditionId={c.id} />
                </div>
              ) : null}
              {c.actions.length > 0 ? (
                <ConditionActions conditionId={c.id} actions={c.actions} evidenceCount={c.evidence.length} />
              ) : null}
            </div>
          </article>
        );
      })}
    </section>
  );
}

function Reason({ entry }: { entry: HistoryEntry }) {
  if (entry.reasonStatus === "none") return null;
  if (entry.reasonStatus === "erased") {
    return <p className="quote erased">Text erased at a person&apos;s request. The log keeps its fingerprint.</p>;
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

function HistoryTab({
  history,
  labels,
  triggerOf,
}: {
  history: readonly HistoryEntry[];
  labels: Record<string, string>;
  triggerOf: Map<string, Case["trigger"]>;
}) {
  return (
    <section className="card">
      <div className="card-head">
        <p className="faint" style={{ fontSize: 13 }}>
          Every change, who made it, why, and under which policy. Newest first. Recorded in a tamper-evident log.
        </p>
      </div>
      <ol className="timeline">
        {history.map((entry, i) => (
          <li className="event" key={i} data-decision={entry.decision}>
            <span className="dot" aria-hidden />
            <div className="event-body">
              <span>
                <strong>{actorName(entry.actor)}</strong> {describe(entry, labels)}
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
  );
}

export default async function AssetPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  const [{ id }, { tab: requested }] = await Promise.all([params, searchParams]);
  const tab: Tab = TABS.some((t) => t.id === requested) ? (requested as Tab) : "review";
  const { principal } = await requireViewer();
  const gov = await governance();

  let view: AssetView;
  try {
    view = await gov.getAsset(principal, id);
  } catch (error) {
    if (error instanceof GovernanceError && error.code === "not_found") notFound();
    throw error;
  }
  const history = (await gov.assetHistory(principal, id)).slice().reverse();
  const { asset, openCase, clearance, actions, assurance } = view;
  const state = ASSET_STATE[asset.state];
  const step = nextStep(view);
  const mustAnswer = openCase && (actions.openCase.includes("submit") || actions.openCase.includes("resubmit"));
  const decisions = actions.openCase.filter((a) => a !== "submit" && a !== "resubmit");
  const pack = mustAnswer ? ((await gov.policyPack(principal, { caseId: openCase.id })) as InitiativePack) : null;
  const previous = view.cases.filter((c) => Object.keys(c.answers).length > 0).at(-1)?.answers ?? {};
  const triggerOf = new Map(view.cases.map((c) => [c.id, c.trigger]));
  const latest = openCase ?? view.cases.at(-1) ?? null;
  const labels = Object.fromEntries([
    ...assurance.reviews.map((r) => [r.domain, r.label]),
    ...assurance.controls.map((c) => [c.domain, c.domainLabel]),
  ]);
  const proposals = assurance.reviews.flatMap((r) => r.proposedConditions);
  const blockers = clearance.cleared ? [] : clearance.reason.split("; ");
  const signed = assurance.reviews.filter((r) => r.status === "signed" || r.status === "abstained").length;
  const covered = assurance.controls.filter((c) => c.covered).length;
  const openConditions = assurance.conditions.filter((c) => c.state === "open" || c.state === "submitted").length;
  const counts: Record<Tab, string | null> = {
    review: assurance.reviews.length > 0 ? `${signed}/${assurance.reviews.length}` : null,
    controls: assurance.controls.length > 0 ? `${covered}/${assurance.controls.length}` : null,
    conditions: openConditions > 0 ? `${openConditions} open` : null,
    history: String(history.length),
  };

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
        {clearance.cleared ? (
          <p>
            <strong>Cleared for use.</strong> Approved in its{" "}
            {TRIGGER[triggerOf.get(clearance.caseId) ?? "initial"].toLowerCase()}, with every gate control covered.
          </p>
        ) : blockers.length > 1 ? (
          <div className="stack" style={{ gap: 4 }}>
            <strong>Not cleared for use:</strong>
            <ul className="blockers">
              {blockers.map((b) => (
                <li key={b}>{b}</li>
              ))}
            </ul>
          </div>
        ) : (
          <p>
            <strong>Not cleared for use:</strong> {blockers[0]}.
          </p>
        )}
      </div>

      {step ? (
        <div className={`next-step tone-${step.tone}`}>
          <span className="eyebrow">Your next step</span>
          <strong>{step.label}</strong>
        </div>
      ) : null}

      {mustAnswer && pack ? (
        <section className="stack">
          <h2>Answer the {TRIGGER[openCase.trigger].toLowerCase()}</h2>
          <IntakeForm pack={pack} mode={{ kind: "case", caseId: openCase.id, previous }} />
        </section>
      ) : null}

      <nav className="tabs" aria-label="Asset sections">
        {TABS.map((t) => (
          <Link key={t.id} href={t.id === "review" ? `/registry/${id}` : `/registry/${id}?tab=${t.id}`} aria-current={tab === t.id ? "page" : undefined}>
            {t.label}
            {counts[t.id] ? <span className="tab-count">{counts[t.id]}</span> : null}
          </Link>
        ))}
      </nav>

      {tab === "review" ? (
        <div className="grid-2">
          <div className="stack" style={{ gap: 20 }}>
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
              {latest ? <TriageSummary review={latest} /> : <p className="muted">No review has been started.</p>}

              {openCase && decisions.length > 0 ? (
                <div className="stack" style={{ borderTop: "1px solid var(--border)", paddingTop: 16 }}>
                  <h3>Your decision</h3>
                  <DecisionPanel caseId={openCase.id} actions={decisions} readiness={assurance.readiness} proposals={proposals} />
                </div>
              ) : openCase && !mustAnswer && assurance.reviews.length === 0 ? (
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

            {assurance.reviews.length > 0 ? (
              <section className="card stack" style={{ gap: 0, padding: 0 }}>
                <div style={{ padding: "16px 20px 6px" }}>
                  <h2>Domain reviews</h2>
                  <p className="faint" style={{ fontSize: 13, marginTop: 4 }}>
                    {assurance.readiness?.reason ?? "Each required domain signs off before a decision."}
                  </p>
                </div>
                {assurance.reviews.map((r) => {
                  const status = REVIEW_STATUS[r.status];
                  return (
                    <article className="control" key={r.id}>
                      <div className="row" style={{ justifyContent: "space-between" }}>
                        <strong>{r.label}</strong>
                        <div className="row" style={{ gap: 8 }}>
                          {r.reviewer ? <span className="faint" style={{ fontSize: 13 }}>{r.reviewer.name}</span> : null}
                          <Pill tone={status.tone}>{status.label}</Pill>
                        </div>
                      </div>
                      {r.note ? <p className="quote">{r.note}</p> : null}
                      {r.proposedConditions.length > 0 ? (
                        <ul className="reasons">
                          {r.proposedConditions.map((p) => (
                            <li key={p}>Proposed condition: {p}</li>
                          ))}
                        </ul>
                      ) : null}
                      {r.uncoveredGates.length > 0 && r.status !== "signed" ? (
                        <p className="faint" style={{ fontSize: 13 }}>
                          Needs evidence or an exception for{" "}
                          <Link href={`/registry/${id}?tab=controls`} className="inline-link">
                            {r.uncoveredGates.join(", ")}
                          </Link>
                        </p>
                      ) : null}
                      {r.actions.length > 0 ? (
                        <ReviewActions
                          caseId={r.caseId}
                          domain={r.domain}
                          revision={r.revision}
                          actions={r.actions}
                          uncoveredGates={r.uncoveredGates}
                        />
                      ) : null}
                    </article>
                  );
                })}
              </section>
            ) : null}
          </div>

          <div className="stack" style={{ gap: 20 }}>
            <section className="card stack">
              <h2>In use?</h2>
              <OperatePanel assetId={asset.id} actions={actions.asset} clearance={clearance} />
            </section>
            <section className="card stack">
              <h2>Reviews</h2>
              {view.cases.length === 0 ? <p className="muted">None yet.</p> : null}
              {view.cases
                .slice()
                .reverse()
                .map((c) => (
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
      ) : null}
      {tab === "controls" ? <ControlsTab view={view} /> : null}
      {tab === "conditions" ? <ConditionsTab view={view} /> : null}
      {tab === "history" ? <HistoryTab history={history} labels={labels} triggerOf={triggerOf} /> : null}
    </>
  );
}
