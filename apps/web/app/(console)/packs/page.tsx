import type { PackVersion } from "@aegis/core";
import type { Condition, Tier } from "@aegis/domain";
import type { InitiativePack } from "@aegis/frameworks";
import type { Metadata } from "next";
import { Fragment } from "react";
import { TIER_NAME, Tag, TierText } from "@/components/ds";
import { governance } from "@/lib/db";
import { formatDate } from "@/lib/labels";
import { requireViewer } from "@/lib/viewer";

export const metadata: Metadata = { title: "Policy packs" };

/** A rule condition in plain words, using the pack's own question labels. */
function words(c: Condition, fields: Record<string, string>): string {
  if ("all" in c) return c.all.length === 0 ? "always" : c.all.map((x) => words(x, fields)).join(" and ");
  if ("any" in c) return c.any.map((x) => words(x, fields)).join(" or ");
  if ("not" in c) return `not (${words(c.not, fields)})`;
  if ("yes" in c) return fields[c.yes] ?? c.yes;
  return `${c.equals[0]} is ${String(c.equals[1])}`;
}

function Initiative({ pack }: { pack: InitiativePack }) {
  const fields = Object.fromEntries(pack.questions.map((q) => [q.field, q.field]));
  const tiers: Tier[] = ["low", "medium", "high", "critical"];
  return (
    <div className="pack-grid">
      {pack.sentence ? (
        <section className="panel stack" style={{ gridColumn: "1 / -1" }} aria-labelledby="sentence-h">
          <h2 id="sentence-h" className="eyebrow">
            The intake sentence
          </h2>
          <p className="serif" style={{ fontSize: 26, lineHeight: "38px" }}>
            {pack.sentence.template.split(/\{(\w+)\}/).map((part, i) =>
              i % 2 === 0 ? (
                <Fragment key={i}>{part}</Fragment>
              ) : part === "purpose" ? (
                <span key={i} className="muted" style={{ fontStyle: "italic" }}>
                  what it does
                </span>
              ) : (
                <span key={i} className="mono" title={part} style={{ fontSize: 15 }}>
                  [{pack.sentence!.phrases[part]?.yes} / {pack.sentence!.phrases[part]?.no}]
                </span>
              ),
            )}
          </p>
        </section>
      ) : null}

      <section className="panel stack" aria-labelledby="questions-h">
        <h2 id="questions-h" className="eyebrow">
          Questions · {pack.questions.length}
        </h2>
        <ol className="rule-list">
          {pack.questions.map((q) => (
            <li key={q.field} style={{ gridTemplateColumns: "minmax(0, 170px) minmax(0, 1fr)" }}>
              <span className="mono">{q.field}</span>
              <span>
                {q.label}
                <span className="hint" style={{ display: "block" }}>
                  {q.help}
                </span>
              </span>
            </li>
          ))}
        </ol>
      </section>

      <section className="panel stack" aria-labelledby="tiers-h">
        <h2 id="tiers-h" className="eyebrow">
          Risk tiers · the first rule that matches wins
        </h2>
        <ol className="rule-list">
          {pack.triage.tierRules.map((r) => (
            <li key={r.id}>
              <span className="mono">{r.id}</span>
              <TierText tier={r.tier} />
              <span>
                {r.because}
                <span className="hint mono-s" style={{ display: "block" }}>
                  when {words(r.when, fields)}
                </span>
              </span>
            </li>
          ))}
          <li>
            <span className="mono">default</span>
            <TierText tier={pack.triage.defaultTier} />
            <span className="muted">when no rule matches</span>
          </li>
        </ol>
      </section>

      <section className="panel stack" aria-labelledby="teams-h">
        <h2 id="teams-h" className="eyebrow">
          Review teams
        </h2>
        <ol className="rule-list">
          {tiers.map((t) => (
            <li key={t}>
              <TierText tier={t} />
              <span className="mono-s muted">every case</span>
              <span>{pack.triage.baseDomains[t].map((d) => pack.domains[d] ?? d).join(", ")}</span>
            </li>
          ))}
          {pack.triage.domainRules.map((r, i) => (
            <li key={i}>
              <span className="mono-s">+ {r.add.map((d) => pack.domains[d] ?? d).join(", ")}</span>
              <span className="mono-s muted">added</span>
              <span>
                {r.because}
                <span className="hint mono-s" style={{ display: "block" }}>
                  when {words(r.when, fields)}
                </span>
              </span>
            </li>
          ))}
        </ol>
      </section>

      <section className="panel stack" aria-labelledby="fast-h">
        <h2 id="fast-h" className="eyebrow">
          Fast lane
        </h2>
        <p>
          <span className="mono">{pack.fastLane.policyId}</span> approves {TIER_NAME[pack.fastLane.maxTier].toLowerCase()}-risk work on submit.
          Accountable: <strong>{pack.fastLane.accountableApprover}</strong>.
        </p>
        <ul style={{ listStyle: "disc", paddingLeft: 18 }}>
          {pack.fastLane.disqualifiers.map((d) => (
            <li key={d.reason}>Not if the {d.reason}</li>
          ))}
        </ul>
      </section>

      {pack.goldenSets ? (
        <section className="panel stack" aria-labelledby="golden-h">
          <h2 id="golden-h" className="eyebrow">
            Golden sets · what agents must pass
          </h2>
          {[
            { name: "intake assistant", set: pack.goldenSets.intake },
            { name: "review drafter", set: pack.goldenSets.reviewDrafter },
          ].map(({ name, set }) => (
            <p key={set.id}>
              <span className="mono">
                {set.id}@{set.version}
              </span>{" "}
              · {name} · {set.cases.length} cases · passes at {Math.round(set.threshold * 100)}% with no critical failures
            </p>
          ))}
        </section>
      ) : null}

      <section className="panel panel-flush" style={{ gridColumn: "1 / -1" }} aria-labelledby="controls-h">
        <h2 id="controls-h" className="eyebrow" style={{ padding: "18px 22px 0" }}>
          Controls · {pack.controls.length}
        </h2>
        <table className="data responsive">
          <thead>
            <tr>
              <th scope="col">Control</th>
              <th scope="col">Team</th>
              <th scope="col">Kind</th>
              <th scope="col">Evidence</th>
              <th scope="col">Applies when</th>
            </tr>
          </thead>
          <tbody>
            {pack.controls.map((c) => (
              <tr key={c.id}>
                <td>
                  <span className="mono">{c.id}</span> {c.name}
                </td>
                <td data-label="Team">{pack.domains[c.domain] ?? c.domain}</td>
                <td data-label="Kind">
                  <Tag tone={c.enforcement === "gate" ? "warn" : "neutral"}>{c.enforcement === "gate" ? "Gate" : "Monitor"}</Tag>
                </td>
                <td data-label="Evidence">
                  {c.requiredEvidence} · {c.cadence}
                </td>
                <td data-label="Applies when" className="mono-s muted">
                  {words(c.when, fields)}
                  {c.minTier ? ` · ${c.minTier} tier and up` : ""}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}

export default async function PacksPage() {
  const { principal } = await requireViewer();
  const packs = await (await governance()).policyPacks(principal);
  const enabled = packs.filter((p) => p.enabled);
  const older = packs.filter((p) => !p.enabled);

  return (
    <>
      <div className="page-head">
        <div>
          <span className="eyebrow">Policy packs · versioned data, never code</span>
          <h1 className="display-l">
            The rules <em>in force</em>
          </h1>
        </div>
      </div>
      {enabled.map((p: PackVersion) => (
        <section key={`${p.packId}@${p.version}`} className="stack" style={{ gap: 16 }} aria-label={`${p.packId}@${p.version}`}>
          <div className="spread">
            <div className="stack" style={{ gap: 6 }}>
              <span className="mono">
                {p.packId}@{p.version}
              </span>
              <h2 className="display-m">{p.pack.title}</h2>
              <p className="muted">{p.pack.summary}</p>
            </div>
            <div className="stack" style={{ gap: 6, alignItems: "flex-end" }}>
              <Tag tone="ok">Enabled</Tag>
              <span className="caption muted">since {formatDate(p.addedAt)}</span>
            </div>
          </div>
          <div className="row" style={{ gap: 6 }}>
            {p.pack.frameworkRefs.map((f) => (
              <Tag key={f}>{f}</Tag>
            ))}
          </div>
          {p.pack.kind === "initiative" ? (
            <Initiative pack={p.pack} />
          ) : (
            <p className="panel">Content rubric for {p.pack.markets.join(", ")}: {p.pack.rubric.criteria.length} criteria.</p>
          )}
        </section>
      ))}
      {older.length > 0 ? (
        <section className="stack" aria-label="Earlier versions">
          <span className="eyebrow">Earlier versions, kept for the cases reviewed under them</span>
          <ul className="stack" style={{ gap: 4 }}>
            {older.map((p) => (
              <li key={`${p.packId}@${p.version}`} className="mono">
                {p.packId}@{p.version} · added {formatDate(p.addedAt)}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </>
  );
}
