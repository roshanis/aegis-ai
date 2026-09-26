import type { AssetView, CaseRecord } from "@aegis/core";
import { can, caseLabel } from "@aegis/domain";
import type { Metadata } from "next";
import Link from "next/link";
import { TIER_NAME } from "@/components/ds";
import { governance } from "@/lib/db";
import {
  AGENT_NAME,
  actorName,
  age,
  becauseText,
  clock,
  formatLongDate,
  hash4,
  nextStep,
  shortName,
  wireAction,
} from "@/lib/labels";
import { requireViewer } from "@/lib/viewer";

export const metadata: Metadata = { title: "Today" };

const WORDS = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
const count = (n: number, noun: string) => `${WORDS[n] ?? n} ${noun}${n === 1 ? "" : "s"}`;
const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

function daysAgo(at: Date, now: Date): string {
  const days = Math.floor((Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate())) / 86_400_000);
  return days <= 0 ? "today" : days === 1 ? "yesterday" : `${days} days ago`;
}

function headline(r: CaseRecord): string {
  const n = r.conditions.length;
  switch (r.case.state) {
    case "fast_lane_approved":
      return `${r.asset.name} cleared in the fast lane`;
    case "conditionally_approved":
      return `${r.asset.name} approved, on ${count(n, "condition")}`;
    case "approved":
      return `${r.asset.name} approved`;
    case "rejected":
      return `${r.asset.name} rejected`;
    default:
      return r.asset.name;
  }
}

function signedCount(r: CaseRecord) {
  return r.signoffs.filter((s) => s.status === "signed").length;
}

function dek(r: CaseRecord): string {
  if (r.fastLane) return `No review team had to sign: low risk under ${r.fastLane.policyId}. Accountable: ${r.fastLane.accountableApprover}.`;
  const who = r.decision ? actorName(r.decision.actor) : "The approver";
  const total = r.signoffs.length;
  const signed = signedCount(r);
  const teams = signed === total ? `all ${count(total, "review team")} signed` : `${WORDS[signed] ?? signed} of ${count(total, "review team")} signed`;
  const beforeUse = r.conditions.find((c) => c.due === "before_use" && c.text);
  return `${who} decided after ${teams}.${beforeUse ? ` Before it is used: ${beforeUse.text!.replace(/\.$/, "")}.` : ""}`;
}

function Story({ r }: { r: CaseRecord }) {
  const drafted = new Set(r.events.filter((e) => e.action === "review.draft").map((e) => e.payload.domain)).size;
  const kept = r.signoffs.filter((s) => s.fromDraft === "as_drafted").length;
  const edited = r.signoffs.filter((s) => s.fromDraft === "edited").length;
  const tier = r.case.tier;
  const paragraphs = [
    tier
      ? `Triage placed it in the ${tier} tier because it ${becauseText(r.pack, r.tierRule?.id ?? null)}. ${
          r.signoffs.length > 0 ? `${capital(count(r.signoffs.length, "review team"))} took a seat: ${r.signoffs.map((s) => s.label).join(", ")}.` : "No review team needed a seat."
        }`
      : `${r.asset.name} was decided under ${r.case.packId}@${r.case.packVersion}.`,
    r.decision?.reason ? `The decision reads: “${r.decision.reason}”` : null,
    r.conditions.length > 0
      ? `It carries ${count(r.conditions.length, "condition")}: ${r.conditions
          .map((c) => `${c.text ?? "text erased"} (${c.due === "before_use" ? "before use" : "ongoing"})`)
          .join("; ")}.`
      : null,
    drafted > 0
      ? `The review drafter drafted ${count(drafted, "review")}.${
          kept + edited > 0
            ? ` Reviewers signed ${WORDS[kept + edited] ?? kept + edited} from its memos${edited > 0 ? `, editing ${WORDS[edited] ?? edited}` : ", unchanged"}.`
            : " No reviewer signed from its memos."
        } No agent took part in the decision; its drafts are on the record as drafts.`
      : "No agent took part in the decision.",
  ].filter((p): p is string => p !== null);
  return (
    <div className="columns">
      {paragraphs.map((p, i) => (
        <p key={i} className={i === 0 ? "drop-cap" : undefined}>
          {p}
        </p>
      ))}
    </div>
  );
}

