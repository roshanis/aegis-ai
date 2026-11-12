import type { CommunicationView, ContentVersionView, CriterionView } from "@aegis/core";
import type { Finding } from "@aegis/domain";
import Link from "next/link";
import { Fragment } from "react";
import { MARKET, VERDICT, ago, plural } from "@/lib/labels";
import { Tag } from "./ds";

/**
 * A member communication under review: the text with each finding's quote
 * marked, the pack's rules beside it with how each fared, and every
 * version the writer sent. Server-rendered; the decision form is passed in.
 */

const STATUS: Record<string, { mark: string; label: string; tone: "ok" | "bad" | "warn" | "neutral" }> = {
  checked: { mark: "✓", label: "Met", tone: "ok" },
  finding: { mark: "✗", label: "Broken", tone: "bad" },
  uncertain: { mark: "?", label: "Check by hand", tone: "warn" },
  not_applicable: { mark: "–", label: "Does not apply", tone: "neutral" },
};

/** The body split into plain runs and marked quotes, first match of each quote, overlaps skipped. */
function marked(body: string, findings: readonly Finding[]): { text: string; finding: Finding | null }[] {
  const ranges = findings
    .filter((f) => f.quote)
    .map((f) => ({ start: body.indexOf(f.quote), end: body.indexOf(f.quote) + f.quote.length, finding: f }))
    .filter((r) => r.start >= 0)
    .sort((a, b) => a.start - b.start);
  const parts: { text: string; finding: Finding | null }[] = [];
  let at = 0;
  for (const r of ranges) {
    if (r.start < at) continue;
    if (r.start > at) parts.push({ text: body.slice(at, r.start), finding: null });
    parts.push({ text: body.slice(r.start, r.end), finding: r.finding });
    at = r.end;
  }
  if (at < body.length) parts.push({ text: body.slice(at), finding: null });
  return parts;
}

function Criterion({ criterion, finding }: { criterion: CriterionView; finding: Finding | undefined }) {
  const status = STATUS[criterion.status] ?? STATUS.uncertain!;
  const unsure = finding?.confidence === "low";
  return (
    <li className="criterion" data-status={criterion.status} data-unsure={unsure || undefined}>
      <span className="criterion-mark" data-tone={unsure ? "warn" : status.tone} aria-hidden="true">
        {unsure ? "!" : status.mark}
      </span>
      <div className="stack" style={{ gap: 2, minWidth: 0 }}>
        <span className="row" style={{ gap: 8, flexWrap: "wrap" }}>
          <strong>
            {criterion.id} {criterion.title}
          </strong>
          <span className="caption muted">
            {unsure ? "Might be broken: check it" : status.label} · {criterion.severity}
          </span>
        </span>
        {finding ? (
          <span className="caption">
            {finding.explanation} {finding.recommendation}
          </span>
        ) : criterion.status === "uncertain" ? (
          <span className="caption muted">{criterion.description}</span>
        ) : null}
      </div>
    </li>
  );
}

export function CommunicationPanel({
  view,
  shown,
  baseHref,
  children,
}: {
  view: CommunicationView;
  shown: ContentVersionView;
  baseHref: string;
  /** The decision or revision form, when the viewer has one. */
  children?: React.ReactNode;
}) {
  const latest = view.versions.at(-1)!;
  const isLatest = shown.version === latest.version;
  const byId = new Map(shown.findings.map((f) => [f.criterionId, f]));
  const status = new Map(shown.coverage.map((c) => [c.criterionId, c.status]));
  const criteria = view.criteria
    .filter((c) => status.has(c.id))
    .map((c) => ({ ...c, status: status.get(c.id)! }));
  const order = { finding: 0, uncertain: 1, checked: 2, not_applicable: 3 } as Record<string, number>;
  criteria.sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9));
  const verdict = VERDICT[shown.verdict]!;
  const forPerson = criteria.filter((c) => c.status === "uncertain").length;

  return (
    <div className="stack" style={{ gap: 18 }}>
      <section className="panel stack" style={{ gap: 12 }} aria-label="How this version fared">
        <div className="spread">
          <div className="stack" style={{ gap: 4 }}>
            <span className="eyebrow">
              Version {shown.version}
              {view.versions.length > 1 ? ` of ${view.versions.length}` : ""} · {shown.submittedBy.name ?? "a removed person"} ·{" "}
              {ago(shown.submittedAt)}
            </span>
            <h2 className="display-m">{verdict.label}</h2>
          </div>
          <Tag tone={verdict.tone}>
            {shown.findings.length === 0 ? "No findings" : plural(shown.findings.length, "finding")}
            {forPerson > 0 ? ` · ${forPerson} by hand` : ""}
          </Tag>
        </div>
        <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
          {shown.byMarket.map((m) => (
            <Tag key={m.jurisdiction} tone={VERDICT[m.verdict]!.tone}>
              {MARKET[m.jurisdiction] ?? m.jurisdiction}: {VERDICT[m.verdict]!.label.toLowerCase()}
            </Tag>
          ))}
          <span className="mono-s muted">
            {view.pack.id}@{view.pack.version} · sha256 {shown.bodySha256.slice(0, 12)}
          </span>
        </div>
        {view.versions.length > 1 ? (
          <nav className="row" style={{ gap: 6, flexWrap: "wrap" }} aria-label="Versions">
            {view.versions.map((v) => (
              <Link
                key={v.version}
                className="btn btn-sm"
                href={v.version === latest.version ? baseHref : `${baseHref}?v=${v.version}`}
                aria-current={v.version === shown.version ? "page" : undefined}
              >
                v{v.version} · {VERDICT[v.verdict]!.label.toLowerCase()}
              </Link>
            ))}
          </nav>
        ) : null}
        {!isLatest ? <p className="hint">An earlier version, kept as it was sent. The officer decides on version {latest.version}.</p> : null}
      </section>

      <div className="communication">
        <section className="panel stack" style={{ gap: 10 }} aria-label="The communication">
          <span className="eyebrow">As members will read it</span>
          <div className="communication-body">
            {marked(shown.body, shown.findings).map((part, i) =>
              part.finding ? (
                <mark key={i} data-unsure={part.finding.confidence === "low" || undefined} title={`${part.finding.criterionId}: ${part.finding.explanation}`}>
                  {part.text}
                  <sup>{part.finding.criterionId}</sup>
                </mark>
              ) : (
                <Fragment key={i}>{part.text}</Fragment>
              ),
            )}
          </div>
        </section>
        <section className="panel stack" style={{ gap: 10 }} aria-label="Rules">
          <span className="eyebrow">{view.pack.title}</span>
          <ul className="criteria">
            {criteria.map((c) => (
              <Criterion key={c.id} criterion={c} finding={byId.get(c.id)} />
            ))}
          </ul>
        </section>
      </div>

      {isLatest && children ? children : null}
    </div>
  );
}
