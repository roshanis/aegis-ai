import type { AgentView, EvalView } from "@aegis/core";
import type { Metadata } from "next";
import { AgentControls, ModelForm } from "@/components/Agents";
import { AutoRefresh } from "@/components/AutoRefresh";
import { ActorMark, Tag } from "@/components/ds";
import { governance } from "@/lib/db";
import { AGENT_STATUS, FAILURE, ago, evalFinding } from "@/lib/labels";
import { requireViewer } from "@/lib/viewer";

export const metadata: Metadata = { title: "Agents" };

const PURPOSE: Record<string, string> = {
  intake: "Suggested intake answers",
  draft: "Drafted a domain review",
  eval: "Ran a golden case",
};

const pct = (n: number | null) => (n === null ? "–" : `${Math.round(n * 100)}%`);

function EvalReport({ report, fields }: { report: EvalView; fields: Record<string, string> }) {
  const running = report.state === "running";
  return (
    <div className="stack raised" style={{ gap: 10 }}>
      <div className="spread">
        <strong>
          {running
            ? `Running golden set: ${report.done} of ${report.total}`
            : report.state === "passed"
              ? `Passed its golden set: ${pct(report.score)}`
              : report.state === "failed"
                ? `Failed its golden set: ${pct(report.score)}`
                : `Stopped: ${FAILURE[report.errorCode ?? ""] ?? "did not finish"}`}
        </strong>
        <span className="mono-s muted">
          {report.goldenSet} · needs {pct(report.threshold)}, no critical failures
        </span>
      </div>
      <div className="progress" data-tone="agent" aria-hidden="true">
        <span style={{ width: `${(report.done / report.total) * 100}%` }} data-state={report.state} />
      </div>
      <p className="caption muted">
        Run by {report.startedBy.name ?? "someone removed"} · {ago(report.startedAt)}
        {report.criticalFailures ? ` · ${report.criticalFailures} critical failure${report.criticalFailures === 1 ? "" : "s"}` : ""}
        {!report.current ? " · on a different model, agent version or golden set, so it no longer counts" : ""}
      </p>
      {report.cases.length > 0 ? (
        <details>
          <summary style={{ cursor: "pointer", minHeight: 32 }}>See {report.cases.length === report.total ? "all" : report.cases.length} cases</summary>
          <table className="data cases-table">
            <tbody>
              {report.cases.map((c) => (
                <tr key={c.caseId}>
                  <td aria-label={c.passed ? "passed" : "failed"} className={c.passed ? "status-ok" : "status-bad"}>
                    {c.passed ? "✓" : "✗"}
                  </td>
                  <td>
                    {c.title}
                    {[...c.critical, ...c.misses].length > 0 ? (
                      <span className="caption muted" style={{ display: "block" }}>
                        {c.critical
                          .map((f) => `Critical: ${evalFinding(f, fields)}`)
                          .concat(c.misses.map((f) => evalFinding(f, fields)))
                          .join("; ")}
                      </span>
                    ) : null}
                  </td>
                  <td className="num">{pct(c.score)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      ) : null}
    </div>
  );
}

function AgentCard({ agent, fields }: { agent: AgentView; fields: Record<string, string> }) {
  const status = AGENT_STATUS[agent.status]!;
  return (
    <section className="panel agent-card" aria-label={agent.title}>
      <header>
        <ActorMark kind="agent" size={34} />
        <div className="stack" style={{ gap: 2, flex: 1 }}>
          <h2 className="title">{agent.title}</h2>
          <span className="mono-s muted">
            {agent.id}@{agent.version} · draft only · cannot approve
          </span>
        </div>
        <Tag tone={status.tone}>{status.label}</Tag>
      </header>
      <p>{agent.purpose}</p>
      <p className="hint">{agent.statusReason}</p>
      <details className="caption muted">
        <summary style={{ cursor: "pointer", minHeight: 28 }}>What it sends your model</summary>
        {agent.sends}
      </details>
      {agent.latestEval ? <EvalReport report={agent.latestEval} fields={fields} /> : null}
      <AgentControls agent={agent.id} title={agent.title} actions={agent.actions} />
    </section>
  );
}

export default async function AgentsPage() {
  const { principal } = await requireViewer();
  const gov = await governance();
  const overview = await gov.agentsOverview(principal);
  const pack = await gov.policyPack(principal, { caseKind: "risk_review" });
  const fields = pack?.kind === "initiative" ? Object.fromEntries(pack.questions.map((q) => [q.field, q.label])) : {};
  const { connection } = overview;
  const evaluating = overview.agents.some((a) => a.status === "evaluating");

  return (
    <>
      {evaluating ? <AutoRefresh /> : null}
      <div className="page-head">
        <div>
          <span className="eyebrow">Agents · draft only, behind a golden-set gate</span>
          <h1 className="display-l">
            Agents draft, <em>people decide</em>
          </h1>
        </div>
      </div>

      <section className="panel panel-xl stack" style={{ gap: 12 }} aria-label="Model">
        <div className="spread">
          <div className="stack" style={{ gap: 4 }}>
            <span className="eyebrow">Model</span>
            <h2 className="display-m">{connection ? connection.label : "No model connected"}</h2>
          </div>
          {connection?.provider === "scripted" ? <Tag>No AI · nothing leaves Aegis</Tag> : null}
        </div>
        {connection ? (
          <p className="caption muted">
            Set by {connection.updatedBy.name ?? "someone removed"} {ago(connection.updatedAt)}
            {connection.keyHint ? ` · key ending ${connection.keyHint}` : ""}
            {connection.endpoint ? ` · ${connection.endpoint}` : ""} · fingerprint <span className="mono-s">{connection.fingerprint}</span>
          </p>
        ) : (
          <p className="muted">Connect your organization&apos;s model.</p>
        )}
        {overview.canManage ? (
          <ModelForm
            current={
              connection
                ? { provider: connection.provider, model: connection.model, endpoint: connection.endpoint, apiVersion: connection.apiVersion, keyHint: connection.keyHint }
                : null
            }
            providers={overview.providers}
          />
        ) : null}
      </section>

      <div className="agent-grid">
        {overview.agents.map((agent) => (
          <AgentCard key={agent.id} agent={agent} fields={fields} />
        ))}
      </div>

      <section className="panel panel-flush" aria-label="Recent runs">
        <div className="spread" style={{ padding: "18px 22px 6px" }}>
          <h2 className="section-title">Recent runs</h2>
        </div>
        {overview.recentRuns.length === 0 ? (
          <p className="hint" style={{ padding: "0 22px 18px" }}>
            No runs yet.
          </p>
        ) : (
          <table className="data responsive">
            <thead>
              <tr>
                <th scope="col">When</th>
                <th scope="col">Agent</th>
                <th scope="col">What</th>
                <th scope="col">Result</th>
                <th scope="col" className="num">
                  Tokens
                </th>
              </tr>
            </thead>
            <tbody>
              {overview.recentRuns.map((run) => (
                <tr key={run.id}>
                  <td>{ago(run.startedAt)}</td>
                  <td data-label="Agent">{run.agentId === "intake" ? "Intake assistant" : "Review drafter"}</td>
                  <td data-label="What">{PURPOSE[run.purpose]}</td>
                  <td data-label="Result">
                    {run.state === "succeeded" ? (
                      <Tag tone="ok">Done</Tag>
                    ) : run.state === "running" ? (
                      <Tag tone="agent">Running</Tag>
                    ) : run.state === "stale" ? (
                      <span className="muted">Not used: a person acted first</span>
                    ) : (
                      <span className="muted">Failed: {FAILURE[run.errorCode ?? ""] ?? run.errorCode}</span>
                    )}
                  </td>
                  <td data-label="Tokens" className="num">
                    {run.inputTokens ? `${run.inputTokens} in / ${run.outputTokens} out` : "–"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}