function attention(views: readonly AssetView[]): { text: string; href: string } | null {
  for (const v of views) {
    if (v.asset.state === "paused") {
      return {
        text: `${v.asset.name} is paused.${v.openCase ? ` ${caseLabel(v.openCase.number)}, its ${v.openCase.trigger} review, waits on ${v.openCase.state === "draft" ? "its owner" : "its reviewers"}.` : ""}`,
        href: `/registry/${v.asset.id}`,
      };
    }
  }
  for (const v of views) {
    const waiting = v.assurance.controls.find((c) => c.exception?.state === "requested");
    if (waiting) return { text: `${v.asset.name} waits on an approver to decide an exception for ${waiting.id}.`, href: `/registry/${v.asset.id}?tab=controls` };
    const expired = v.assurance.controls.find((c) => c.exception?.state === "expired" && !c.covered);
    if (expired) return { text: `The exception for ${expired.id} on ${v.asset.name} has expired.`, href: `/registry/${v.asset.id}?tab=controls` };
  }
  for (const v of views) {
    if (v.asset.state === "registered" && !v.clearance.cleared && v.clearance.caseId && v.cases.some((c) => c.state.includes("approved"))) {
      return { text: `${v.asset.name} is approved but not cleared: ${v.clearance.reason}.`, href: `/registry/${v.asset.id}` };
    }
  }
  return null;
}

