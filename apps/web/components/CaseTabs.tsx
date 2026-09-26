import type { AssetView, ControlView, EvidenceView, HistoryEntry } from "@aegis/core";
import { caseLabel, type ReviewDraft } from "@aegis/domain";
import { ActorMark, Tag } from "./ds";
import { ConditionActions, EvidenceForm, ExceptionActions, ExceptionRequestForm, WithdrawEvidence } from "./Forms";
import { CONDITION_STATE, EXCEPTION_STATE, actorName, ago, describe, formatDate, formatTime, hash4 } from "@/lib/labels";

/** The case page's other tabs: controls and evidence, conditions, and the history the audit log tells. */

function Evidence({ items, assetId }: { items: readonly EvidenceView[]; assetId: string }) {
  if (items.length === 0) return null;
  return (
    <ul className="stack" style={{ gap: 8 }}>
      {items.map((e) => (
        <li key={e.id} className="raised stack" style={{ gap: 2 }}>
          <span className="row" style={{ gap: 8 }}>
            <Tag>{e.kind === "link" ? "Link" : "Attestation"}</Tag>
            {e.url ? (
              <a href={e.url} target="_blank" rel="noreferrer">
                {e.title}
              </a>
            ) : (
              <strong>{e.title}</strong>
            )}
          </span>
          {e.detail ? <span>{e.detail}</span> : null}
          <span className="caption muted">
            {e.addedBy.name ?? "A removed person"} · {ago(e.addedAt)}
            {e.canWithdraw ? (
              <>
                {" · "}
                <WithdrawEvidence assetId={assetId} evidenceId={e.id} />
              </>
            ) : null}
          </span>
        </li>
      ))}
    </ul>
  );
}

function ControlStatus({ control }: { control: ControlView }) {
  const x = control.exception;
  if (x && (x.state === "approved" || x.state === "requested")) return <Tag tone={EXCEPTION_STATE[x.state].tone}>{EXCEPTION_STATE[x.state].label}</Tag>;
  if (control.evidence.length > 0) return <Tag tone="ok">Evidenced</Tag>;
  return control.enforcement === "gate" ? <Tag tone="bad">Missing evidence</Tag> : <Tag>Not yet evidenced</Tag>;
}

