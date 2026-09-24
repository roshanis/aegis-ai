import { can } from "@aegis/domain";
import type { Metadata } from "next";
import Link from "next/link";
import { Pill } from "@/components/Pill";
import { governance } from "@/lib/db";
import { ASSET_KIND, ASSET_STATE, CASE_STATE, TIER, currentReview, nextStep } from "@/lib/labels";
import { requireViewer } from "@/lib/viewer";

export const metadata: Metadata = { title: "Registry" };

export default async function RegistryPage() {
  const { principal, tenant } = await requireViewer();
  const views = await (await governance()).listAssetViews(principal);
  const todo = views.flatMap((view) => {
    const step = nextStep(view);
    return step ? [{ view, step }] : [];
  });
  const stats = [
    { label: "In use", value: views.filter((v) => v.asset.state === "active").length },
    { label: "Under review", value: views.filter((v) => v.openCase).length },
    { label: "Paused", value: views.filter((v) => v.asset.state === "paused").length },
    { label: "Not cleared", value: views.filter((v) => !v.clearance.cleared && v.asset.state !== "retired").length },
  ];

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Registry</h1>
          <p className="muted">
            Every AI system, agent and vendor model {tenant.name} runs, and whether it&apos;s cleared for use right now.
          </p>
        </div>
        {can(principal, "asset.register") ? (
          <Link className="btn btn-primary" href="/registry/new">
            + Register AI
          </Link>
        ) : null}
      </div>

      {todo.length > 0 ? (
        <section className="stack" aria-labelledby="needs-you">
          <h2 id="needs-you">Needs you</h2>
          <div className="todo-grid">
            {todo.map(({ view, step }) => (
              <Link className="todo" href={`/registry/${view.asset.id}`} key={view.asset.id}>
                <Pill tone={step.tone} plain>
                  {step.label}
                </Pill>
                <strong>{view.asset.name}</strong>
                <span className="faint" style={{ fontSize: 13 }}>
                  {ASSET_KIND[view.asset.kind]} · {view.ownerName}
                </span>
              </Link>
            ))}
          </div>
        </section>
      ) : null}

      <section className="stats">
        {stats.map((s) => (
          <div className="card stat" key={s.label}>
            <div className="stat-value">{s.value}</div>
            <div className="stat-label">{s.label}</div>
          </div>
        ))}
      </section>

      <section className="card" style={{ padding: "18px 6px 6px" }}>
        {views.length === 0 ? (
          <p className="muted" style={{ padding: "0 14px 14px" }}>
            Nothing registered yet.
          </p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Status</th>
                <th>Review</th>
                <th className="hide-narrow">Risk</th>
                <th className="hide-narrow">Cleared</th>
              </tr>
            </thead>
            <tbody>
              {views.map((view) => {
                const review = currentReview(view);
                const state = ASSET_STATE[view.asset.state];
                const tier = review?.tier ? TIER[review.tier] : null;
                return (
                  <tr key={view.asset.id}>
                    <td>
                      <Link className="row-link name" href={`/registry/${view.asset.id}`}>
                        {view.asset.name}
                      </Link>
                      <div className="faint" style={{ fontSize: 13 }}>
                        {ASSET_KIND[view.asset.kind]}
                      </div>
                    </td>
                    <td>
                      <Pill tone={state.tone}>{state.label}</Pill>
                    </td>
                    <td>
                      {review ? (
                        <Pill tone={CASE_STATE[review.state]?.tone ?? "neutral"} plain>
                          {CASE_STATE[review.state]?.label ?? review.state}
                        </Pill>
                      ) : (
                        <span className="faint">Not started</span>
                      )}
                    </td>
                    <td className="hide-narrow">{tier ? <Pill tone={tier.tone}>{tier.label}</Pill> : "—"}</td>
                    <td className="hide-narrow">
                      {view.clearance.cleared ? (
                        <span style={{ color: "var(--good)", fontWeight: 600 }}>✓ Cleared</span>
                      ) : (
                        <span className="faint">No</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}
