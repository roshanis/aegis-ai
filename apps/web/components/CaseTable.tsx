import type { AssetView, DomainReviewView, HistoryEntry } from "@aegis/core";
import { caseLabel, type ReviewDraft } from "@aegis/domain";
import type { InitiativePack } from "@aegis/frameworks";
import Link from "next/link";
import { ActorMark, AgentDraftFrame, Icon, TIER_NAME } from "./ds";
import { DecisionForm, Pending, RequestDraft, RespondForm, ReviewButton, SeatForm } from "./Forms";
import { ASSET_KIND, CASE_STATE, FAILURE, actorName, describe, formatDate, hash4, initials, plural, whySeat } from "@/lib/labels";

/**
 * The Table: every review domain the triage called for sits at a seat
 * around the system. People sign; the drafting agent sits outside the
 * table with no seat, and the decision waits at the head until every seat
 * has signed. Selecting a seat opens it beside the table.
 */

type SeatState = "signed" | "you" | "returned" | "abstained" | "open";

interface Seat {
  readonly review: DomainReviewView;
  readonly state: SeatState;
  readonly disc: string;
  readonly status: string;
  readonly drafted: boolean;
}

function seatOf(r: DomainReviewView, decided: boolean): Seat {
  const drafted = (r.status === "drafted" || r.status === "pending") && r.draft.content !== null && r.draft.status === "ready";
  if (r.status === "signed") {
    return { review: r, state: "signed", disc: initials(r.reviewer?.name ?? "?"), status: `Signed by ${r.reviewer?.name ?? "a removed person"}`, drafted: false };
  }
  if (r.status === "abstained") return { review: r, state: "abstained", disc: "—", status: `${r.reviewer?.name ?? "The reviewer"} abstained`, drafted: false };
  if (r.status === "returned") {
    const status = decided ? "Question still open at the decision" : r.actions.includes("respond") ? "A question for you" : "Waiting for the owner's answer";
    return { review: r, state: "returned", disc: "?", status, drafted: false };
  }
  if (decided) return { review: r, state: "open", disc: "", status: "Not signed before the decision", drafted: false };
  if (r.actions.includes("sign")) return { review: r, state: "you", disc: "You", status: drafted ? "Your seat · draft ready" : "Your seat", drafted };
  return { review: r, state: "open", disc: "", status: drafted ? "Open · draft ready" : r.draft.status === "queued" ? "Open · drafting" : "Open", drafted };
}

/* The board is a square; positions are percentages of its width. */
const CX = 50;
const CY = 53;
const R = 35;
const place = (i: number, n: number) => {
  const a = ((-90 + ((i + 0.5) * 360) / n) * Math.PI) / 180;
  return { x: CX + R * Math.cos(a), y: CY + R * Math.sin(a) };
};
const AGENT = { x: 9, y: 91 };
const DECISION = { x: 50, y: 7 };

