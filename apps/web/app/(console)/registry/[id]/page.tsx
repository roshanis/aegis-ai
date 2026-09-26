import type { AssetView } from "@aegis/core";
import { caseLabel } from "@aegis/domain";
import type { InitiativePack } from "@aegis/frameworks";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AutoRefresh } from "@/components/AutoRefresh";
import { CaseTable } from "@/components/CaseTable";
import { ConditionsTab, ControlsTab, HistoryTab } from "@/components/CaseTabs";
import { RiskDial, Tag } from "@/components/ds";
import { OpenReviewForm, OperatePanel, StartReview } from "@/components/Forms";
import { Intake } from "@/components/Intake";
import { governance } from "@/lib/db";
import { refusal } from "@/lib/errors";
import { ASSET_KIND, ASSET_STATE, CASE_STATE, TRIGGER, becauseText, formatDate, hash4, nextStep } from "@/lib/labels";
import { requireViewer } from "@/lib/viewer";

export const metadata: Metadata = { title: "Case" };

const TABS = [
  { id: "table", label: "The table" },
  { id: "controls", label: "Controls & evidence" },
  { id: "conditions", label: "Conditions" },
  { id: "history", label: "History" },
] as const;
type Tab = (typeof TABS)[number]["id"];

function Clearance({ view }: { view: AssetView }) {
  const { clearance, asset } = view;
  const blockers = clearance.cleared ? [] : clearance.reason.split("; ");
  return (
    <section className="notice" data-tone={clearance.cleared ? "ok" : asset.state === "retired" ? undefined : "warn"} aria-label="Clearance">
      <span className="notice-mark" aria-hidden="true">
        {clearance.cleared ? "✓" : "!"}
      </span>
      <div className="stack" style={{ gap: 10, flex: 1 }}>
        {clearance.cleared ? (
          <p>
            <strong>Cleared for use.</strong> Approved in {caseLabel(view.cases.find((c) => c.id === clearance.caseId)?.number ?? 0)}, with every gate
            control covered.
          </p>
        ) : blockers.length > 1 ? (
          <div className="stack" style={{ gap: 4 }}>
            <strong>Not cleared for use:</strong>
            <ul>
              {blockers.map((b) => (
                <li key={b}>{b}</li>
              ))}
            </ul>
          </div>
        ) : (
          <p>
            <strong>Not cleared for use:</strong> {blockers[0]}.
          </p>
        )}
        {view.actions.asset.length > 0 ? <OperatePanel assetId={asset.id} actions={view.actions.asset} clearance={clearance} /> : null}
      </div>
    </section>
  );
}

