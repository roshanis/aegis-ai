import { summarizeTools } from "@aegis/domain";
import type { Metadata } from "next";
import Link from "next/link";
import { ToolTags } from "@/components/AgentTools";
import { governance } from "@/lib/db";
import { ASSET_STATE, TOOL_EFFECT, plural } from "@/lib/labels";
import { requireViewer } from "@/lib/viewer";

export const metadata: Metadata = { title: "Agent tools" };

const FILTERS = [
  { id: "all", label: "All" },
  { id: "write", label: TOOL_EFFECT.write!.label },
  { id: "external", label: TOOL_EFFECT.external!.label },
  { id: "phi", label: "PHI" },
  { id: "late", label: "Added after approval" },
] as const;

/** Every tool every agent can call, across the tenant: the agent and MCP tool inventory. */
export default async function ToolInventoryPage({ searchParams }: { searchParams: Promise<{ show?: string }> }) {
  const { show } = await searchParams;
  const { principal } = await requireViewer();
  const rows = await (await governance()).toolInventory(principal);
  const filter = FILTERS.find((f) => f.id === show) ?? FILTERS[0];
  const test = (r: (typeof rows)[number]) =>
    filter.id === "all" ? true : filter.id === "phi" ? r.phi : filter.id === "late" ? r.sinceApproval : r.effect === filter.id;
  const shown = rows.filter(test);
  const summary = summarizeTools(rows);
  const agents = new Set(rows.map((r) => r.assetId)).size;
  const count = (id: (typeof FILTERS)[number]["id"]) =>
    id === "all" ? rows.length : id === "phi" ? summary.phi : id === "late" ? rows.filter((r) => r.sinceApproval).length : id === "write" ? summary.writes : summary.external;

  return (
    <>
      <div className="page-head">
        <div>
          <span className="crumbs">
            <Link href="/registry">Registry</Link> / agent tools
          </span>
          <h1 className="display-l">
            What the <em>agents</em> can reach
          </h1>
          <p className="muted">
            {rows.length === 0
              ? "No agent has tools recorded yet. Add them on an agent's Tools tab, by hand or from an MCP server's tools/list."
              : `${plural(summary.tools, "tool")} on ${plural(summary.servers, "server")}, across ${plural(agents, "agent")} not retired.`}
          </p>
        </div>
      </div>

      <nav className="pills" aria-label="Filter tools">
        {FILTERS.map((f) => (
          <Link key={f.id} className="pill" href={f.id === "all" ? "/registry/tools" : `/registry/tools?show=${f.id}`} aria-current={f.id === filter.id ? "true" : undefined}>
            {f.label} <span className="count">{count(f.id)}</span>
          </Link>
        ))}
      </nav>

      <section className="panel panel-xl panel-flush" aria-label="Agent tools">
        {shown.length === 0 ? (
          <p className="empty" style={{ margin: 22 }}>
            {rows.length === 0 ? "Nothing recorded yet." : "No tools match."}
          </p>
        ) : (
          <table className="data responsive tool-table">
            <thead>
              <tr>
                <th scope="col">Agent</th>
                <th scope="col">Server</th>
                <th scope="col">Tool</th>
                <th scope="col">Can</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.id}>
                  <td>
                    <div className="stack" style={{ gap: 2 }}>
                      <Link href={`/registry/${r.assetId}?tab=tools`}>{r.assetName}</Link>
                      <span className="caption muted">{ASSET_STATE[r.assetState].label}</span>
                    </div>
                  </td>
                  <td data-label="Server" className="mono-s">
                    {r.server}
                  </td>
                  <td data-label="Tool">
                    <div className="stack" style={{ gap: 2 }}>
                      <strong className="mono-s">{r.name}</strong>
                      {r.description ? <span className="caption muted">{r.description}</span> : null}
                    </div>
                  </td>
                  <td data-label="Can">
                    <ToolTags tool={r} />
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