export function CaseTable({
  view,
  pack,
  history,
  selected,
  baseHref,
}: {
  view: AssetView;
  pack: InitiativePack | null;
  history: readonly HistoryEntry[];
  selected: string | null;
  baseHref: string;
}) {
  const { assurance } = view;
  const reviews = assurance.reviews;
  const tableCase = view.cases.find((c) => c.id === reviews[0]?.caseId) ?? null;
  if (!tableCase) return null;
  const seats = reviews.map((r) => seatOf(r, tableCase.decidedAt !== null));
  const signed = reviews.filter((r) => r.status === "signed" || r.status === "abstained").length;
  const decided = tableCase.decidedAt !== null;
  const decisionEvent = history.filter((e) => e.caseId === tableCase.id && e.decision).at(-1) ?? null;
  const canDecide = view.openCase?.id === tableCase.id && view.actions.openCase.some((a) => a === "approve" || a === "conditionally_approve" || a === "reject");
  const drafterPresent = assurance.drafterOn || reviews.some((r) => r.draft.content !== null);
  const queued = reviews.filter((r) => r.draft.status === "queued").length;

  const fallback =
    seats.find((s) => s.state === "you" || s.review.actions.includes("respond"))?.review.domain ??
    (canDecide && (assurance.readiness?.canApprove || assurance.readiness?.canConditionallyApprove) ? "decision" : null) ??
    seats.find((s) => s.state !== "signed")?.review.domain ??
    (decided ? "decision" : seats[0]?.review.domain ?? "decision");
  const current = selected === "decision" || seats.some((s) => s.review.domain === selected) ? selected! : fallback;
  const href = (key: string) => `${baseHref}?seat=${encodeURIComponent(key)}`;
  const tier = tableCase.tier ?? "low";

  const seatLink = (s: Seat, i: number, list = false) => {
    const pos = place(i, seats.length);
    return (
      <Link
        key={s.review.domain}
        className="seat"
        href={href(s.review.domain)}
        scroll={false}
        data-state={s.state}
        aria-current={current === s.review.domain ? "true" : undefined}
        aria-label={`${s.review.label}: ${s.status}`}
        style={list ? undefined : { left: `${pos.x}%`, top: `${pos.y}%` }}
      >
        <span className="seat-disc" aria-hidden="true">
          {s.disc}
        </span>
        {s.drafted ? <span className="drafted" aria-hidden="true" title="A draft is ready" /> : null}
        <span className={list ? "text" : "stack"} style={list ? undefined : { gap: 2, alignItems: "center" }}>
          <span className="seat-label">{s.review.label}</span>
          <span className="seat-status">{s.status}</span>
        </span>
      </Link>
    );
  };
  const decisionLink = (list = false) => (
    <Link
      className="seat seat-decision"
      href={href("decision")}
      scroll={false}
      data-state={decided ? "decided" : "waiting"}
      aria-current={current === "decision" ? "true" : undefined}
      aria-label={`Decision: ${decided ? (CASE_STATE[tableCase.state]?.label ?? tableCase.state) : "waiting for the approver"}`}
      style={list ? undefined : { left: `${DECISION.x}%`, top: `${DECISION.y}%` }}
    >
      <span className="seat-disc" aria-hidden="true">
        <Icon name={!decided ? "lock" : tableCase.state === "rejected" ? "cross" : "check"} size={26} />
      </span>
      <span className={list ? "text" : "stack"} style={list ? undefined : { gap: 2, alignItems: "center" }}>
        <span className="seat-label">Decision · approver</span>
        <span className="seat-status">{decided ? (CASE_STATE[tableCase.state]?.label ?? "Decided") : "Waiting"}</span>
      </span>
    </Link>
  );

  return (
    <section className="table-layout" aria-label="The review table">
      <div className="board-wrap">
        <div className="board-caption">
          <span className="eyebrow">
            The table · {caseLabel(tableCase.number)}
          </span>
          <span className="serif">
            {signed} of {plural(reviews.length, "review")} signed
          </span>
          <span className="hint">
            {decided
              ? `Decided ${formatDate(tableCase.decidedAt!)}: ${(CASE_STATE[tableCase.state]?.label ?? tableCase.state).toLowerCase()}.`
              : (assurance.readiness?.reason ?? `The approver can decide once all ${reviews.length} reviews are signed.`)}
          </span>
          {queued > 0 ? <Pending>The review drafter is drafting {plural(queued, "review")}. The page refreshes when it is done.</Pending> : null}
        </div>

        <div className="board">
          <svg className="lines" viewBox="0 0 100 100" aria-hidden="true" fill="none">
            <circle className="ring-line" cx={CX} cy={CY} r={R} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
            <circle className="ring-line" cx={CX} cy={CY} r={R + 12} strokeWidth={1} strokeDasharray="2 8" vectorEffect="non-scaling-stroke" />
            {seats.map((s, i) => {
              if (s.state !== "signed") return null;
              const p = place(i, seats.length);
              return <line key={s.review.domain} className="spoke" x1={CX} y1={CY} x2={p.x} y2={p.y} vectorEffect="non-scaling-stroke" />;
            })}
            <line className="decision-line" x1={CX} y1={DECISION.y + 8} x2={CX} y2={CY - 16} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
            {drafterPresent
              ? seats.map((s, i) => {
                  if (!s.drafted) return null;
                  const p = place(i, seats.length);
                  return <line key={`a-${s.review.domain}`} className="agent-line" x1={AGENT.x} y1={AGENT.y - 5} x2={p.x} y2={p.y} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />;
                })
              : null}
          </svg>

          <div className="system-disc" data-tier={tier}>
            <span className="kind">{ASSET_KIND[view.asset.kind]}</span>
            <span className="name">{view.asset.name}</span>
            <span className="tier">{TIER_NAME[tier]} risk</span>
          </div>

          {decisionLink()}
          {seats.map((s, i) => seatLink(s, i))}

          {drafterPresent ? (
            <div className="agent-seat" style={{ left: `${AGENT.x}%`, top: `${AGENT.y}%` }}>
              <span className="ring" aria-hidden="true" />
              <span className="seat-label">review drafter</span>
              <span className="seat-status">draft only · no seat</span>
            </div>
          ) : null}
        </div>

        <nav className="seat-list" aria-label="Seats">
          {decisionLink(true)}
          {seats.map((s, i) => seatLink(s, i, true))}
          {drafterPresent ? (
            <p className="hint" style={{ padding: "4px 10px" }}>
              review drafter · draft only · no seat
            </p>
          ) : null}
        </nav>
      </div>

      <SeatPanel
        view={view}
        pack={pack}
        history={history}
        seats={seats}
        current={current}
        decisionEvent={decisionEvent}
        canDecide={canDecide}
        controlsHref={`${baseHref}?tab=controls`}
      />
    </section>
  );
}

