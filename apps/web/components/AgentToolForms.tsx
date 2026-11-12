"use client";

import { TOOL_EFFECTS, parseMcpToolList, type ToolEffect } from "@aegis/domain";
import { useActionState, useEffect, useMemo, useState } from "react";
import { addAgentTool, importMcpTools, removeAgentTool } from "@/app/(console)/registry/actions";
import { IDLE } from "@/lib/action-state";
import { TOOL_EFFECT, plural } from "@/lib/labels";

/** Forms on an agent's Tools tab: add one tool, import an MCP server's tools, take a tool away. */

function useCloseOnSuccess(state: typeof IDLE, close: () => void) {
  useEffect(() => {
    if (!state.error && state !== IDLE) close();
  }, [state, close]);
}

export function RemoveTool({ assetId, toolId, name }: { assetId: string; toolId: string; name: string }) {
  const [state, submit, pending] = useActionState(removeAgentTool, IDLE);
  return (
    <form action={submit} style={{ display: "inline" }}>
      <input type="hidden" name="assetId" value={assetId} />
      <input type="hidden" name="toolId" value={toolId} />
      <button className="link-button" type="submit" disabled={pending} aria-label={`Remove ${name}`} title={state.error ?? undefined}>
        Remove
      </button>
    </form>
  );
}

export function AddTools({ assetId, afterApproval }: { assetId: string; afterApproval: boolean }) {
  const [mode, setMode] = useState<"closed" | "one" | "mcp">("closed");
  const close = useMemo(() => () => setMode("closed"), []);
  return (
    <div className="stack" style={{ gap: 12 }}>
      <div className="row" style={{ gap: 8 }}>
        <button className="btn btn-sm" type="button" aria-pressed={mode === "mcp"} onClick={() => setMode(mode === "mcp" ? "closed" : "mcp")}>
          Import an MCP server
        </button>
        <button className="btn btn-sm" type="button" aria-pressed={mode === "one"} onClick={() => setMode(mode === "one" ? "closed" : "one")}>
          Add a tool
        </button>
      </div>
      {mode !== "closed" && afterApproval ? (
        <p className="hint">It is approved already: a tool added now takes away its clearance until a change review covers it.</p>
      ) : null}
      {mode === "one" ? <AddOne assetId={assetId} close={close} /> : null}
      {mode === "mcp" ? <ImportMcp assetId={assetId} close={close} /> : null}
    </div>
  );
}

function EffectChoice({ value, onChange }: { value: ToolEffect; onChange: (e: ToolEffect) => void }) {
  return (
    <div className="field">
      <span className="label" id="effect-label">
        What can it do?
      </span>
      <input type="hidden" name="effect" value={value} />
      <div className="seg seg-sm" role="group" aria-labelledby="effect-label">
        {TOOL_EFFECTS.map((e) => (
          <button key={e} type="button" aria-pressed={value === e} onClick={() => onChange(e)} title={TOOL_EFFECT[e]!.hint}>
            {TOOL_EFFECT[e]!.label}
          </button>
        ))}
      </div>
      <span className="caption muted">{TOOL_EFFECT[value]!.hint}</span>
    </div>
  );
}

function AddOne({ assetId, close }: { assetId: string; close: () => void }) {
  const [state, submit, pending] = useActionState(addAgentTool, IDLE);
  const [effect, setEffect] = useState<ToolEffect>("read");
  useCloseOnSuccess(state, close);
  return (
    <form action={submit} className="stack raised" style={{ gap: 12 }} aria-label="Add a tool">
      <input type="hidden" name="assetId" value={assetId} />
      <div className="tool-fields">
        <div className="field">
          <label htmlFor="tool-server">Server or integration</label>
          <input id="tool-server" name="server" required autoComplete="off" placeholder="e.g. claims-core" />
        </div>
        <div className="field">
          <label htmlFor="tool-name">Tool</label>
          <input id="tool-name" name="name" required autoComplete="off" placeholder="e.g. get_claim" />
        </div>
      </div>
      <EffectChoice value={effect} onChange={setEffect} />
      <label className="check">
        <input type="checkbox" name="phi" />
        <span>It can see members&apos; health information</span>
      </label>
      <div className="field">
        <label htmlFor="tool-description">What it does (optional)</label>
        <input id="tool-description" name="description" autoComplete="off" maxLength={1000} />
      </div>
      {state.error ? <p className="error">{state.error}</p> : null}
      <div className="row" style={{ gap: 8 }}>
        <button className="btn btn-primary btn-sm" type="submit" disabled={pending}>
          {pending ? "Adding…" : "Add the tool"}
        </button>
        <button className="btn btn-sm" type="button" onClick={close}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function ImportMcp({ assetId, close }: { assetId: string; close: () => void }) {
  const [state, submit, pending] = useActionState(importMcpTools, IDLE);
  const [server, setServer] = useState("");
  const [manifest, setManifest] = useState("");
  useCloseOnSuccess(state, close);
  const preview = useMemo(() => (manifest.trim() && server.trim() ? parseMcpToolList(manifest, server) : null), [manifest, server]);
  return (
    <form action={submit} className="stack raised" style={{ gap: 12 }} aria-label="Import an MCP server">
      <input type="hidden" name="assetId" value={assetId} />
      <div className="field">
        <label htmlFor="mcp-server">Server name</label>
        <input id="mcp-server" name="server" required autoComplete="off" placeholder="e.g. claims-core" value={server} onChange={(e) => setServer(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="mcp-manifest">Its tools/list result</label>
        <textarea
          id="mcp-manifest"
          name="manifest"
          rows={8}
          className="mono-s"
          value={manifest}
          onChange={(e) => setManifest(e.target.value)}
          placeholder='{"tools":[{"name":"get_claim","annotations":{"readOnlyHint":true}}]}'
        />
        <span className="caption muted">
          Aegis reads each tool&apos;s annotations. A tool that does not say it only reads, or that it stays inside its system, is taken to act outside it.
        </span>
      </div>
      <label className="check">
        <input type="checkbox" name="phi" />
        <span>This server can see members&apos; health information</span>
      </label>
      {preview ? (
        preview.problems.length > 0 ? (
          <p className="error">{preview.problems.join("; ")}</p>
        ) : (
          <p aria-live="polite">
            {plural(preview.tools.length, "tool")}:{" "}
            {TOOL_EFFECTS.map((e) => [e, preview.tools.filter((t) => t.effect === e).length] as const)
              .filter(([, n]) => n > 0)
              .map(([e, n]) => `${n} ${TOOL_EFFECT[e]!.label.toLowerCase()}`)
              .join(", ")}
          </p>
        )
      ) : null}
      {state.error ? <p className="error">{state.error}</p> : null}
      <div className="row" style={{ gap: 8 }}>
        <button className="btn btn-primary btn-sm" type="submit" disabled={pending || !preview || preview.problems.length > 0 || preview.tools.length === 0}>
          {pending ? "Importing…" : preview && preview.tools.length > 0 ? `Import ${plural(preview.tools.length, "tool")}` : "Import"}
        </button>
        <button className="btn btn-sm" type="button" onClick={close}>
          Cancel
        </button>
      </div>
    </form>
  );
}
