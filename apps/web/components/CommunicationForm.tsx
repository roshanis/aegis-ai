"use client";

import { MAX_COMMUNICATION, checkCommunication } from "@aegis/domain";
import type { ContentPack } from "@aegis/frameworks";
import { useActionState, useDeferredValue, useMemo, useState } from "react";
import { registerCommunication, submitCommunication } from "@/app/(console)/registry/actions";
import { IDLE } from "@/lib/action-state";
import { MARKET, VERDICT, plural } from "@/lib/labels";
import { Tag } from "./ds";

type Mode = { kind: "register" } | { kind: "case"; caseId: string; body: string; markets: readonly string[] };

/**
 * Writing or revising a member communication. The pack's rules run here as
 * the writer types, and again on the server when they submit: what the
 * officer sees is what the writer saw.
 */
export function CommunicationForm({ pack, mode }: { pack: Pick<ContentPack, "id" | "version" | "markets" | "rubric">; mode: Mode }) {
  const [state, action, pending] = useActionState(mode.kind === "register" ? registerCommunication : submitCommunication, IDLE);
  const [name, setName] = useState("");
  const [body, setBody] = useState(mode.kind === "case" ? mode.body : "");
  const [markets, setMarkets] = useState<readonly string[]>(mode.kind === "case" ? mode.markets : pack.markets.slice(0, 1));
  const deferred = useDeferredValue(body);
  const check = useMemo(
    () => (deferred.trim() && markets.length > 0 ? checkCommunication(pack.rubric, deferred, markets) : null),
    [pack, deferred, markets],
  );
  const titles = Object.fromEntries(pack.rubric.criteria.map((c) => [c.id, c.title ?? c.id]));
  const forPerson = check?.coverage.filter((c) => c.status === "uncertain").length ?? 0;
  const ready = body.trim().length > 0 && markets.length > 0 && (mode.kind === "case" || name.trim().length > 0);

  return (
    <form action={action} className="stack" style={{ gap: 24 }} aria-label={mode.kind === "register" ? "File a communication" : "Revise the communication"}>
      {mode.kind === "case" ? <input type="hidden" name="caseId" value={mode.caseId} /> : null}
      {mode.kind === "register" ? (
        <div className="field">
          <label htmlFor="name">What is it called?</label>
          <input id="name" name="name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. 2027 benefits flyer" autoComplete="off" />
        </div>
      ) : null}
      <fieldset className="field">
        <legend className="label">Who is it for?</legend>
        <div className="row" style={{ gap: 16, flexWrap: "wrap" }}>
          {pack.markets.map((m) => (
            <label className="check" key={m}>
              <input
                type="checkbox"
                name="markets"
                value={m}
                checked={markets.includes(m)}
                onChange={(e) => {
                  const on = e.currentTarget.checked;
                  setMarkets((now) => (on ? pack.markets.filter((x) => now.includes(x) || x === m) : now.filter((x) => x !== m)));
                }}
              />
              <span>{MARKET[m] ?? m}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <div className="field">
        <label htmlFor="body">The text, as members will read it</label>
        <textarea
          id="body"
          name="body"
          rows={12}
          maxLength={MAX_COMMUNICATION}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          className="communication-input"
          placeholder="Paste the flyer, letter, email or script."
        />
      </div>

      <section className="panel stack live-check" style={{ gap: 10 }} aria-live="polite" aria-label="Rule check">
        <div className="spread">
          <span className="eyebrow">Rule check · {pack.id}@{pack.version}</span>
          {check ? <Tag tone={VERDICT[check.verdict]!.tone}>{VERDICT[check.verdict]!.label}</Tag> : null}
        </div>
        {check ? (
          <>
            {check.findings.length > 0 ? (
              <ul className="stack" style={{ gap: 4 }}>
                {check.findings.map((f) => (
                  <li key={f.criterionId}>
                    <strong>
                      {f.criterionId} {titles[f.criterionId]}
                    </strong>
                    {f.confidence === "low" ? <span className="muted"> · might break it</span> : null}
                  </li>
                ))}
              </ul>
            ) : (
              <p>Nothing breaks a rule Aegis can check.</p>
            )}
            {forPerson > 0 ? <p className="caption muted">{plural(forPerson, "rule")} only a person can check. The officer checks them.</p> : null}
          </>
        ) : (
          <p className="caption muted">Paste the text to check it as you write.</p>
        )}
      </section>

      {state.error ? <p className="error">{state.error}</p> : null}
      <div>
        <button className="btn btn-primary btn-lg" type="submit" disabled={pending || !ready}>
          {pending ? "Sending…" : mode.kind === "register" ? "Send to the officer" : "Send the new version"}
        </button>
      </div>
    </form>
  );
}
