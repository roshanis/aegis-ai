"use client";

import { useActionState, useEffect, useState } from "react";
import { connectModel, runEvaluation, switchAgent } from "@/app/(console)/agents/actions";
import { IDLE } from "@/lib/action-state";
import { PROVIDERS } from "@/lib/labels";

interface Current {
  readonly provider: string;
  readonly model: string;
  readonly endpoint: string | null;
  readonly apiVersion: string | null;
  readonly keyHint: string | null;
}

const PLACEHOLDER: Record<string, string> = {
  openai: "e.g. gpt-5-mini",
  "azure-openai": "Your deployment name",
  "openai-compatible": "e.g. llama-3.3-70b-instruct",
};

/** Change the model agents run on. Collapsed until asked for, because changing it turns the agents off. */
export function ModelForm({ current, providers }: { current: Current | null; providers: readonly string[] }) {
  const [state, submit, pending] = useActionState(connectModel, IDLE);
  const [open, setOpen] = useState(current === null);
  const [provider, setProvider] = useState(current?.provider ?? providers[0] ?? "scripted");
  useEffect(() => {
    if (!state.error && state !== IDLE) setOpen(false);
  }, [state]);

  if (!open) {
    return (
      <div>
        <button className="btn" type="button" onClick={() => setOpen(true)}>
          Change model
        </button>
      </div>
    );
  }
  const same = current?.provider === provider;
  const needsEndpoint = provider === "azure-openai" || provider === "openai-compatible";
  return (
    <form action={submit} className="stack evidence-form" style={{ gap: 12 }}>
      <input type="hidden" name="provider" value={provider} />
      <div className="segmented" role="group" aria-label="Provider">
        {providers.map((p) => (
          <button key={p} type="button" aria-pressed={provider === p} onClick={() => setProvider(p)}>
            {PROVIDERS[p]?.label ?? p}
          </button>
        ))}
      </div>
      <p className="faint" style={{ fontSize: 13 }}>
        {PROVIDERS[provider]?.help}
      </p>
      {provider !== "scripted" ? (
        <>
          <div className="field">
            <label htmlFor="model">{provider === "azure-openai" ? "Deployment" : "Model"}</label>
            <input id="model" name="model" type="text" required defaultValue={same ? current?.model : ""} placeholder={PLACEHOLDER[provider]} autoComplete="off" />
          </div>
          {needsEndpoint ? (
            <div className="field">
              <label htmlFor="endpoint">{provider === "azure-openai" ? "Endpoint" : "Base URL"}</label>
              <input
                id="endpoint"
                name="endpoint"
                type="url"
                required
                defaultValue={same ? (current?.endpoint ?? "") : ""}
                placeholder={provider === "azure-openai" ? "https://your-resource.openai.azure.com" : "https://llm.example.com/v1"}
              />
            </div>
          ) : null}
          {provider === "azure-openai" ? (
            <div className="field">
              <label htmlFor="apiVersion">API version</label>
              <input id="apiVersion" name="apiVersion" type="text" required defaultValue={same ? (current?.apiVersion ?? "") : ""} placeholder="2024-10-21" />
            </div>
          ) : null}
          <div className="field">
            <label htmlFor="apiKey">API key</label>
            <input
              id="apiKey"
              name="apiKey"
              type="password"
              autoComplete="off"
              required={!(same && current?.keyHint)}
              placeholder={same && current?.keyHint ? `Leave blank to keep the key ending ${current.keyHint}` : "Paste the key"}
            />
            <span className="faint" style={{ fontSize: 12.5 }}>
              Sealed with this organization&apos;s own data key. Nobody can read it back, including admins.
            </span>
          </div>
        </>
      ) : (
        <input type="hidden" name="model" value="scripted" />
      )}
      <p className="faint" style={{ fontSize: 13 }}>
        Switching to a different model turns both agents off until each passes its golden set on it again. A new key for the
        same model keeps them on.
      </p>
      {state.error ? <div className="error">{state.error}</div> : null}
      <div className="row">
        <button className="btn btn-primary" type="submit" disabled={pending}>
          {pending ? "Saving…" : "Save model"}
        </button>
        {current ? (
          <button className="btn" type="button" onClick={() => setOpen(false)}>
            Cancel
          </button>
        ) : null}
      </div>
    </form>
  );
}

export function AgentControls({
  agent,
  title,
  actions,
}: {
  agent: string;
  title: string;
  actions: { readonly evaluate: boolean; readonly enable: boolean; readonly disable: boolean };
}) {
  const [evalState, evaluate, evaluating] = useActionState(runEvaluation, IDLE);
  const [switchState, flip, flipping] = useActionState(switchAgent, IDLE);
  const error = evalState.error ?? switchState.error;
  if (!actions.evaluate && !actions.enable && !actions.disable) return null;
  return (
    <div className="stack" style={{ gap: 8 }}>
      <div className="row" style={{ gap: 8 }}>
        {actions.enable ? (
          <form action={flip}>
            <input type="hidden" name="agent" value={agent} />
            <input type="hidden" name="enabled" value="true" />
            <button className="btn btn-good" type="submit" disabled={flipping} aria-label={`Turn on the ${title.toLowerCase()}`}>
              {flipping ? "Turning on…" : "Turn on"}
            </button>
          </form>
        ) : null}
        {actions.disable ? (
          <form action={flip}>
            <input type="hidden" name="agent" value={agent} />
            <input type="hidden" name="enabled" value="false" />
            <button className="btn btn-warn" type="submit" disabled={flipping} aria-label={`Turn off the ${title.toLowerCase()}`}>
              {flipping ? "Turning off…" : "Turn off"}
            </button>
          </form>
        ) : null}
        {actions.evaluate ? (
          <form action={evaluate}>
            <input type="hidden" name="agent" value={agent} />
            <button className="btn" type="submit" disabled={evaluating} aria-label={`Run the ${title.toLowerCase()}'s golden set`}>
              {evaluating ? "Starting…" : "Run golden set"}
            </button>
          </form>
        ) : null}
      </div>
      {error ? <div className="error">{error}</div> : null}
    </div>
  );
}
