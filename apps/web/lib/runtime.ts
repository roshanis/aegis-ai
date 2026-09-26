import { createGovernance, inlineJobs, keyringFromEnv, type Governance, type JobQueue } from "@aegis/core";
import { pooled, serialized, type Database } from "@aegis/db";

/**
 * One runtime per server process: the database, the governance service, and
 * the engine that runs agent jobs. With DATABASE_URL (Postgres) jobs run on
 * DBOS and survive restarts; without it, on a local PGlite directory, they
 * run in-process. Booted from instrumentation.ts at server start, so work
 * left pending by the last process resumes before the first request.
 *
 * Kept on globalThis because Next.js may load this module more than once
 * (instrumentation and each server layer); every copy must share one runtime.
 */
export interface Runtime {
  readonly db: Database;
  readonly gov: Governance;
  /** "dbos" on Postgres, "inline" on PGlite. */
  readonly engine: "dbos" | "inline";
}

const cache = globalThis as unknown as { aegisRuntime?: Promise<Runtime> };

async function openDatabase(): Promise<Database> {
  const url = process.env.DATABASE_URL;
  if (url) {
    const { default: pg } = await import("pg");
    return pooled(new pg.Pool({ connectionString: url }));
  }
  const { PGlite } = await import("@electric-sql/pglite");
  return serialized(new PGlite(process.env.AEGIS_PGLITE_DIR ?? ".data/pglite"));
}

async function boot(): Promise<Runtime> {
  const db = await openDatabase();
  let queue: JobQueue | null = null;
  const gov = createGovernance(db, {
    secrets: keyringFromEnv(),
    jobs: { enqueue: (job) => queue?.enqueue(job) },
    endpointPolicy: { allowPrivateEndpoints: process.env.AEGIS_ALLOW_PRIVATE_MODEL_ENDPOINTS === "1" },
  });
  const url = process.env.DATABASE_URL;
  if (url) {
    const { launchDbosJobs } = await import("@aegis/workflows");
    const jobs = await launchDbosJobs(() => gov.agentRuntime, { databaseUrl: url });
    queue = jobs;
    await jobs.recover();
    return { db, gov, engine: "dbos" };
  }
  const jobs = inlineJobs(() => gov.agentRuntime);
  queue = jobs;
  await jobs.recover();
  return { db, gov, engine: "inline" };
}

export function runtime(): Promise<Runtime> {
  cache.aegisRuntime ??= boot().catch((error: unknown) => {
    cache.aegisRuntime = undefined;
    throw error;
  });
  return cache.aegisRuntime;
}
