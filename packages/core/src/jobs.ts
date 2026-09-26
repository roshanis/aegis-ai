import { classifyFailure } from "@aegis/agents";

/**
 * Background work for agents: drafting a domain review and running an
 * evaluation. Each workflow is a short sequence of steps, and every step
 * input and output is an id or a code, so a workflow engine's checkpoints
 * never hold tenant content. The same definitions run on DBOS (durable,
 * for Postgres deployments) and in-process (for PGlite development and
 * tests).
 */

export interface DraftJob {
  readonly kind: "draft";
  readonly tenantId: string;
  readonly reviewId: string;
  /** A new id per request, so each request runs once and a retry never lands on a newer one. */
  readonly requestId: string;
}

export interface EvalJob {
  readonly kind: "eval";
  readonly tenantId: string;
  readonly evalId: string;
}

export type AgentJob = DraftJob | EvalJob;

/** Stable per job: starting the same job twice runs it once. */
export const jobId = (job: AgentJob) => (job.kind === "draft" ? `draft:${job.requestId}` : `eval:${job.evalId}`);

/** Where services hand work after their transaction commits. It must not throw. */
export interface JobQueue {
  enqueue(job: AgentJob): void;
}

export type DraftOutcome = "drafted" | "stale" | "skipped" | "failed";

/** The service calls a workflow makes; each is one step. */
export interface AgentRuntime {
  /** Draft once. Throws an AgentFailure when the model fails. */
  draft(job: DraftJob): Promise<DraftOutcome>;
  abandonDraft(job: DraftJob, code: string): Promise<DraftOutcome>;
  evalCasesLeft(job: EvalJob): Promise<string[]>;
  /** Run and grade one golden case. Throws an AgentFailure only when it is worth retrying. */
  evalCase(job: EvalJob, caseId: string): Promise<string>;
  recordEvalFailure(job: EvalJob, caseId: string, code: string): Promise<string>;
  finishEval(job: EvalJob): Promise<string>;
  /** Jobs recorded as queued or running, across tenants, for recovery after a restart. */
  pendingJobs(): Promise<AgentJob[]>;
}

export interface RetryPolicy {
  readonly attempts: number;
  readonly delayMs: number;
  readonly backoff: number;
}

export const MODEL_RETRY: RetryPolicy = { attempts: 3, delayMs: 2000, backoff: 2 };

export interface Steps {
  run<T>(name: string, fn: () => Promise<T>): Promise<T>;
}

type Attempt<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly code: string };

/**
 * Retry a model call on transient failures (timeouts, rate limits, provider
 * errors), inside one step. A crash mid-retry reruns the whole step, which
 * is what a durable engine would do with its own retries anyway.
 */
export async function attempt<T>(fn: () => Promise<T>, policy: RetryPolicy): Promise<Attempt<T>> {
  let delay = policy.delayMs;
  for (let n = 1; ; n++) {
    try {
      return { ok: true, value: await fn() };
    } catch (error) {
      const failure = classifyFailure(error);
      if (!failure.transient || n >= policy.attempts) return { ok: false, code: failure.code };
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay *= policy.backoff;
    }
  }
}

export async function draftWorkflow(steps: Steps, rt: AgentRuntime, job: DraftJob, retry = MODEL_RETRY): Promise<DraftOutcome> {
  const result = await steps.run("draft", () => attempt(() => rt.draft(job), retry));
  if (result.ok) return result.value;
  return steps.run("abandon", () => rt.abandonDraft(job, result.code));
}

export async function evalWorkflow(steps: Steps, rt: AgentRuntime, job: EvalJob, retry = MODEL_RETRY): Promise<string> {
  const cases = await steps.run("cases", () => rt.evalCasesLeft(job));
  for (const caseId of cases) {
    const result = await steps.run(`case:${caseId}`, () => attempt(() => rt.evalCase(job, caseId), retry));
    if (!result.ok) await steps.run(`case-failed:${caseId}`, () => rt.recordEvalFailure(job, caseId, result.code));
  }
  return steps.run("finish", () => rt.finishEval(job));
}

export interface InlineJobs extends JobQueue {
  /** Resolves once every job enqueued so far, and any they started, has finished. */
  idle(): Promise<void>;
  /** Re-enqueue what the database says is still queued or running. */
  recover(): Promise<number>;
}

/**
 * Runs jobs in this process, right after the request that queued them.
 * Not durable: a crash loses in-flight work until `recover` runs again.
 * For PGlite development and tests; Postgres deployments use DBOS.
 */
export function inlineJobs(
  runtime: () => AgentRuntime,
  options: {
    readonly retry?: RetryPolicy;
    readonly onError?: (error: unknown, job: AgentJob) => void;
    /**
     * Hold jobs until `idle` is called. A draft superseded by a newer
     * request for the same review then costs one quick check, not a model
     * call. For batch work such as seeding a sandbox.
     */
    readonly holdUntilIdle?: boolean;
  } = {},
): InlineJobs {
  const running = new Map<string, Promise<unknown>>();
  const held: AgentJob[] = [];
  const steps: Steps = { run: (_name, fn) => fn() };
  const retry = options.retry ?? MODEL_RETRY;
  const onError = options.onError ?? ((error, job) => console.error(`agent job ${jobId(job)} failed`, error));

  function enqueue(job: AgentJob): void {
    if (options.holdUntilIdle) {
      held.push(job);
      return;
    }
    start(job);
  }

  function start(job: AgentJob): void {
    const id = jobId(job);
    if (running.has(id)) return;
    const work = (async () => {
      await new Promise((resolve) => setImmediate(resolve));
      const rt = runtime();
      return job.kind === "draft" ? draftWorkflow(steps, rt, job, retry) : evalWorkflow(steps, rt, job, retry);
    })()
      .catch((error: unknown) => onError(error, job))
      .finally(() => running.delete(id));
    running.set(id, work);
  }

  return {
    enqueue,
    async idle() {
      while (held.length > 0 || running.size > 0) {
        held.splice(0).forEach(start);
        await Promise.allSettled([...running.values()]);
      }
    },
    async recover() {
      const jobs = await runtime().pendingJobs();
      jobs.forEach(start);
      return jobs.length;
    },
  };
}
