import type { AssetView } from "@aegis/core";
import { can, caseLabel } from "@aegis/domain";
import type { Metadata } from "next";
import Link from "next/link";
import { Icon, TierText } from "@/components/ds";
import { governance } from "@/lib/db";
import { ASSET_KIND, CASE_STATE, currentReview, nextStep, stageOf } from "@/lib/labels";
import { requireViewer } from "@/lib/viewer";

export const metadata: Metadata = { title: "Registry" };

const FILTERS = [
  { id: "all", label: "All", test: () => true },
  { id: "live", label: "In use", test: (v: AssetView) => v.asset.state === "active" },
  { id: "review", label: "In review", test: (v: AssetView) => v.openCase !== null },
  { id: "paused", label: "Paused", test: (v: AssetView) => v.asset.state === "paused" },
  { id: "idle", label: "Not in use", test: (v: AssetView) => v.asset.state === "registered" },
  { id: "retired", label: "Retired", test: (v: AssetView) => v.asset.state === "retired" },
] as const;

const STEPS = ["intake", "review", "decided", "in use", "re-review"];

function Stage({ view }: { view: AssetView }) {
  const stage = stageOf(view);
  return (
    <div className="stage">
      <div className="stage-dots" role="img" aria-label={`Stage: ${stage.at < 0 ? "retired" : STEPS[stage.at]}`}>
        {STEPS.map((step, i) => (
          <span key={step} style={{ display: "contents" }}>
            {i > 0 ? <span className="bar" data-state={i <= stage.at ? "done" : "todo"} /> : null}
            <span className="dot" data-state={i < stage.at ? "done" : i === stage.at ? (stage.warn ? "warn" : "current") : "todo"} />
          </span>
        ))}
      </div>
      <span className={stage.warn ? "status-warn" : "muted"} style={{ fontSize: 13 }}>
        {stage.label}
      </span>
    </div>
  );
}

function openCaseLine(view: AssetView) {
  const open = view.openCase;
  if (!open) return null;
  const reviews = view.assurance.reviews;
  const signed = reviews.filter((r) => r.status === "signed" || r.status === "abstained").length;
  return reviews.length > 0 && open.state === "in_review" ? `${signed} of ${reviews.length} signed` : (CASE_STATE[open.state]?.label ?? open.state);
}

export default async function RegistryPage({ searchParams }: { searchParams: Promise<{ show?: string }> }) {
  const { show } = await searchParams;
  const { principal } = await requireViewer();
  const views = await (await governance()).listAssetViews(principal);
  const filter = FILTERS.find((f) => f.id === show) ?? FILTERS[0];
  const shown = views.filter(filter.test);

  return (
    <>
      <div className="page-head">
        <div>
          <span className="eyebrow">Registry · systems, agents, vendor models</span>
          <h1 className="display-l">
            Registered <em>AI systems</em>
          </h1>
        </div>
        {can(principal, "asset.register") ? (
          <Link className="btn btn-primary" href="/registry/new">
            <Icon name="intake" size={16} />
            Register a system
          </Link>
        ) : null}
      </div>

      <nav className="pills" aria-label="Filter by state">
        {FILTERS.map((f) => (
          <Link key={f.id} className="pill" href={f.id === "all" ? "/registry" : `/registry?show=${f.id}`} aria-current={f.id === filter.id ? "true" : undefined}>
            {f.label} <span className="count">{views.filter(f.test).length}</span>
          </Link>
        ))}
      </nav>

      <section className="panel panel-xl panel-flush" aria-label="Registered systems">
        {shown.length === 0 ? (
          <p className="empty" style={{ margin: 22 }}>
            {views.length === 0 ? "Nothing is registered yet." : `Nothing is ${filter.label.toLowerCase()}.`}
          </p>
        ) : (
          <table className="data responsive">
            <thead>
              <tr>
                <th scope="col">System</th>
                <th scope="col">Tier</th>
                <th scope="col">Stage · intake → review → decided → in use → re-review</th>
                <th scope="col">Case</th>
                <th scope="col">Your next step</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((view) => {
                const review = currentReview(view);
                const step = nextStep(view);
                return (
                  <tr key={view.asset.id}>
                    <td>
                      <div className="system-name">
                        <span className="kind-mark" data-kind={view.asset.kind === "agent" ? "agent" : "system"} title={ASSET_KIND[view.asset.kind]} />
                        <div className="stack" style={{ gap: 2 }}>
                          <Link href={`/registry/${view.asset.id}`}>{view.asset.name}</Link>
                          <span className="caption muted">
                            {view.ownerName ?? "A removed person"} · {ASSET_KIND[view.asset.kind]}
                          </span>
                        </div>
                      </div>
                    </td>
                    <td data-label="Tier">
                      <TierText tier={view.cases.filter((c) => c.tier !== null).at(-1)?.tier ?? null} />
                    </td>
                    <td data-label="Stage">
                      <Stage view={view} />
                    </td>
                    <td data-label="Case">
                      {review ? (
                        <span className="row" style={{ gap: 8 }}>
                          <Link className="mono-s" href={`/registry/${view.asset.id}`}>
                            {caseLabel(review.number)}
                          </Link>
                          <span className="caption muted">{openCaseLine(view) ?? CASE_STATE[review.state]?.label}</span>
                        </span>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    <td data-label="Your next step">
                      {step ? (
                        <Link href={`/registry/${view.asset.id}`} style={{ fontWeight: 600 }}>
                          {step.label}
                        </Link>
                      ) : (
                        <span className="muted">Nothing for you</span>
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
