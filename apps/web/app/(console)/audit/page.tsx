import type { CaseRecord, ChainStatus, HistoryEntry } from "@aegis/core";
import { can, caseLabel } from "@aegis/domain";
import type { Metadata } from "next";
import Link from "next/link";
import { CopyLink } from "@/components/CopyLink";
import { ActorMark, Icon, TIER_NAME, Tag } from "@/components/ds";
import { governance } from "@/lib/db";
import { refusal } from "@/lib/errors";
import { CASE_STATE, actorName, clock, describe, formatDate, formatTime, hash4, initials } from "@/lib/labels";
import { requireViewer } from "@/lib/viewer";

export const metadata: Metadata = { title: "Audit log" };

const WHO = [
  { id: "all", label: "Everyone" },
  { id: "human", label: "People" },
  { id: "system", label: "Systems" },
  { id: "agent", label: "Agents" },
] as const;

const VERB: Record<string, string> = {
  approved: "Approved",
  conditionally_approved: "Conditionally approved",
  fast_lane_approved: "Approved in the fast lane",
  rejected: "Rejected",
};

function ChainLine({ chain }: { chain: ChainStatus }) {
  return (
    <p className={`mono-s ${chain.intact ? "muted" : "status-bad"}`}>
      {chain.intact
        ? `Hash chain verified · ${chain.events} events · latest #${hash4(chain.latest)}`
        : `Hash chain broken at event ${chain.brokenAt}. Something changed the log outside Aegis.`}
    </p>
  );
}

function Answer({ r, canExport, chain }: { r: CaseRecord; canExport: boolean; chain: ChainStatus }) {
  const d = r.decision;
  const labels = Object.fromEntries(r.signoffs.map((s) => [s.domain, s.label]));
  const signed = r.signoffs.filter((s) => s.status === "signed").length;
  const drafts = r.events.filter((e) => e.actor.kind === "agent").length;
  const beforeUse = r.conditions.filter((c) => c.due === "before_use").length;
  return (
    <>
      <section className="answer" aria-labelledby="answer-h">
        <div className="answer-seal" data-actor={d?.actor.kind ?? "pending"} aria-hidden="true">
          {d ? <span>{d.actor.kind === "human" ? initials(d.actor.name ?? "?") : "RULES"}</span> : <span className="mark mark-pending" style={{ "--size": "96px" } as React.CSSProperties} />}
        </div>
        <div className="stack" style={{ gap: 14, minWidth: 0 }}>
          <span className="eyebrow">
            {r.label} · based on {r.events.length} events
          </span>
          <h2 id="answer-h">
            {d ? (
              <>
                <em>{VERB[d.after ?? ""] ?? d.after}</em> by {actorName(d.actor)} on {formatDate(d.at)}
              </>
            ) : (
              <>
                <em>{CASE_STATE[r.case.state]?.label ?? r.case.state}</em>, not decided yet
              </>
            )}
          </h2>
          <p className="muted">
            {r.asset.name} · owned by {r.ownerName ?? "a removed person"} · <Link href={`/registry/${r.asset.id}`}>open the case</Link>
          </p>
          {d?.reason ? <blockquote className="quote">“{d.reason}”</blockquote> : null}
          {d?.reasonStatus === "erased" ? <p className="hint">The written reason was erased at a person&apos;s request. The audit log keeps its fingerprint.</p> : null}
          <div className="row" style={{ gap: 10 }}>
            {canExport ? (
              <a className="btn btn-primary" href={`/audit/export/${r.case.id}`} download>
                <Icon name="download" size={16} />
                Export evidence pack
              </a>
            ) : null}
            <CopyLink />
          </div>
          <dl className="facts">
            <div>
              <dt>Policy</dt>
              <dd className="mono">
                {r.case.packId}@{r.case.packVersion}
              </dd>
            </div>
            <div>
              <dt>Rule fired</dt>
              <dd>
                <span className="mono">{r.tierRule?.id ?? "none matched"}</span>
                {r.case.tier ? ` · ${TIER_NAME[r.case.tier]} risk` : ""}
              </dd>
            </div>
            <div>
              <dt>Sign-offs</dt>
              <dd>{r.signoffs.length === 0 ? "None needed" : `${signed} of ${r.signoffs.length} signed`}</dd>
            </div>
            <div>
              <dt>Conditions</dt>
              <dd>{r.conditions.length === 0 ? "None" : `${r.conditions.length}, ${beforeUse} before use`}</dd>
            </div>
            <div>
              <dt>Fast lane</dt>
              <dd>{r.fastLane ? `${r.fastLane.policyId}, accountable: ${r.fastLane.accountableApprover}` : "Not used"}</dd>
            </div>
            <div>
              <dt>Agent actions</dt>
              <dd>{drafts === 0 ? "None" : `${drafts} draft${drafts === 1 ? "" : "s"}, no decisions`}</dd>
            </div>
          </dl>
        </div>
      </section>

      <section className="stack" aria-labelledby="chain-h">
        <h2 id="chain-h" className="eyebrow">
          Events for {r.label}
        </h2>
        <ol className="chain">
          {r.events.map((e, i) => (
            <li key={e.id} className="chain-event" data-actor={e.actor.kind} data-decision={e.decision || i === r.events.length - 1}>
              <span className="row" style={{ gap: 8 }}>
                <ActorMark kind={e.actor.kind} name={e.actor.name} size={22} />
                <span className="mono-s muted">
                  {formatDate(e.at)} {clock(e.at)}
                </span>
              </span>
              <strong>{actorName(e.actor)}</strong>
              <span>{describe(e, labels)}</span>
              <span className="mono-s muted" title={e.hash}>
                #{hash4(e.hash)}
              </span>
            </li>
          ))}
        </ol>
        <ChainLine chain={chain} />
      </section>
    </>
  );
}