function DraftPreview({ draft, meta }: { draft: ReviewDraft; meta: string }) {
  return (
    <AgentDraftFrame agent="review drafter" meta={meta}>
      <p className="agent-draft-summary">{draft.summary}</p>
      {draft.findings.map((f, i) => (
        <div className="finding" key={i}>
          <span className="sev" data-sev={f.concern === "missing_evidence" || f.concern === "risk" ? "major" : f.concern === "weak_evidence" ? "minor" : "note"}>
            {f.concern === "missing_evidence" || f.concern === "risk" ? "MAJOR" : f.concern === "weak_evidence" ? "MINOR" : "NOTE"}
          </span>
          <span className="finding-text">
            {f.controlId ? <span className="mono">{f.controlId} </span> : null}
            {f.text}
          </span>
        </div>
      ))}
    </AgentDraftFrame>
  );
}

function SeatPanel({
  view,
  pack,
  history,
  seats,
  current,
  decisionEvent,
  canDecide,
  controlsHref,
}: {
  view: AssetView;
  pack: InitiativePack | null;
  history: readonly HistoryEntry[];
  seats: readonly Seat[];
  current: string;
  decisionEvent: HistoryEntry | null;
  canDecide: boolean;
  controlsHref: string;
}) {
  const { assurance } = view;
  const tableCase = view.cases.find((c) => c.id === seats[0]?.review.caseId)!;
  const foot = (
    <div className="foot">
      <span>
        {tableCase.packId}@{tableCase.packVersion} · rule {tableCase.triage?.tierRuleId ?? "none matched"}
      </span>
      <span>Select a seat for details</span>
    </div>
  );

  if (current === "decision") {
    const proposals = assurance.reviews.flatMap((r) => r.proposedConditions);
    return (
      <aside className="seat-panel" aria-labelledby="seat-h">
        <span className="eyebrow">Decision · approver</span>
        <h2 id="seat-h">The decision</h2>
        {decisionEvent ? (
          <>
            <div className="row">
              <ActorMark kind={decisionEvent.actor.kind} name={decisionEvent.actor.name} size={32} />
              <span>
                <strong>{actorName(decisionEvent.actor)}</strong> {describe(decisionEvent)}.
              </span>
            </div>
            {decisionEvent.reason ? <blockquote className="signed-quote">“{decisionEvent.reason}”</blockquote> : null}
            {decisionEvent.reasonStatus === "erased" ? <p className="hint">Reason erased on request; its fingerprint stays in the audit log.</p> : null}
            <span className="mono-s muted">
              decided {formatDate(decisionEvent.at)} · audit log #{hash4(decisionEvent.hash)}
            </span>
          </>
        ) : canDecide ? (
          <>
            <DecisionForm
              caseId={tableCase.id}
              actions={view.actions.openCase}
              readiness={assurance.readiness}
              proposals={proposals}
              labels={Object.fromEntries(assurance.reviews.map((r) => [r.domain, r.label]))}
            />
          </>
        ) : (
          <p>{assurance.readiness?.reason ?? "Waiting for the approver."}</p>
        )}
        {foot}
      </aside>
    );
  }

  const index = seats.findIndex((s) => s.review.domain === current);
  const seat = seats[index]!;
  const r = seat.review;
  const signEvent = history.filter((e) => e.action === "review.sign" && e.caseId === r.caseId && e.payload.domain === r.domain).at(-1);
  const drafterMeta = `${plural(r.draft.content?.findings.length ?? 0, "finding")} · eval gate passed`;
  const why = pack && tableCase.triage ? whySeat(pack, tableCase.triage.tier, tableCase.answers, r.domain) : null;

  return (
    <aside className="seat-panel" aria-labelledby="seat-h">
      <span className="eyebrow">
        Seat · {index + 1} of {seats.length}
      </span>
      <h2 id="seat-h">{r.label}</h2>
      <p className="muted">{seat.status}</p>

      {seat.state === "you" ? (
        <>
          {r.draft.status === "queued" ? <Pending>A fresh draft is on its way. You can review it yourself meanwhile.</Pending> : null}
          {r.draft.status === "failed" ? (
            <p className="hint">No draft: the review drafter {FAILURE[r.draft.error ?? ""] ?? "failed"}.</p>
          ) : null}
          <SeatForm
            key={`${r.domain}-${r.revision}-${r.draft.status}`}
            caseId={r.caseId}
            domain={r.domain}
            label={r.label}
            revision={r.revision}
            actions={r.actions}
            draft={r.status === "drafted" ? r.draft.content : null}
            drafterMeta={drafterMeta}
            uncoveredGates={r.uncoveredGates}
            controlsHref={controlsHref}
          />
          {r.canRequestDraft ? <RequestDraft caseId={r.caseId} domain={r.domain} again={r.draft.content !== null} /> : null}
        </>
      ) : null}

      {seat.state === "signed" ? (
        <>
          <div className="row">
            <ActorMark kind="human" name={r.reviewer?.name} size={32} />
            <strong>{r.reviewer?.name ?? "A removed person"}</strong>
          </div>
          {r.note ? <blockquote className="signed-quote">“{r.note}”</blockquote> : <p className="hint">Signed without a memo.</p>}
          {r.proposedConditions.length > 0 ? (
            <div className="stack" style={{ gap: 4 }}>
              <span className="label">Conditions they asked for</span>
              <ul style={{ listStyle: "disc", paddingLeft: 18 }}>
                {r.proposedConditions.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
            </div>
          ) : null}
          <span className="mono-s muted">
            signed {formatDate(r.updatedAt)}
            {signEvent ? ` · audit log #${hash4(signEvent.hash)}` : ""}
            {signEvent?.payload.fromDraft === "as_drafted" ? " · kept the drafter's memo" : signEvent?.payload.fromDraft === "edited" ? " · edited the drafter's memo" : ""}
          </span>
        </>
      ) : null}

      {seat.state === "returned" ? (
        <>
          {r.note ? <blockquote className="signed-quote">“{r.note}”</blockquote> : null}
          <span className="mono-s muted">asked by {r.reviewer?.name ?? "the reviewer"}</span>
          {r.actions.includes("respond") ? <RespondForm caseId={r.caseId} domain={r.domain} revision={r.revision} /> : null}
          {r.actions.includes("resume") ? <ReviewButton caseId={r.caseId} domain={r.domain} revision={r.revision} action="resume" label="Resume the review" /> : null}
        </>
      ) : null}

      {seat.state === "abstained" ? (
        <>
          {r.note ? <blockquote className="signed-quote">“{r.note}”</blockquote> : null}
          {r.actions.includes("resume") ? <ReviewButton caseId={r.caseId} domain={r.domain} revision={r.revision} action="resume" label="Resume the review" /> : null}
        </>
      ) : null}

      {seat.state === "open" ? (
        <>
          {why ? (
            <p className="row" style={{ gap: 8 }}>
              <span className="eyebrow">Why this seat</span>
              <span>{why}</span>
            </p>
          ) : null}
          {r.uncoveredGates.length > 0 ? (
            <p className="row" style={{ gap: 8 }}>
              <span className="eyebrow">Needs evidence</span>
              <Link href={controlsHref}>{r.uncoveredGates.join(", ")}</Link>
            </p>
          ) : null}
          {seat.drafted && r.draft.content ? (
            <>
              <DraftPreview draft={r.draft.content} meta={drafterMeta} />
            </>
          ) : null}
        </>
      ) : null}
      {foot}
    </aside>
  );
}
