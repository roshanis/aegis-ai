"use client";

import type { ApiKeyView } from "@aegis/core";
import { useActionState, useState } from "react";
import { createApiKey, revokeApiKey, type KeyState } from "@/app/(console)/people/actions";
import { IDLE } from "@/lib/action-state";
import { Tag } from "./ds";

/** API keys a tenant's tools use to post evidence: make one, see it once, revoke it. */

const NO_KEY: KeyState = { error: null, key: null };

function Revoke({ id, name }: { id: string; name: string }) {
  const [state, submit, pending] = useActionState(revokeApiKey, IDLE);
  const [sure, setSure] = useState(false);
  return (
    <form action={submit} className="row" style={{ gap: 6 }}>
      <input type="hidden" name="keyId" value={id} />
      {sure ? (
        <>
          <button className="btn btn-sm" type="submit" disabled={pending} aria-label={`Revoke ${name} now`}>
            {pending ? "Revoking…" : "Revoke now"}
          </button>
          <button className="link-button" type="button" onClick={() => setSure(false)}>
            Keep it
          </button>
        </>
      ) : (
        <button className="link-button" type="button" onClick={() => setSure(true)} aria-label={`Revoke ${name}`}>
          Revoke
        </button>
      )}
      {state.error ? <span className="error">{state.error}</span> : null}
    </form>
  );
}

export function ApiKeys({ keys, endpoint, when }: { keys: readonly ApiKeyView[]; endpoint: string; when: Readonly<Record<string, string>> }) {
  const [state, submit, pending] = useActionState(createApiKey, NO_KEY);
  return (
    <div className="stack" style={{ gap: 14 }}>
      <form action={submit} className="row" style={{ gap: 8, alignItems: "flex-end", flexWrap: "wrap" }} aria-label="Make an API key">
        <div className="field" style={{ flex: "1 1 220px" }}>
          <label htmlFor="key-name">Which tool will use it?</label>
          <input id="key-name" name="name" required maxLength={80} autoComplete="off" placeholder="e.g. Fairness test pipeline" />
        </div>
        <button className="btn btn-primary btn-sm" type="submit" disabled={pending}>
          {pending ? "Making…" : "Make a key"}
        </button>
      </form>
      {state.error ? <p className="error">{state.error}</p> : null}
      {state.key ? (
        <div className="notice stack" data-tone="ok" role="status" style={{ gap: 8, alignItems: "stretch" }}>
          <strong>Copy this key now. Aegis keeps only its hash and will not show it again.</strong>
          <code className="mono-s key-reveal" data-testid="new-key">
            {state.key}
          </code>
          <span className="caption muted">
            POST evidence to <span className="mono-s">{endpoint}</span> with <span className="mono-s">Authorization: Bearer</span> and this key.
          </span>
        </div>
      ) : null}
      {keys.length === 0 ? (
        <p className="caption muted">No keys yet. A key acts for the admin who made it, and stops working if they stop being an admin.</p>
      ) : (
        <ul className="stack key-list" style={{ gap: 0 }}>
          {keys.map((k) => (
            <li key={k.id} className="spread" data-revoked={k.revokedAt ? true : undefined}>
              <span className="stack" style={{ gap: 2, minWidth: 0 }}>
                <strong>{k.name}</strong>
                <span className="caption muted">
                  made by {k.createdBy ?? "a removed person"} · {when[`${k.id}:made`]} · {k.lastUsedAt ? `last used ${when[`${k.id}:used`]}` : "never used"}
                </span>
              </span>
              {k.revokedAt ? <Tag>Revoked</Tag> : <Revoke id={k.id} name={k.name} />}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
