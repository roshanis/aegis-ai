import { randomBytes } from "node:crypto";
import { modelProviderFor, type ModelConnection } from "@aegis/agents";
import { createGovernance, keyring, provisionTenant, type Governance } from "@aegis/core";
import { pooled, type Connection } from "@aegis/db";
import { migrate } from "@aegis/db/migrate";
import { userId, type HumanPrincipal, type Role, type TenantId } from "@aegis/domain";
import { healthcareAiPack } from "@aegis/frameworks";
import { DBOS } from "@dbos-inc/dbos-sdk";
import type { Model, ModelProvider } from "@openai/agents-core";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchDbosJobs, type DbosJobs } from "./index";

/**
 * Runs against a real Postgres: DBOS needs one. Set AEGIS_TEST_DATABASE_URL
 * to a connection that may create databases; CI sets AEGIS_REQUIRE_POSTGRES
 * so these can never be skipped there.
 */
const adminUrl = process.env.AEGIS_TEST_DATABASE_URL;
if (!adminUrl && process.env.AEGIS_REQUIRE_POSTGRES === "1") {
  throw new Error("AEGIS_TEST_DATABASE_URL is required when AEGIS_REQUIRE_POSTGRES=1");
}

const MEDIUM = { phi: false, memberFacing: true, careCoverageInfluence: false, humanInLoop: true, vendorHosted: false, individualImpact: false };
const RETRY = { attempts: 2, delayMs: 10, backoff: 1 };

