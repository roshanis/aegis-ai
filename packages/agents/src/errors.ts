/**
 * Why an agent run did not produce something usable. Codes land in
 * agent_runs and evaluation reports; they never carry model output.
 */
export const AGENT_FAILURES = [
  "timeout",
  "rate_limited",
  "provider_error",
  "auth_failed",
  "bad_request",
  "endpoint_blocked",
  "no_key",
  "invalid_output",
  "decision_language",
  "unknown_control",
] as const;
export type AgentFailureCode = (typeof AGENT_FAILURES)[number];

/** Failures worth retrying: the same request may well succeed later. */
const TRANSIENT: ReadonlySet<AgentFailureCode> = new Set(["timeout", "rate_limited", "provider_error"]);

export class AgentFailure extends Error {
  constructor(
    readonly code: AgentFailureCode,
    message: string,
  ) {
    super(message);
    this.name = "AgentFailure";
  }

  get transient(): boolean {
    return TRANSIENT.has(this.code);
  }
}

/** Map anything a model call can throw onto a failure code. */
export function classifyFailure(error: unknown): AgentFailure {
  if (error instanceof AgentFailure) return error;
  const e = error as { name?: string; status?: number; code?: string; message?: string } | null;
  const message = e?.message ?? String(error);
  if (e?.name === "TimeoutError" || e?.name === "AbortError" || /aborted|timed? ?out/i.test(message)) {
    return new AgentFailure("timeout", "the model did not answer in time");
  }
  const status = typeof e?.status === "number" ? e.status : undefined;
  if (status === 429) return new AgentFailure("rate_limited", "the model provider is rate limiting requests");
  if (status === 401 || status === 403) return new AgentFailure("auth_failed", "the model provider rejected the key");
  if (status !== undefined && status >= 500) return new AgentFailure("provider_error", `the model provider failed (${status})`);
  if (status !== undefined && status >= 400) return new AgentFailure("bad_request", `the model provider refused the request (${status})`);
  if (e?.name === "ModelBehaviorError" || /parse|schema|json/i.test(message)) {
    return new AgentFailure("invalid_output", "the model's answer did not match the expected shape");
  }
  if (e?.code === "ECONNREFUSED" || e?.code === "ENOTFOUND" || /fetch failed|ECONN|socket/i.test(message)) {
    return new AgentFailure("provider_error", "could not reach the model provider");
  }
  return new AgentFailure("provider_error", "the model call failed");
}
