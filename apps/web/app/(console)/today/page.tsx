import type { AssetView, CaseRecord } from "@aegis/core";
import { can, caseLabel, type Tier } from "@aegis/domain";
import type { Metadata } from "next";
import Link from "next/link";
import { ActorMark, Icon, TIER_NAME, Tag, TierText } from "@/components/ds";
import { governance } from "@/lib/db";
import { AGENT_STATUS, CASE_STATE, TRIGGER, age, formatDate, hash4, nextStep, stageOf, type Tone } from "@/lib/labels";
import { requireViewer } from "@/lib/viewer";

export const metadata: Metadata = { title: "Today" };

const STAGES = [
  { at: 0, label: "Intake", show: "review" },
  { at: 1, label: "Review", show: "review" },
  { at: 2, label: "Decided", show: "idle" },
  { at: 3, label: "In use", show: "live" },
  { at: 4, label: "Re-review", show: "review" },
] as const;
const TIERS: readonly Tier[] = ["low", "medium", "high", "critical"];

const VERDICT: Record<string, { label: string; tone: Tone }> = {
  approved: { label: "Approved", tone: "ok" },
  conditionally_approved: { label: "With conditions", tone: "ok" },
  fast_lane_approved: { label: "Fast lane", tone: "ok" },
  rejected: { label: "Rejected", tone: "bad" },
};

const latestTier = (v: AssetView) => v.cases.filter((c) => c.tier !== null).at(-1)?.tier ?? null;

function Stat({ value, label, href, accent = false }: { value: number; label: string; href: string; accent?: boolean }) {
  return (
    <Link className="stat" href={href} data-accent={accent}>
      <span className="stat-value">{value}</span>
      <span className="stat-label">{label}</span>
    </Link>
  );
}

