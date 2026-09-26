import { describe, expect, it } from "vitest";
import { draftWorkflow, type AgentRuntime, type DraftJob, type Steps } from "./jobs";

describe("draft settle time", () => {
  const run = async (job: DraftJob) => {
    const slept: number[] = [];
    const steps: Steps = { run: (_name, fn) => fn(), sleep: async (_name, ms) => void slept.push(ms) };
    const rt = { draft: async () => "drafted" } as unknown as AgentRuntime;
    await draftWorkflow(steps, rt, job, { attempts: 1, delayMs: 1, backoff: 1 }, 20_000);
    return slept;
  };
  const job = { kind: "draft", tenantId: "t", reviewId: "r", requestId: "q" } as const;

  it("waits before a redraft, so a burst of changes costs one model call", async () => {
    expect(await run({ ...job, settle: true })).toEqual([20_000]);
  });

  it("drafts a new review at once", async () => {
    expect(await run(job)).toEqual([]);
  });
});