export default async function TodayPage() {
  const { principal, tenant } = await requireViewer();
  const gov = await governance();
  const [views, decisions, log, agents, packs] = await Promise.all([
    gov.listAssetViews(principal),
    gov.recentDecisions(principal, 4),
    gov.auditLog(principal, { limit: 5 }),
    gov.agentsOverview(principal),
    gov.policyPacks(principal),
  ]);
  const now = new Date();
  const dayOfYear = Math.floor((now.getTime() - Date.UTC(now.getUTCFullYear(), 0, 0)) / 86_400_000);
  const waiting = views.flatMap((v) => {
    const step = nextStep(v);
    return step ? [{ v, step }] : [];
  });
  const lead = decisions[0] ?? null;
  const more = decisions.slice(1);
  const late = attention(views);
  const drafts = views.flatMap((v) => v.assurance.reviews).filter((r) => r.status === "drafted").length;
  const week = now.getTime() - 7 * 86_400_000;
  const suggestions = agents.recentRuns.filter((r) => r.purpose === "intake" && r.state === "succeeded" && r.startedAt.getTime() > week).length;
  const passing = agents.agents.filter((a) => a.latestEval?.state === "passed" && a.latestEval.current);
  const inForce = packs.filter((p) => p.enabled);

  return (
    <article className="docket" aria-labelledby="docket-title">
      <header className="masthead">
        <div className="left">
          Vol. 1 · No. {dayOfYear}
          <br />
          {tenant.name} edition
        </div>
        <h1 id="docket-title">The Aegis Docket</h1>
        <div className="right">
          {formatLongDate(now)}
          <br />
          Edition at {clock(now)} UTC
        </div>
      </header>
      <div className="masthead-rule" aria-hidden="true" />
      <nav className="sections" aria-label="Sections">
        <Link href="/today" aria-current="page">
          Front page
        </Link>
        <Link href="/reviews">Your reviews · {waiting.length}</Link>
        {can(principal, "asset.register") ? <Link href="/registry/new">File a new system</Link> : null}
        <Link href="/registry">Registry</Link>
        <Link href="/audit">Audit log</Link>
        <Link href="/packs">Policy</Link>
      </nav>

      <div className="docket-grid">
        <section className="lead" aria-labelledby="lead-h">
          {lead ? (
            <>
              <div className="kicker" data-tier={lead.case.tier ?? undefined}>
                Decided {daysAgo(lead.case.decidedAt!, now)}
                {lead.case.tier ? ` · ${TIER_NAME[lead.case.tier]} risk` : ""}
              </div>
              <h2 id="lead-h" className="headline">
                <Link href={`/registry/${lead.asset.id}`}>{headline(lead)}</Link>
              </h2>
              <p className="dek">{dek(lead)}</p>
              <div className="dateline">
                {lead.case.packId}@{lead.case.packVersion} · rule {lead.tierRule?.id ?? "none matched"} · {signedCount(lead)}/{lead.signoffs.length} sign-offs ·{" "}
                {lead.label} · audit log #{hash4(lead.decision?.hash)}
              </div>
              <Story r={lead} />
            </>
          ) : (
            <>
              <div className="kicker">Nothing decided yet</div>
              <h2 id="lead-h" className="headline">
                No decisions on the record
              </h2>
              <p className="dek">When an approver decides a review, or the fast lane clears one, it leads this page.</p>
            </>
          )}
          {more.length > 0 ? (
            <div className="more-decisions" aria-label="More decisions">
              {more.map((r) => (
                <Link key={r.case.id} href={`/registry/${r.asset.id}`}>
                  <span className="kicker" data-tier={r.case.tier ?? undefined}>
                    {daysAgo(r.case.decidedAt!, now)}
                    {r.case.tier ? ` · ${TIER_NAME[r.case.tier]}` : ""}
                  </span>
                  <span className="serif">{headline(r)}</span>
                  <span className="mono-s muted">
                    {r.label} · #{hash4(r.decision?.hash)}
                  </span>
                </Link>
              ))}
            </div>
          ) : null}
        </section>

        <div className="sidebar">
          <section className="box-rule" aria-labelledby="waiting-h">
            <h2 id="waiting-h" className="box-title">
              Waiting for you
            </h2>
            {waiting.length === 0 ? (
              <p className="hint" style={{ padding: "10px 0" }}>
                Nothing is waiting for you.
              </p>
            ) : (
              waiting.slice(0, 5).map(({ v, step }) => {
                const review = v.openCase ?? v.cases.at(-1);
                const tier = v.cases.filter((c) => c.tier !== null).at(-1)?.tier ?? null;
                return (
                  <Link key={v.asset.id} className="story-link" href={`/registry/${v.asset.id}`}>
                    <span className="serif">
                      {v.asset.name}: {step.label.charAt(0).toLowerCase() + step.label.slice(1)}
                    </span>
                    <span className="mono-s" data-tier={tier ?? undefined} style={{ color: tier ? "var(--tier)" : undefined }}>
                      {tier ? TIER_NAME[tier].toUpperCase() : "—"} · {age(review?.createdAt ?? v.asset.createdAt, now)}
                    </span>
                  </Link>
                );
              })
            )}
            {waiting.length > 5 ? (
              <Link href="/reviews" className="hint" style={{ paddingTop: 8 }}>
                {waiting.length - 5} more in Reviews
              </Link>
            ) : null}
          </section>

          {late ? (
            <section className="inverse" aria-labelledby="late-h">
              <h2 id="late-h" className="box-title">
                Needs attention
              </h2>
              <p>
                <Link href={late.href}>{late.text}</Link>
              </p>
            </section>
          ) : null}

          <section className="agent-box" aria-labelledby="agents-h">
            <h2 id="agents-h">AGENT DRAFTS · NOT DECISIONS</h2>
            <ul>
              <li>
                review drafter: {count(drafts, "draft")} waiting for a reviewer
              </li>
              <li>
                intake assistant: suggested answers for {count(suggestions, "intake")} this week
              </li>
              <li>
                eval gate:{" "}
                {agents.agents
                  .map((a) => `${AGENT_NAME[a.id] ?? a.id} ${a.status === "on" ? "on" : "off"}${passing.includes(a) ? `, passing ${a.latestEval!.goldenSet}` : ", not passing on this model"}`)
                  .join("; ")}
              </li>
            </ul>
          </section>
        </div>

        <footer className="docket-foot">
          <section aria-labelledby="policy-h">
            <h2 id="policy-h" className="box-title">
              Policy in force
            </h2>
            {inForce.length === 0 ? (
              <p className="hint">No policy pack is enabled.</p>
            ) : (
              inForce.map((p) => (
                <p key={p.packId} className="serif" style={{ fontSize: 17, lineHeight: "25px" }}>
                  <em>
                    {p.packId}@{p.version}
                  </em>
                  : {p.pack.summary} <Link href="/packs">Read the pack</Link>.
                </p>
              ))
            )}
          </section>
          <section aria-labelledby="wire-h">
            <h2 id="wire-h" className="box-title">
              Audit log · latest · {log.chain.intact ? "hash chain verified" : `hash chain broken at event ${log.chain.brokenAt}`}
            </h2>
            <ol className="wire">
              {log.events.map((e) => (
                <li key={e.id}>
                  {clock(e.at)} · {e.actor.kind === "human" ? shortName(actorName(e.actor)) : actorName(e.actor)} · {wireAction(e)} ·{" "}
                  <Link href={e.caseId ? `/audit?case=${e.caseId}` : "/audit"}>#{hash4(e.hash)}</Link>
                </li>
              ))}
            </ol>
          </section>
        </footer>
      </div>
    </article>
  );
}