describe.skipIf(!adminUrl)("durable agent jobs on DBOS", () => {
  const name = `aegis_wf_${Date.now()}_${randomBytes(3).toString("hex")}`;
  let url: string;
  let pool: pg.Pool;
  let gov: Governance;
  let jobs: DbosJobs;
  let tenant: TenantId;
  let admin: HumanPrincipal;
  let requester: HumanPrincipal;
  let reviewer: HumanPrincipal;
  let behaviour: (c: ModelConnection) => ModelProvider | Promise<ModelProvider> = () =>
    modelProviderFor({ provider: "scripted", model: "scripted" });

  const launch = () =>
    launchDbosJobs(() => gov.agentRuntime, { databaseUrl: url, appName: "aegis-test", retry: RETRY, sweepEveryMs: 0, logLevel: "error" });
  const sql = <T extends pg.QueryResultRow>(text: string, params: unknown[] = []) => pool.query<T>(text, params).then((r) => r.rows);
  async function until(check: () => Promise<boolean>, timeoutMs = 20_000) {
    const deadline = Date.now() + timeoutMs;
    while (!(await check())) {
      if (Date.now() > deadline) throw new Error("timed out waiting");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  beforeAll(async () => {
    const admin_ = new pg.Client({ connectionString: adminUrl });
    await admin_.connect();
    await admin_.query(`CREATE DATABASE ${name}`);
    await admin_.end();
    const target = new URL(adminUrl!);
    target.pathname = `/${name}`;
    url = target.toString();

    pool = new pg.Pool({ connectionString: url, max: 8 });
    const client = await pool.connect();
    const conn: Connection = { query: (t, p) => client.query(t, p) as never, exec: (t) => client.query(t) };
    await migrate(conn);
    const provisioned = await provisionTenant(conn, {
      tenant: { id: "00000000-0000-4000-8000-0000000000f0", slug: "payer-f", name: "Payer F" },
      admin: { email: "admin@payer-f.test", displayName: "Ada Admin" },
      packs: [healthcareAiPack],
    });
    client.release();

    gov = createGovernance(pooled(pool), {
      secrets: keyring(randomBytes(32)),
      models: (c) => behaviour(c),
      jobs: { enqueue: (job) => jobs.enqueue(job) },
    });
    jobs = await launch();
    tenant = provisioned.tenantId;
    const person = (id: string, displayName: string, roles: Role[], reviewDomains: string[] = []): HumanPrincipal => ({
      kind: "human",
      tenantId: tenant,
      userId: userId(id),
      displayName,
      roles,
      reviewDomains,
    });
    admin = person(provisioned.adminId, "Ada Admin", ["admin"]);
    const add = async (displayName: string, roles: Role[], domains: string[] = []) =>
      person(
        await gov.addUser(admin, { email: `${displayName.split(" ")[0]!.toLowerCase()}@payer-f.test`, displayName, roles, reviewDomains: domains }),
        displayName,
        roles,
        domains,
      );
    requester = await add("Riley Requester", ["requester"]);
    reviewer = await add("Rowan Reviewer", ["reviewer"], Object.keys(healthcareAiPack.domains));
  }, 60_000);

  afterAll(async () => {
    await jobs?.shutdown();
    await pool?.end();
    const admin_ = new pg.Client({ connectionString: adminUrl });
    await admin_.connect();
    await admin_.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin_.end();
  }, 60_000);

  it("evaluates the agents and drafts reviews as durable workflows", async () => {
    await gov.connectModel(admin, { provider: "scripted", model: "scripted" });
    for (const agent of ["intake", "review-drafter"] as const) {
      const evalId = await gov.startEval(admin, agent);
      expect(await jobs.result({ kind: "eval", tenantId: tenant, evalId })).toBe("passed");
      await gov.setAgentEnabled(admin, agent, true);
    }

    const asset = await gov.registerAsset(requester, { kind: "ai_system", name: "Member letters drafter" });
    const draft = await gov.openCase(requester, { assetId: asset.id });
    await gov.submitCase(requester, draft.id, MEDIUM);
    const queued = await sql<{ id: string; draft_request_id: string }>(
      "SELECT id, draft_request_id FROM domain_reviews WHERE case_id = $1 AND draft_status = 'queued'",
      [draft.id],
    );
    expect(queued.length).toBe(5);
    for (const r of queued) {
      expect(await jobs.result({ kind: "draft", tenantId: tenant, reviewId: r.id, requestId: r.draft_request_id })).toBe("drafted");
    }
    const view = await gov.getAsset(reviewer, asset.id);
    expect(view.assurance.reviews.every((r) => r.status === "drafted" && r.draft.content !== null)).toBe(true);
    expect((await DBOS.listWorkflows({ workflowName: "aegis.draftReview" })).every((w) => w.status === "SUCCESS")).toBe(true);

    // DBOS's checkpoints hold ids and codes: no system name, no draft text.
    expect(await sql("SELECT 1 FROM dbos.operation_outputs WHERE output LIKE '%drafted%'")).not.toEqual([]);
    const leaked = await sql(
      `SELECT 1 FROM dbos.operation_outputs WHERE output LIKE '%Member letters%' OR output LIKE '%review of%'
       UNION ALL SELECT 1 FROM dbos.workflow_status WHERE inputs LIKE '%Member letters%'`,
    );
    expect(leaked).toEqual([]);
  }, 60_000);

  it("runs a job once, however many times it is started", async () => {
    const [review] = await sql<{ id: string; draft_request_id: string }>(
      "SELECT id, draft_request_id FROM domain_reviews WHERE draft_status = 'ready' LIMIT 1",
    );
    const job = { kind: "draft" as const, tenantId: tenant, reviewId: review!.id, requestId: review!.draft_request_id };
    jobs.enqueue(job);
    jobs.enqueue(job);
    expect(await jobs.result(job)).toBe("drafted");
    expect(await sql("SELECT 1 FROM agent_runs WHERE review_id = $1", [review!.id])).toHaveLength(1);
  }, 60_000);

  it("resumes an evaluation cut off mid-run, without re-running the cases it finished", async () => {
    let generation = 1;
    const calls = { 1: 0, 2: 0 };
    behaviour = async (c) => {
      const inner = await (await modelProviderFor({ provider: "scripted", model: "scripted" })).getModel();
      if (c.model !== "gpt-durable") return { getModel: () => inner };
      const model: Model = {
        async getResponse(request) {
          const gen = generation as 1 | 2;
          calls[gen]++;
          // The first process dies during its fifth model call.
          if (gen === 1 && calls[1] === 5) return new Promise(() => undefined);
          return inner.getResponse(request);
        },
        getStreamedResponse: () => inner.getStreamedResponse({} as never),
      };
      return { getModel: () => model };
    };
    await gov.connectModel(admin, { provider: "openai", model: "gpt-durable", apiKey: "sk-test-durable-0000" });
    const evalId = await gov.startEval(admin, "review-drafter");
    await until(async () => {
      const [row] = await sql<{ done: number }>("SELECT jsonb_array_length(results) AS done FROM agent_evals WHERE id = $1", [evalId]);
      return row!.done === 4 && calls[1] === 5;
    });

    await jobs.shutdown();
    generation = 2;
    jobs = await launch();

    expect(await jobs.result({ kind: "eval", tenantId: tenant, evalId })).toBe("passed");
    expect(calls[2]).toBe(healthcareAiPack.goldenSets!.reviewDrafter.cases.length - 4);
    const [row] = await sql<{ results: { caseId: string }[] }>("SELECT results FROM agent_evals WHERE id = $1", [evalId]);
    expect(new Set(row!.results.map((r) => r.caseId)).size).toBe(healthcareAiPack.goldenSets!.reviewDrafter.cases.length);
    expect(await sql("SELECT 1 FROM agent_runs WHERE eval_id = $1 AND error_code = 'interrupted'", [evalId])).toHaveLength(1);
  }, 90_000);
});