function Log({ events, who, labels }: { events: readonly HistoryEntry[]; who: string; labels: Record<string, string> }) {
  return (
    <section className="stack" aria-labelledby="log-h">
      <div className="spread">
        <h2 id="log-h" className="eyebrow">
          Latest events
        </h2>
        <nav className="pills" aria-label="Filter by who acted">
          {WHO.map((w) => (
            <Link key={w.id} className="pill" href={w.id === "all" ? "/audit" : `/audit?who=${w.id}`} aria-current={who === w.id ? "true" : undefined}>
              {w.label}
            </Link>
          ))}
        </nav>
      </div>
      <div className="panel panel-flush">
        {events.length === 0 ? (
          <p className="hint" style={{ padding: 22 }}>
            No events.
          </p>
        ) : (
          <ol className="log">
            {events.map((e) => (
              <li key={e.id}>
                <ActorMark kind={e.actor.kind} name={e.actor.name} size={22} />
                <time className="mono-s muted" dateTime={e.at.toISOString()} title={formatTime(e.at)}>
                  {formatDate(e.at)} {clock(e.at)}
                </time>
                <span>
                  <strong>{actorName(e.actor)}</strong> {describe(e, labels)}
                  {e.assetName ? (
                    <>
                      {" · "}
                      {e.caseId ? <Link href={`/audit?case=${e.caseId}`}>{e.caseNumber ? caseLabel(e.caseNumber) : e.assetName}</Link> : e.assetName}
                    </>
                  ) : null}
                </span>
                <span className="mono-s muted" title={e.hash}>
                  #{hash4(e.hash)}
                </span>
              </li>
            ))}
          </ol>
        )}
      </div>
    </section>
  );
}

export default async function AuditPage({ searchParams }: { searchParams: Promise<{ q?: string; case?: string; who?: string }> }) {
  const query = await searchParams;
  const { principal } = await requireViewer();
  const gov = await governance();
  const q = (query.q ?? "").trim();
  const who = WHO.some((w) => w.id === query.who) ? query.who! : "all";

  const matches = q && !query.case ? await gov.findCases(principal, q) : [];
  const caseId = query.case ?? (matches.length === 1 ? matches[0]!.caseId : null);
  let record: CaseRecord | null = null;
  if (caseId) {
    try {
      record = await gov.caseRecord(principal, caseId);
    } catch (error) {
      if (refusal(error)?.code !== "not_found") throw error;
    }
  }
  const { events, chain } = await gov.auditLog(principal, {
    limit: 25,
    ...(who !== "all" ? { actorKind: who as HistoryEntry["actor"]["kind"] } : {}),
  });
  const related = record ? [] : await gov.recentDecisions(principal, 4);
  const pack = await gov.policyPack(principal, { caseKind: "risk_review" });
  const labels = pack?.kind === "initiative" ? { ...pack.domains } : {};

  return (
    <>
      <div className="page-head">
        <div>
          <span className="eyebrow">Audit log · append-only · hash-chained per tenant</span>
          <h1 className="display-l">
            Who decided, <em>and why</em>
          </h1>
        </div>
      </div>

      <form className="search-bar" action="/audit" role="search">
        <label htmlFor="audit-q">Search the audit log</label>
        <input id="audit-q" name="q" type="search" defaultValue={q} placeholder="A system name, or a case number such as CASE-0001" />
        <button className="btn btn-primary" type="submit">
          <Icon name="search" size={16} />
          Search
        </button>
      </form>

      {q && !record ? (
        matches.length === 0 ? (
          <p className="empty">Nothing on the record matches “{q}”. Try a case number such as CASE-0001, or part of a system&apos;s name.</p>
        ) : (
          <section className="panel panel-flush" aria-label="Matching cases">
            <ol className="log">
              {matches.map((m) => (
                <li key={m.caseId}>
                  <span className="kind-mark" aria-hidden="true" />
                  <span className="mono-s">{m.label}</span>
                  <Link href={`/audit?case=${m.caseId}`}>{m.assetName}</Link>
                  <span className="muted" style={{ fontSize: 13 }}>
                    {CASE_STATE[m.state]?.label ?? m.state}
                  </span>
                </li>
              ))}
            </ol>
          </section>
        )
      ) : null}

      {record ? <Answer r={record} canExport={can(principal, "audit.export")} chain={chain} /> : null}
      {caseId && !record ? <p className="empty">That case is not on the record, or you cannot see it.</p> : null}

      {!record ? (
        <>
          {related.length > 0 ? (
            <nav className="stack" style={{ gap: 8 }} aria-label="Related searches">
              <span className="eyebrow">Recent decisions</span>
              <div className="pills">
                {related.map((r) => (
                  <Link key={r.case.id} className="pill" href={`/audit?case=${r.case.id}`}>
                    Who decided {r.label}?
                  </Link>
                ))}
              </div>
            </nav>
          ) : null}
          <Log events={events} who={who} labels={labels} />
          <ChainLine chain={chain} />
        </>
      ) : null}

      <p className="hint" style={{ maxWidth: "80ch" }}>
        The log stores only IDs, states and hashes. Names and written reasons are looked up when you view it, so an erasure request removes a
        person&apos;s words without breaking the chain. <Tag>Append-only</Tag>
      </p>
    </>
  );
}
