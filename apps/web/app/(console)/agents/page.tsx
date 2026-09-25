import type { AgentView, EvalView } from "@aegis/core";
import type { Metadata } from "next";
import { AgentControls, ModelForm } from "@/components/Agents";
import { AutoRefresh } from "@/components/AutoRefresh";
import { Pill } from "@/components/Pill";
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
    <div className="stack eval-report" style={{ gap: 10 }}>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <strong>
          {running
            ? `Running golden set: ${report.done} of ${report.total}`
            : report.state === "passed"
              ? `Passed its golden set: ${pct(report.score)}`
              : report.state === "failed"
                ? `Failed its golden set: ${pct(report.score)}`
                : `Stopped: ${FAILURE[report.errorCode ?? ""] ?? "did not finish"}`}
        </strong>
        <span className="faint" style={{ fontSize: 12.5 }}>
          {report.goldenSet} · needs {pct(report.threshold)} and no critical failures
        </span>
      </div>
      <div className="meter" aria-hidden>
        <span style={{ width: `${(report.done / report.total) * 100}%` }} data-state={report.state} />
      </div>
      <p className="faint" style={{ fontSize: 12.5 }}>
        Run by {report.startedBy.name ?? "someone removed"} · {ago(report.startedAt)}
        {report.criticalFailures ? ` · ${report.criticalFailures} critical failure${report.criticalFailures === 1 ? "" : "s"}` : ""}
        {!report.current ? " · on a different model, agent version or golden set, so it no longer counts" : ""}
      </p>
      {report.cases.length > 0 ? (
        <details>
          <summary>See {report.cases.length === report.total ? "all" : report.cases.length} cases</summary>
          <table className="cases">
            <tbody>
              {report.cases.map((c) => (
                <tr key={c.caseId}>
                  <td aria-label={c.passed ? "passed" : "failed"}>{c.passed ? "✓" : "✗"}</td>
                  <td>
                    {c.title}
                    {[...c.critical, ...c.misses].length > 0 ? (
                      <span className="faint" style={{ display: "block", fontSize: 12.5 }}>
                        {c.critical.map((f) => evalFinding(f, fields)).map((f) => `Critical: ${f}`).concat(c.misses.map((f) => evalFinding(f, fields))).join("; ")}
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
    <section className="card stack agent-card" style={{ gap: 14 }} aria-label={agent.title}>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h2>{agent.title}</h2>
        <Pill tone={status.tone}>{status.label}</Pill>
      </div>
      <p>{agent.purpose}</p>
      <p className="muted" style={{ fontSize: 13.5 }}>
        {agent.statusReason}
      </p>
      <p className="faint" style={{ fontSize: 12.5 }}>
        Sends your model: {agent.sends} Version {agent.version}.
      </p>
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
          <h1>Agents</h1>
          <p className="muted">
            Agents draft and suggest; people decide. Each agent stays off until it passes its golden set on your model,
            and an admin turns it on. Change the model and it has to pass again.
          </p>
        </div>
      </div>

      <section className="card stack" style={{ gap: 12 }} aria-label="Model">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <div className="stack" style={{ gap: 4 }}>
            <span className="eyebrow">Model</span>
            <h2>{connection ? connection.label : "No model connected"}</h2>
          </div>
          {connection?.provider === "scripted" ? <Pill tone="neutral">No AI · nothing leaves Aegis</Pill> : null}
        </div>
        {connection ? (
          <p className="faint" style={{ fontSize: 13 }}>
            Set by {connection.updatedBy.name ?? "someone removed"} {ago(connection.updatedAt)}
            {connection.keyHint ? ` · key ending ${connection.keyHint}` : ""}
            {connection.endpoint ? ` · ${connection.endpoint}` : ""}
          </p>
        ) : (
          <p className="muted">Connect your organization&apos;s model. Agents never share a key across organizations.</p>
        )}
        {overview.sandbox ? (
          <p className="faint" style={{ fontSize: 13 }}>
            This sandbox runs the scripted demo model: deterministic rules, not AI. You can connect your own OpenAI key to
            try a real model; it is deleted with the sandbox.
          </p>
        ) : null}
        {overview.canManage ? (
          <ModelForm
            current={
              connection
                ? {
                    provider: connection.provider,
                    model: connection.model,
                    endpoint: connection.endpoint,
                    apiVersion: connection.apiVersion,
                    keyHint: connection.keyHint,
                  }
                : null
            }
            providers={overview.providers}
          />
        ) : null}
      </section>

      <div className="grid-2 agents-grid">
        {overview.agents.map((agent) => (
          <AgentCard key={agent.id} agent={agent} fields={fields} />
        ))}
      </div>

      <section className="card" aria-label="Recent runs">
        <div className="card-head">
          <h2>Recent runs</h2>
          <span className="faint" style={{ fontSize: 13 }}>
            Each call to your model. Only ids, outcomes and token counts are kept here.
          </span>
        </div>
        {overview.recentRuns.length === 0 ? (
          <p className="muted">No runs yet.</p>
        ) : (
          <table className="table runs">
            <thead>
              <tr>
                <th>When</th>
                <th>Agent</th>
                <th>What</th>
                <th>Result</th>
                <th className="num">Tokens</th>
              </tr>
            </thead>
            <tbody>
              {overview.recentRuns.map((run) => (
                <tr key={run.id}>
                  <td>{ago(run.startedAt)}</td>
                  <td>{run.agentId === "intake" ? "Intake assistant" : "Review drafter"}</td>
                  <td>{PURPOSE[run.purpose]}</td>
                  <td>
                    {run.state === "succeeded" ? (
                      <Pill tone="good">Done</Pill>
                    ) : run.state === "running" ? (
                      <Pill tone="info">Running</Pill>
                    ) : run.state === "stale" ? (
                      <span className="faint">Not used: a person acted first</span>
                    ) : (
                      <span className="faint">Failed: {FAILURE[run.errorCode ?? ""] ?? run.errorCode}</span>
                    )}
                  </td>
                  <td className="num">{run.inputTokens ? `${run.inputTokens} in / ${run.outputTokens} out` : "–"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}