export function ControlsTab({ view }: { view: AssetView }) {
  const { controls, canContribute, canRequestExceptions } = view.assurance;
  if (controls.length === 0) return <p className="empty">No controls apply yet. They appear once the intake is triaged.</p>;
  const domains = [...new Set(controls.map((c) => c.domainLabel))];
  return (
    <div className="stack" style={{ gap: 18 }}>
      {domains.map((domain) => (
        <section className="panel stack" key={domain} style={{ gap: 0, padding: 0 }} aria-label={domain}>
          <h2 className="section-title" style={{ padding: "16px 22px 8px" }}>
            {domain}
          </h2>
          {controls
            .filter((c) => c.domainLabel === domain)
            .map((control) => {
              const x = control.exception;
              const live = x && (x.state === "requested" || x.state === "approved");
              return (
                <article className="stack" key={control.id} id={control.id} style={{ gap: 10, padding: "16px 22px", borderTop: "1px solid var(--line)" }}>
                  <div className="spread">
                    <div className="row" style={{ gap: 10 }}>
                      <span className="mono">{control.id}</span>
                      <strong>{control.name}</strong>
                      <Tag tone={control.enforcement === "gate" ? "warn" : "neutral"}>{control.enforcement === "gate" ? "Gate" : "Monitor"}</Tag>
                    </div>
                    <ControlStatus control={control} />
                  </div>
                  <p className="mono-s muted" title={`Helps evidence ${control.frameworkRefs.join(", ")}`}>
                    {control.requiredEvidence} · {control.cadence}
                  </p>
                  <Evidence items={control.evidence} assetId={view.asset.id} />
                  {x ? (
                    <div className="raised stack" style={{ gap: 6 }}>
                      <strong>
                        {EXCEPTION_STATE[x.state].label}
                        {x.state === "approved" && x.expiresAt ? ` until ${formatTime(x.expiresAt)}` : ` · ${x.days} days`}
                      </strong>
                      {x.reason ? <span className="said">{x.reason}</span> : null}
                      <span className="caption muted">
                        Requested by {x.requestedBy.name ?? "a removed person"}
                        {x.decidedBy ? ` · decided by ${x.decidedBy.name ?? "a removed person"}` : ""}
                      </span>
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

export function ConditionsTab({ view }: { view: AssetView }) {
  const { conditions, canContribute } = view.assurance;
  if (conditions.length === 0) return <p className="empty">No conditions. They appear when a review is approved with conditions.</p>;
  const number = new Map(view.cases.map((c) => [c.id, c.number]));
  return (
    <section className="panel stack" style={{ gap: 0, padding: 0 }} aria-label="Conditions">
      {conditions.map((c) => {
        const state = CONDITION_STATE[c.state];
        return (
          <article className="stack" key={c.id} style={{ gap: 10, padding: "16px 22px", borderTop: "1px solid var(--line)" }} aria-label={c.text ?? "Condition"}>
            <div className="spread">
              <strong>{c.text ?? "Condition text erased at a person's request"}</strong>
              <div className="row" style={{ gap: 6 }}>
                <span className="mono-s muted">{caseLabel(number.get(c.caseId) ?? 0)}</span>
                <Tag>{c.due === "before_use" ? "Before use" : "Ongoing"}</Tag>
                <Tag tone={state.tone}>{state.label}</Tag>
              </div>
            </div>
            <Evidence items={c.evidence} assetId={view.asset.id} />
            {canContribute && (c.state === "open" || c.state === "submitted") ? (
              <div>
                <EvidenceForm assetId={view.asset.id} conditionId={c.id} />
              </div>
            ) : null}
            {c.actions.length > 0 ? <ConditionActions conditionId={c.id} actions={c.actions} evidenceCount={c.evidence.length} /> : null}
          </article>
        );
      })}
    </section>
  );
}

function draftSummary(body: string | null): string | null {
  try {
    const draft = JSON.parse(body ?? "") as ReviewDraft;
    const n = draft.findings.length;
    return `${draft.summary}${n > 0 ? ` (${n} finding${n === 1 ? "" : "s"})` : ""}`;
  } catch {
    return body;
  }
}

function Said({ entry }: { entry: HistoryEntry }) {
  if (entry.reasonStatus === "none") return null;
  if (entry.reasonStatus === "erased") {
    return (
      <p className="said" data-status="erased">
        Text erased at a person&apos;s request. The audit log keeps its fingerprint.
      </p>
    );
  }
  return (
    <p className="said" data-status={entry.reasonStatus}>
      {entry.action === "review.draft" ? draftSummary(entry.reason) : entry.reason}
      {entry.reasonStatus === "altered" ? (
        <strong className="status-bad" style={{ display: "block", fontFamily: "var(--font-sans)", fontSize: 13 }}>
          This text no longer matches what the audit log recorded.
        </strong>
      ) : null}
    </p>
  );
}

export function HistoryTab({ history, labels }: { history: readonly HistoryEntry[]; labels: Record<string, string> }) {
  return (
    <section className="panel stack" style={{ gap: 16 }} aria-label="History">
      <ol className="timeline">
        {history.map((entry) => (
          <li key={entry.id} data-decision={entry.decision}>
            <ActorMark kind={entry.actor.kind} name={entry.actor.name} size={32} />
            <div className="event-body">
              <span>
                <strong>{actorName(entry.actor)}</strong> {entry.actor.kind === "agent" ? <Tag tone="agent">AI agent · draft only</Tag> : null} {describe(entry, labels)}
                {entry.decision ? (
                  <>
                    {" "}
                    <Tag tone="seal">Decision</Tag>
                  </>
                ) : null}
              </span>
              <span className="event-meta">
                <time dateTime={entry.at.toISOString()} title={formatTime(entry.at)}>
                  {formatDate(entry.at)} · {ago(entry.at)}
                </time>
                {entry.caseNumber ? <span>{caseLabel(entry.caseNumber)}</span> : null}
                {entry.policy ? (
                  <span>
                    {entry.policy.packId}@{entry.policy.packVersion}
                  </span>
                ) : null}
                <span title={entry.hash}>#{hash4(entry.hash)}</span>
              </span>
              <Said entry={entry} />
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
