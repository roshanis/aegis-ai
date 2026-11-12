import type { AgentToolsView, ToolView } from "@aegis/core";
import Link from "next/link";
import { TOOL_EFFECT, ago, formatDate, plural } from "@/lib/labels";
import { AddTools, RemoveTool } from "./AgentToolForms";
import { Tag } from "./ds";

/**
 * What an agent can reach, by server: each tool, what it can do, whether it
 * sees health information, and whether it came after the approval.
 */

export function ToolTags({ tool }: { tool: Pick<ToolView, "effect" | "phi" | "sinceApproval"> }) {
  const effect = TOOL_EFFECT[tool.effect]!;
  return (
    <span className="row" style={{ gap: 6, flexWrap: "wrap" }}>
      <Tag tone={effect.tone}>{effect.label}</Tag>
      {tool.phi ? <Tag tone="warn">PHI</Tag> : null}
      {tool.sinceApproval ? <Tag tone="bad">Added after approval</Tag> : null}
    </span>
  );
}

export function ToolsTab({ view, assetId }: { view: AgentToolsView; assetId: string }) {
  const { tools, summary, canEdit, approvedAt } = view;
  const servers = [...new Set(tools.map((t) => t.server))];
  const late = tools.filter((t) => t.sinceApproval).length;
  return (
    <div className="stack" style={{ gap: 18 }}>
      <section className="panel stack" style={{ gap: 12 }} aria-label="Tool access">
        <div className="spread">
          <div className="stack" style={{ gap: 4 }}>
            <h2 className="section-title">What it can reach</h2>
            <p className="muted">
              {tools.length === 0
                ? "No tools recorded. An agent with no tools can only answer from what it is given."
                : `${plural(summary.tools, "tool")} on ${plural(summary.servers, "server")}: ${summary.writes} change data, ${summary.external} act outside, ${summary.phi} see PHI.`}
            </p>
            <p className="caption muted">
              {approvedAt ? `Approved ${formatDate(approvedAt)}. Tools added since need a change review.` : "Tools recorded before the decision are part of what it approves."}{" "}
              <Link href="/registry/tools">Every agent&apos;s tools</Link>
            </p>
          </div>
        </div>
        {late > 0 ? (
          <p className="notice" data-tone="warn">
            <span className="notice-mark" aria-hidden="true">
              !
            </span>
            <span>{plural(late, "tool")} added after its approval. Open a change review, or remove them, to clear it again.</span>
          </p>
        ) : null}
        {canEdit ? <AddTools assetId={assetId} afterApproval={approvedAt !== null} /> : null}
      </section>
      {servers.map((server) => (
        <section className="panel stack tools" key={server} style={{ gap: 0, padding: 0 }} aria-label={server}>
          <h3 className="section-title mono" style={{ padding: "16px 22px 8px" }}>
            {server}
          </h3>
          <ul>
            {tools
              .filter((t) => t.server === server)
              .map((t) => (
                <li key={t.id} className="tool" data-late={t.sinceApproval || undefined}>
                  <div className="stack" style={{ gap: 2, minWidth: 0 }}>
                    <strong className="mono">{t.name}</strong>
                    {t.description ? <span className="caption">{t.description}</span> : null}
                    <span className="caption muted">
                      added by {t.addedBy ?? "a removed person"} · {ago(t.addedAt)}
                      {canEdit ? (
                        <>
                          {" · "}
                          <RemoveTool assetId={assetId} toolId={t.id} name={`${server}/${t.name}`} />
                        </>
                      ) : null}
                    </span>
                  </div>
                  <ToolTags tool={t} />
                </li>
              ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