/** One quiet hue for every bar; the row label says what it is, the count sits at the tip. */
function Bars({ rows }: { rows: readonly { key: string; label: React.ReactNode; count: number; href?: string; title: string }[] }) {
  const max = Math.max(1, ...rows.map((r) => r.count));
  return (
    <ul className="bars">
      {rows.map((r) => {
        const inner = (
          <>
            <span className="bar-label">{r.label}</span>
            <span className="bar-plot">
              <span className="bar" data-zero={r.count === 0} style={{ width: `${(r.count / max) * 100}%` }} />
              <span className="bar-count">{r.count}</span>
            </span>
          </>
        );
        return (
          <li key={r.key}>
            {r.href ? (
              <Link className="bar-row" href={r.href} title={r.title} aria-label={r.title}>
                {inner}
              </Link>
            ) : (
              <div className="bar-row" title={r.title} aria-label={r.title}>
                {inner}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function Decision({ r }: { r: CaseRecord }) {
  const d = r.decision;
  const verdict = VERDICT[r.case.state] ?? { label: r.case.state, tone: "neutral" as Tone };
  return (
    <li>
      <Link href={`/audit?case=${r.case.id}`}>
        <ActorMark kind={d?.actor.kind ?? "system"} name={d?.actor.name} size={32} />
        <span className="row-main">
          <strong>{r.asset.name}</strong>
          <span className="mono-s">
            {r.label} · {formatDate(r.case.decidedAt!)} · #{hash4(d?.hash)}
          </span>
        </span>
        <span className="row-end">
          <Tag tone={verdict.tone}>{verdict.label}</Tag>
        </span>
      </Link>
    </li>
  );
}

export default async function TodayPage() {
  const { principal, tenant } = await requireViewer();
  const gov = await governance();
  const [views, decisions, log, agents] = await Promise.all([
    gov.listAssetViews(principal),
    gov.recentDecisions(principal, 4),
    gov.auditLog(principal, { limit: 1 }),
    gov.agentsOverview(principal),
  ]);
  const now = new Date();
  const waiting = views.flatMap((v) => {
    const step = nextStep(v);
    return step ? [{ v, step }] : [];
  });
  const live = views.filter((v) => v.asset.state !== "retired");
  const paused = views.filter((v) => v.asset.state === "paused");
  const stageCount = (at: number) => live.filter((v) => stageOf(v).at === at).length;
  const tierCount = (t: Tier) => live.filter((v) => latestTier(v) === t).length;

  return (
    <>
      <div className="page-head">
        <div>
          <span className="eyebrow">{tenant.name}</span>
          <h1 className="display-l">Today</h1>
        </div>
        {can(principal, "asset.register") ? (
          <Link className="btn btn-primary" href="/registry/new">
            <Icon name="intake" size={16} />
            Register a system
          </Link>
        ) : null}
      </div>

      <section className="kpis" aria-label="At a glance">
        <Stat value={waiting.length} label="Waiting for you" href="/reviews" accent={waiting.length > 0} />
        <Stat value={views.filter((v) => v.asset.state === "active").length} label="In use" href="/registry?show=live" />
        <Stat value={views.filter((v) => v.openCase).length} label="In review" href="/registry?show=review" />
        <Stat value={live.filter((v) => !v.clearance.cleared).length} label="Not cleared" href="/registry" />
      </section>

      {paused.map((v) => (
        <Link key={v.asset.id} className="alert-row" href={`/registry/${v.asset.id}`}>
          <Tag tone="warn">Paused</Tag>
          <strong>{v.asset.name}</strong>
          <span className="muted">{v.openCase ? `${caseLabel(v.openCase.number)} · ${TRIGGER[v.openCase.trigger]} · ${CASE_STATE[v.openCase.state]?.label.toLowerCase() ?? v.openCase.state}` : ""}</span>
        </Link>
      ))}

      <div className="home-grid">
        <div className="stack" style={{ gap: 16 }}>
          <section className="card" aria-labelledby="waiting-h">
            <div className="card-head">
              <h2 id="waiting-h" className="section-title">
                Waiting for you
              </h2>
              {waiting.length > 0 ? <Link href="/reviews">All</Link> : null}
            </div>
            {waiting.length === 0 ? (
              <p className="muted">Nothing right now.</p>
            ) : (
              <ul className="rows">
                {waiting.slice(0, 6).map(({ v, step }) => {
                  const tier = latestTier(v);
                  return (
                    <li key={v.asset.id}>
                      <Link href={`/registry/${v.asset.id}`}>
                        <span className="kind-mark" data-kind={v.asset.kind === "agent" ? "agent" : "system"} aria-hidden="true" />
                        <span className="row-main">
                          <strong>{v.asset.name}</strong>
                          <span>{step.label}</span>
                        </span>
                        <span className="row-end">
                          <TierText tier={tier} />
                          <span className="mono-s muted">{age((v.openCase ?? v.cases.at(-1))?.createdAt ?? v.asset.createdAt, now)}</span>
                        </span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          <section className="card" aria-labelledby="decisions-h">
            <div className="card-head">
              <h2 id="decisions-h" className="section-title">
                Latest decisions
              </h2>
              <Link href="/audit">Audit log</Link>
            </div>
            {decisions.length === 0 ? (
              <p className="muted">None yet.</p>
            ) : (
              <ul className="rows">
                {decisions.map((r) => (
                  <Decision key={r.case.id} r={r} />
                ))}
              </ul>
            )}
          </section>
        </div>

        <div className="stack" style={{ gap: 16 }}>
          <section className="card" aria-labelledby="stages-h">
            <h2 id="stages-h" className="section-title">
              Systems by stage
            </h2>
            <Bars
              rows={STAGES.map((s) => ({
                key: s.label,
                label: s.label,
                count: stageCount(s.at),
                href: `/registry?show=${s.show}`,
                title: `${stageCount(s.at)} at ${s.label.toLowerCase()}`,
              }))}
            />
          </section>

          <section className="card" aria-labelledby="tiers-h">
            <h2 id="tiers-h" className="section-title">
              Risk tiers
            </h2>
            <Bars
              rows={TIERS.map((t) => ({
                key: t,
                label: <TierText tier={t} />,
                count: tierCount(t),
                title: `${tierCount(t)} ${TIER_NAME[t].toLowerCase()} risk`,
              }))}
            />
          </section>

          <section className="card" aria-labelledby="agents-h">
            <div className="card-head">
              <h2 id="agents-h" className="section-title">
                Agents
              </h2>
              <Link href="/agents">Manage</Link>
            </div>
            {agents.agents.map((a) => {
              const status = AGENT_STATUS[a.status]!;
              const score = a.latestEval?.current && a.latestEval.score !== null ? a.latestEval.score : null;
              return (
                <div className="agent-row" key={a.id}>
                  <ActorMark kind="agent" size={24} />
                  <span>{a.title}</span>
                  <Tag tone={status.tone}>{status.label}</Tag>
                  {score !== null ? (
                    <div className="agent-score" title={`Golden set ${a.latestEval!.goldenSet}`}>
                      <div className="progress" data-tone="agent" aria-hidden="true">
                        <span style={{ width: `${score * 100}%` }} data-state={a.latestEval?.state} />
                      </div>
                      <span className="mono-s">{Math.round(score * 100)}%</span>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </section>

          <Link className="card" href="/audit" style={{ color: "var(--ink)", textDecoration: "none" }} aria-label="Audit log">
            <span className="chain-ok" data-ok={log.chain.intact}>
              <span className="mark-check" aria-hidden="true">
                {log.chain.intact ? <Icon name="check" size={16} /> : "!"}
              </span>
              {log.chain.intact ? "Audit log verified" : `Audit log broken at event ${log.chain.brokenAt}`}
            </span>
            <span className="mono-s muted">
              {log.chain.events} events · latest #{hash4(log.chain.latest)}
            </span>
          </Link>
        </div>
      </div>
    </>
  );
}
