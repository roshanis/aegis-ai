import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { ModelProvider } from "@openai/agents-core";
import { OpenAIProvider } from "@openai/agents-openai";
import { AzureOpenAI, OpenAI } from "openai";
import { AgentFailure } from "./errors";
import { ScriptedModel } from "./scripted";

/**
 * Which model a tenant's agents run on. Each tenant brings its own: Aegis
 * never pools tenants onto one key. `scripted` is a deterministic stand-in
 * with no AI in it, for sandboxes, development and tests.
 */
export const MODEL_PROVIDERS = ["scripted", "openai", "azure-openai", "openai-compatible"] as const;
export type ModelProviderId = (typeof MODEL_PROVIDERS)[number];

export interface ModelConnection {
  readonly provider: ModelProviderId;
  /** Model name, or the deployment name on Azure. */
  readonly model: string;
  /** Azure resource endpoint, or the base URL of an OpenAI-compatible server. */
  readonly endpoint?: string | null;
  /** Azure OpenAI API version. */
  readonly apiVersion?: string | null;
  readonly apiKey?: string | null;
}

export interface EndpointPolicy {
  /** Allow http and private addresses. Only for local development and tests. */
  readonly allowPrivateEndpoints?: boolean;
}

/**
 * Identifies the model, not the key: rotating a key keeps evaluations,
 * switching models or endpoints does not.
 */
export function modelFingerprint(c: Pick<ModelConnection, "provider" | "model" | "endpoint" | "apiVersion">): string {
  const parts = [c.provider, c.model.trim(), (c.endpoint ?? "").trim().replace(/\/+$/, ""), (c.apiVersion ?? "").trim()];
  return createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 16);
}

export function describeConnection(c: Pick<ModelConnection, "provider" | "model">): string {
  switch (c.provider) {
    case "scripted":
      return "Scripted demo model";
    case "openai":
      return `OpenAI · ${c.model}`;
    case "azure-openai":
      return `Azure OpenAI · ${c.model}`;
    case "openai-compatible":
      return `Compatible endpoint · ${c.model}`;
  }
}

function privateAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b] = address.split(".").map(Number) as [number, number];
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a >= 224
    );
  }
  const v6 = address.toLowerCase();
  if (v6.startsWith("::ffff:")) return privateAddress(v6.slice(7));
  return v6 === "::" || v6 === "::1" || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6);
}

/**
 * Check a connection before saving it. Endpoints must be https on a public
 * host: a tenant admin must not be able to point Aegis at its own network.
 */
export function connectionProblems(c: ModelConnection, policy: EndpointPolicy = {}): string[] {
  const problems: string[] = [];
  if (!MODEL_PROVIDERS.includes(c.provider)) return [`unknown provider: ${c.provider}`];
  if (!/^[\w.:/-]{1,100}$/.test(c.model.trim())) problems.push("name the model (letters, digits, dots, dashes)");
  if (c.provider !== "scripted" && !c.apiKey?.trim()) problems.push("paste an API key");
  const needsEndpoint = c.provider === "azure-openai" || c.provider === "openai-compatible";
  if (needsEndpoint) {
    const endpoint = c.endpoint?.trim() ?? "";
    let url: URL | null = null;
    try {
      url = new URL(endpoint);
    } catch {
      problems.push("give the endpoint as a full URL, like https://example.openai.azure.com");
    }
    if (url) {
      const host = url.hostname.replace(/^\[|\]$/g, "");
      if (url.username || url.password) problems.push("put credentials in the key field, not the URL");
      if (!policy.allowPrivateEndpoints) {
        if (url.protocol !== "https:") problems.push("the endpoint must use https");
        if (
          /^(localhost|metadata(\.google\.internal)?)$/i.test(host) ||
          /\.(local|internal|localhost)$/i.test(host) ||
          (isIP(host) !== 0 && privateAddress(host))
        ) {
          problems.push("the endpoint must be a public address");
        }
      } else if (url.protocol !== "https:" && url.protocol !== "http:") {
        problems.push("the endpoint must use http or https");
      }
    }
  }
  if (c.provider === "azure-openai" && !/^\d{4}-\d{2}-\d{2}(-preview)?$/.test(c.apiVersion?.trim() ?? "")) {
    problems.push("give the Azure API version, like 2024-10-21");
  }
  return problems;
}

/** Resolve the endpoint's host now, so a public name cannot quietly point at a private address. */
async function assertPublicEndpoint(endpoint: string, policy: EndpointPolicy): Promise<void> {
  if (policy.allowPrivateEndpoints) return;
  const host = new URL(endpoint).hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true }).catch(() => []);
  if (addresses.length === 0) throw new AgentFailure("provider_error", `could not resolve ${host}`);
  if (addresses.some((a) => privateAddress(a.address))) {
    throw new AgentFailure("endpoint_blocked", "the endpoint resolves to a private address");
  }
}

/** The Agents SDK provider for a tenant's connection. The key lives only as long as the returned object. */
export async function modelProviderFor(c: ModelConnection, policy: EndpointPolicy = {}): Promise<ModelProvider> {
  if (c.provider === "scripted") return { getModel: () => new ScriptedModel() };
  const problems = connectionProblems(c, policy);
  if (problems.length > 0) {
    throw new AgentFailure(c.apiKey ? "bad_request" : "no_key", problems.join("; "));
  }
  const apiKey = c.apiKey!.trim();
  const shared = { apiKey, maxRetries: 0, timeout: 60_000 };
  switch (c.provider) {
    case "openai":
      return new OpenAIProvider({ openAIClient: new OpenAI(shared), useResponses: true });
    case "azure-openai":
      await assertPublicEndpoint(c.endpoint!, policy);
      return new OpenAIProvider({
        openAIClient: new AzureOpenAI({
          ...shared,
          endpoint: c.endpoint!.trim(),
          apiVersion: c.apiVersion!.trim(),
          deployment: c.model.trim(),
        }),
        useResponses: false,
      });
    case "openai-compatible":
      await assertPublicEndpoint(c.endpoint!, policy);
      return new OpenAIProvider({
        openAIClient: new OpenAI({ ...shared, baseURL: c.endpoint!.trim() }),
        useResponses: false,
      });
  }
}