export default async function CasePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string; seat?: string }>;
}) {
  const [{ id }, query] = await Promise.all([params, searchParams]);
  const tab: Tab = TABS.some((t) => t.id === query.tab) ? (query.tab as Tab) : "table";
  const { principal } = await requireViewer();
  const gov = await governance();

  let view: AssetView;
  try {
    view = await gov.getAsset(principal, id);
  } catch (error) {
    if (refusal(error)?.code === "not_found") notFound();
    throw error;
  }
  const history = await gov.assetHistory(principal, id);
  const { asset, openCase, actions, assurance } = view;
  const latest = openCase ?? view.cases.at(-1) ?? null;
  const triaged = view.cases.filter((c) => c.triage !== null).at(-1) ?? null;
  const packOf = triaged ?? latest;
  const pack = packOf ? await gov.policyPack(principal, { caseId: packOf.id }) : null;
  const initiative = pack?.kind === "initiative" ? pack : null;
  const mustAnswer = openCase && (actions.openCase.includes("submit") || actions.openCase.includes("resubmit"));
  const intakePack = mustAnswer ? ((await gov.policyPack(principal, { caseId: openCase.id })) as InitiativePack) : null;
  const assistant = mustAnswer ? await gov.agentOn(principal, "intake") : false;
  const previous = view.cases.filter((c) => Object.keys(c.answers).length > 0).at(-1)?.answers ?? {};
  const step = nextStep(view);
  const drafting = assurance.reviews.some((r) => r.draft.status === "queued");
  const labels = Object.fromEntries([...assurance.reviews.map((r) => [r.domain, r.label]), ...assurance.controls.map((c) => [c.domain, c.domainLabel])]);
  const signed = assurance.reviews.filter((r) => r.status === "signed" || r.status === "abstained").length;
  const covered = assurance.controls.filter((c) => c.covered).length;
  const openConditions = assurance.conditions.filter((c) => c.state === "open" || c.state === "submitted").length;
  const counts: Record<Tab, string | null> = {
    table: assurance.reviews.length > 0 ? `${signed}/${assurance.reviews.length}` : null,
    controls: assurance.controls.length > 0 ? `${covered}/${assurance.controls.length}` : null,
    conditions: openConditions > 0 ? `${openConditions} open` : null,
    history: String(history.length),
  };
  const base = `/registry/${id}`;
  const state = ASSET_STATE[asset.state];
  const fastLane = latest ? history.find((e) => e.caseId === latest.id && e.action === "case.fast_lane_approve") : undefined;

  return (
    <>
      {drafting ? <AutoRefresh /> : null}
      <div className="case-head">
        <div className="stack" style={{ gap: 10, minWidth: 0 }}>
          <span className="crumbs">
            <Link href="/registry">Registry</Link> / {latest ? caseLabel(latest.number) : "not reviewed"}
          </span>
          {latest ? (
            <span className="eyebrow">
              {caseLabel(latest.number)} · {TRIGGER[latest.trigger]} · {CASE_STATE[latest.state]?.label ?? latest.state}
            </span>
          ) : null}
          <h1 className="display-l">{asset.name}</h1>
          <div className="row" style={{ gap: 10 }}>
            <Tag tone={state.tone}>{state.label}</Tag>
            <span className="muted">
              {ASSET_KIND[asset.kind]} · owned by {view.ownerName ?? "a removed person"}
              {latest ? ` · ${latest.packId}@${latest.packVersion}` : ""}
            </span>
          </div>
          {step ? (
            <p className="row" style={{ gap: 10 }}>
              <span className="eyebrow">Your next step</span>
              <strong>{step.label}</strong>
            </p>
          ) : null}
        </div>
        {triaged?.triage ? (
          <RiskDial small tier={triaged.triage.tier} ruleId={triaged.triage.tierRuleId} because={becauseText(pack, triaged.triage.tierRuleId)} />
        ) : null}
      </div>

      <Clearance view={view} />

      {mustAnswer && intakePack ? (
        <section className="panel panel-xl stack" style={{ gap: 18 }} aria-label="Intake">
          <span className="eyebrow">
            {caseLabel(openCase.number)} · {TRIGGER[openCase.trigger]} · your intake
          </span>
          {Object.keys(previous).length > 0 ? <p className="muted">Last answers filled in.</p> : null}
          <Intake pack={{ ...intakePack, goldenSets: undefined }} mode={{ kind: "case", caseId: openCase.id, previous }} assistant={assistant} />
        </section>
      ) : openCase && (openCase.state === "draft" || openCase.state === "changes_requested") ? (
        <p className="notice">
          <span className="notice-mark" aria-hidden="true">
            …
          </span>
          <span>
            Waiting on {view.ownerName ?? "the owner"}&apos;s intake
          </span>
        </p>
      ) : null}

      {openCase && actions.openCase.includes("start_review") ? <StartReview caseId={openCase.id} /> : null}

      <nav className="tabs" aria-label="Case sections">
        {TABS.map((t) => (
          <Link key={t.id} href={t.id === "table" ? base : `${base}?tab=${t.id}`} aria-current={tab === t.id ? "page" : undefined}>
            {t.label}
            {counts[t.id] ? <span className="count">{counts[t.id]}</span> : null}
          </Link>
        ))}
      </nav>

      {tab === "table" ? (
        assurance.reviews.length > 0 ? (
          <CaseTable view={view} pack={initiative} history={history} selected={query.seat ?? null} baseHref={base} />
        ) : fastLane && latest ? (
          <section className="panel panel-xl stack" style={{ gap: 12 }}>
            <span className="eyebrow">{caseLabel(latest.number)}</span>
            <p className="display-m">Approved in the fast lane</p>
            <div className="row" style={{ gap: 8 }}>
              <Tag tone="ok">{String(fastLane.payload.fastLanePolicyId)}</Tag>
              <span className="muted">Accountable: {String(fastLane.payload.accountableApprover)}</span>
            </div>
            <span className="mono-s muted">
              approved {formatDate(fastLane.at)} by the triage rules · audit log #{hash4(fastLane.hash)}
            </span>
          </section>
        ) : (
          <section className="panel panel-xl stack" style={{ gap: 12 }}>
            <p className="muted">{latest ? "Seats appear after triage." : "Not reviewed yet."}</p>
            {!latest && actions.newCase.length > 0 ? <OpenReviewForm assetId={asset.id} triggers={actions.newCase} /> : null}
          </section>
        )
      ) : null}
      {tab === "table" && latest && !openCase && actions.newCase.length > 0 ? (
        <section className="panel stack" style={{ gap: 10 }} aria-label="Re-review">
          <h2 className="section-title">Review it again</h2>
          <OpenReviewForm assetId={asset.id} triggers={actions.newCase} />
        </section>
      ) : null}
      {tab === "controls" ? <ControlsTab view={view} /> : null}
      {tab === "conditions" ? <ConditionsTab view={view} /> : null}
      {tab === "history" ? <HistoryTab history={history.slice().reverse()} labels={labels} /> : null}
    </>
  );
}
