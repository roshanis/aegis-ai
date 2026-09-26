import { DBOS } from "@dbos-inc/dbos-sdk";
import {
  DRAFT_SETTLE_MS,
  MODEL_RETRY,
  draftWorkflow,
  evalWorkflow,
  jobId,
  type AgentJob,
  type AgentRuntime,
  type DraftJob,
  type EvalJob,
  type JobQueue,
  type RetryPolicy,
  type Steps,
} from "@aegis/core";

/**
 * Durable agent jobs on DBOS, in the Postgres every deployment already
 * runs. Each workflow step is checkpointed, so after a crash or deploy a
 * draft or an evaluation resumes where it stopped instead of starting over,
 * and a finished model call is never paid for twice. Checkpoints hold only
 * ids and codes (see @aegis/core jobs), so tenant content never lands in
 * DBOS's tables and erasing it never has to touch them.
 */

export const QUEUE = "aegis-agents";

export interface DbosJobsOptions {
  /** Postgres for DBOS's own tables; usually the application database, which gets a `dbos` schema. */
  readonly databaseUrl: string;
  readonly appName?: string;
  /** Model calls running at once in this process. */
  readonly concurrency?: number;
  readonly retry?: RetryPolicy;
  /** Draft settle time in ms; defaults to DRAFT_SETTLE_MS. */
  readonly settleMs?: number;
  readonly logLevel?: string;
  /** How often to sweep for jobs queued but never started, in ms. 0 turns the sweep off. */
  readonly sweepEveryMs?: number;
}

export interface DbosJobs extends JobQueue {
  /** Start every job the database says is queued or running; DBOS runs each workflow id once. */
  recover(): Promise<number>;
  /** Wait for a job's workflow to finish and return its outcome. */
  result(job: AgentJob): Promise<unknown>;
  shutdown(): Promise<void>;
}

const steps: Steps = {
  run: (name, fn) => DBOS.runStep(fn, { name }),
  sleep: (_name, ms) => DBOS.sleep(ms),
};

// DBOS registers workflows once per process, before launch. The runtime they
// call is looked up on every run, so a relaunch can rebind it.
let bound: { runtime: () => AgentRuntime; retry: RetryPolicy; settleMs: number } | null = null;
let workflows: {
  draft: (job: DraftJob) => Promise<unknown>;
  eval: (job: EvalJob) => Promise<unknown>;
} | null = null;

function register() {
  workflows ??= {
    draft: DBOS.registerWorkflow((job: DraftJob) => draftWorkflow(steps, bound!.runtime(), job, bound!.retry, bound!.settleMs), {
      name: "aegis.draftReview",
    }),
    eval: DBOS.registerWorkflow((job: EvalJob) => evalWorkflow(steps, bound!.runtime(), job, bound!.retry), {
      name: "aegis.evaluateAgent",
    }),
  };
  return workflows;
}

export async function launchDbosJobs(runtime: () => AgentRuntime, options: DbosJobsOptions): Promise<DbosJobs> {
  const wf = register();
  bound = { runtime, retry: options.retry ?? MODEL_RETRY, settleMs: options.settleMs ?? DRAFT_SETTLE_MS };
  DBOS.setConfig({
    name: options.appName ?? "aegis",
    systemDatabaseUrl: options.databaseUrl,
    logLevel: options.logLevel ?? "warn",
  });
  await DBOS.launch();
  await DBOS.registerQueue(QUEUE, { workerConcurrency: options.concurrency ?? 4 });

  const started = new Map<string, Promise<unknown>>();
  function start(job: AgentJob): Promise<unknown> {
    const id = jobId(job);
    const handle =
      job.kind === "draft"
        ? DBOS.startWorkflow(wf.draft, { workflowID: id, queueName: QUEUE })(job)
        : DBOS.startWorkflow(wf.eval, { workflowID: id, queueName: QUEUE })(job);
    const pending = handle.then((h) => h.getResult());
    started.set(id, pending);
    pending.catch(() => undefined).finally(() => started.delete(id));
    return handle;
  }

  async function recover(): Promise<number> {
    const jobs = await runtime().pendingJobs();
    await Promise.all(jobs.map((job) => start(job).catch(() => undefined)));
    return jobs.length;
  }

  const sweepEvery = options.sweepEveryMs ?? 5 * 60_000;
  const sweep = sweepEvery > 0 ? setInterval(() => void recover().catch(() => undefined), sweepEvery) : null;
  sweep?.unref();

  return {
    enqueue(job) {
      start(job).catch((error: unknown) => console.error(`could not start agent job ${jobId(job)}`, error));
    },
    recover,
    async result(job) {
      return started.get(jobId(job)) ?? DBOS.retrieveWorkflow(jobId(job)).getResult();
    },
    async shutdown() {
      if (sweep) clearInterval(sweep);
      await DBOS.shutdown();
    },
  };
}
