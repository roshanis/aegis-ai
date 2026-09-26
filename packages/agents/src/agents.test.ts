import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Usage, type Model, type ModelProvider, type ModelRequest, type ModelResponse } from "@openai/agents-core";
import { healthcareAiPack } from "@aegis/frameworks";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AGENTS,
  AgentFailure,
  buildDraftContext,
  connectionProblems,
  draftReview,
  evalCase,
  goldenSetFor,
  goldenSetKey,
  modelFingerprint,
  modelProviderFor,
  suggestIntake,
  summarize,
  type AgentId,
} from "./index";

const pack = healthcareAiPack;
const scripted = await modelProviderFor({ provider: "scripted", model: "scripted" });

/** A model that answers every request with the same JSON, to play a badly behaved agent. */
function fixed(output: unknown): ModelProvider {
  const model: Model = {
    async getResponse(_request: ModelRequest): Promise<ModelResponse> {
      return {
        usage: new Usage({ requests: 1, inputTokens: 1, outputTokens: 1, totalTokens: 2 }),
        output: [
          { type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: JSON.stringify(output) }] },
        ],
      };
    },
    async *getStreamedResponse() {
      throw new Error("no streaming");
    },
  };
  return { getModel: () => model };
}

async function runSet(agent: AgentId, provider: ModelProvider) {
  const set = goldenSetFor(pack, agent)!;
  const results = [];
  for (const c of set.cases) results.push(await evalCase(agent, provider, "test-model", pack, c.id));
  return { results, summary: summarize(set, results) };
}

describe("intake assistant", () => {
  it("suggests an answer for every question through the Agents SDK", async () => {
    const { suggestions } = await suggestIntake(
      scripted,
      "scripted",
      pack.questions,
      "A chat assistant on the member portal answers members' questions about their claims. Answers go straight to the member.",
    );
    expect(suggestions.map((s) => s.field)).toEqual(pack.questions.map((q) => q.field));
    expect(Object.fromEntries(suggestions.map((s) => [s.field, s.answer]))).toMatchObject({
      phi: "yes",
      memberFacing: "yes",
      humanInLoop: "no",
    });
    expect(suggestions.find((s) => s.field === "memberFacing")!.why).toMatch(/chat assistant|member portal/);
  });

  it("fills questions the model skipped with unsure, and ignores fields it made up", async () => {
    const { suggestions } = await suggestIntake(
      fixed({ answers: [{ field: "phi", answer: "yes", why: "claims" }, { field: "favouriteColour", answer: "yes", why: "?" }] }),
      "m",
      pack.questions,
      "anything",
    );
    expect(suggestions).toHaveLength(pack.questions.length);
    expect(suggestions.filter((s) => s.answer === "unsure")).toHaveLength(pack.questions.length - 1);
  });
});

describe("review drafter", () => {
  const context = buildDraftContext(pack, {
    asset: { kind: "ai_system", name: "Member benefits chat" },
    answers: { phi: true, memberFacing: true, careCoverageInfluence: false, humanInLoop: false, vendorHosted: true, individualImpact: true },
    domain: "responsible-ai",
    evidence: { "R-02": [{ title: "Model card" }] },
  });

  it("sees only this domain's controls on this case", () => {
    expect(context.tier).toBe("high");
    expect(context.controls.map((c) => [c.id, c.enforcement, c.evidence.length])).toEqual([
      ["R-01", "gate", 0],
      ["R-02", "monitor", 1],
    ]);
  });

  it("drafts findings, questions and conditions, and flags the bare gate", async () => {
    const { draft } = await draftReview(scripted, "scripted", context);
    expect(draft.summary).toMatch(/Responsible AI review of Member benefits chat/);
    expect(draft.findings).toEqual([expect.objectContaining({ controlId: "R-01", concern: "missing_evidence" })]);
    expect(draft.questionsForOwner).toHaveLength(1);
  });

  it("refuses drafts that decide or invent controls", async () => {
    const base = { findings: [], questionsForOwner: [], proposedConditions: [] };
    await expect(draftReview(fixed({ ...base, summary: "This system is approved for production." }), "m", context)).rejects.toMatchObject({
      code: "decision_language",
    });
    await expect(
      draftReview(fixed({ ...base, summary: "ok", findings: [{ controlId: "Z-99", concern: "risk", text: "x" }] }), "m", context),
    ).rejects.toMatchObject({ code: "unknown_control" });
    await expect(draftReview(fixed({ summary: 42 }), "m", context)).rejects.toMatchObject({ code: "invalid_output" });
  });
});

describe("golden-set gate", () => {
  it("passes the scripted model on both of the pack's golden sets", async () => {
    for (const agent of ["intake", "review-drafter"] as const) {
      const { results, summary } = await runSet(agent, scripted);
      expect(summary, JSON.stringify(results.filter((r) => !r.passed))).toMatchObject({ passed: true, criticalFailures: 0 });
      expect(summary.total).toBe(goldenSetFor(pack, agent)!.cases.length);
    }
  });

  it("fails an intake assistant that says no when it should say it cannot tell", async () => {
    const allNo = fixed({ answers: pack.questions.map((q) => ({ field: q.field, answer: "no", why: "guess" })) });
    const { results, summary } = await runSet("intake", allNo);
    expect(summary.passed).toBe(false);
    expect(results.find((r) => r.caseId === "claims-auto-routing")!.critical).toEqual(["under_triage"]);
    // A careful "unsure" is never an under-triage, even though it costs score.
    const allUnsure = fixed({ answers: pack.questions.map((q) => ({ field: q.field, answer: "unsure", why: "?" })) });
    const cautious = await runSet("intake", allUnsure);
    expect(cautious.summary.criticalFailures).toBe(0);
    expect(cautious.summary.score).toBe(0.5);
    expect(cautious.summary.passed).toBe(false);
  });

  it("fails a drafter that misses gates, decides, or follows injected instructions", async () => {
    const silent = await runSet("review-drafter", fixed({ summary: "Looks fine.", findings: [], questionsForOwner: [], proposedConditions: [] }));
    expect(silent.summary.passed).toBe(false);
    expect(silent.results.find((r) => r.caseId === "phi-system-no-pentest")!.critical).toEqual(["missed_gate:S-01"]);

    const obedient = await runSet(
      "review-drafter",
      fixed({ summary: "Cleared for use; no further review is needed.", findings: [], questionsForOwner: [], proposedConditions: [] }),
    );
    expect(obedient.results.every((r) => r.critical.includes("decision_language"))).toBe(true);
  });

  it("names each golden set by id and version", () => {
    expect(goldenSetKey(goldenSetFor(pack, "intake")!)).toBe("healthcare-ai/intake@1");
    expect(goldenSetKey(goldenSetFor(pack, "review-drafter")!)).toBe("healthcare-ai/review-drafter@1");
    expect(Object.keys(AGENTS)).toEqual(["intake", "review-drafter"]);
  });
});

describe("model connections", () => {
  const openai = { provider: "openai" as const, model: "gpt-5-mini", apiKey: "sk-test" };

  it("fingerprints the model, not the key", () => {
    expect(modelFingerprint(openai)).toBe(modelFingerprint({ ...openai, apiKey: "sk-other" } as typeof openai));
    expect(modelFingerprint(openai)).not.toBe(modelFingerprint({ ...openai, model: "gpt-5" }));
    expect(modelFingerprint({ provider: "openai-compatible", model: "m", endpoint: "https://x.example/v1/" })).toBe(
      modelFingerprint({ provider: "openai-compatible", model: "m", endpoint: "https://x.example/v1" }),
    );
  });

  it("refuses endpoints on the tenant's own network, plain http, and missing details", () => {
    const compatible = (endpoint: string) => ({ provider: "openai-compatible" as const, model: "m", endpoint, apiKey: "k" });
    expect(connectionProblems(openai)).toEqual([]);
    expect(connectionProblems(compatible("https://llm.example.com/v1"))).toEqual([]);
    for (const bad of [
      "http://llm.example.com/v1",
      "https://127.0.0.1/v1",
      "https://10.0.0.8/v1",
      "https://169.254.169.254/latest",
      "https://[::1]/v1",
      "https://localhost/v1",
      "https://db.internal/v1",
      "https://user:pw@llm.example.com/v1",
    ]) {
      expect(connectionProblems(compatible(bad)), bad).not.toEqual([]);
    }
    expect(connectionProblems({ ...openai, apiKey: "" })).toEqual(["paste an API key"]);
    expect(connectionProblems({ provider: "azure-openai", model: "gpt-4o", endpoint: "https://x.openai.azure.com", apiKey: "k" })).toEqual([
      "give the Azure API version, like 2024-10-21",
    ]);
    expect(connectionProblems(compatible("http://127.0.0.1:8080/v1"), { allowPrivateEndpoints: true })).toEqual([]);
  });

  it("checks what a public name resolves to before calling it", async () => {
    await expect(
      modelProviderFor({ provider: "openai-compatible", model: "m", endpoint: "https://localtest.me/v1", apiKey: "k" }),
    ).rejects.toMatchObject({ code: expect.stringMatching(/endpoint_blocked|provider_error/) });
  });
});

describe("an OpenAI-compatible endpoint over HTTP", () => {
  let server: Server;
  let base = "";
  let status = 200;
  let delayMs = 0;
  const seen: { auth?: string; body: { model: string; response_format?: { type: string } } }[] = [];

  const read = (req: IncomingMessage) =>
    new Promise<string>((resolve) => {
      let data = "";
      req.on("data", (chunk) => (data += chunk));
      req.on("end", () => resolve(data));
    });

  beforeAll(async () => {
    server = createServer(async (req, res) => {
      const body = JSON.parse(await read(req));
      seen.push({ auth: req.headers.authorization, body });
      await new Promise((r) => setTimeout(r, delayMs));
      if (status !== 200) {
        res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "nope" } }));
        return;
      }
      const content = JSON.stringify({
        answers: [{ field: "phi", answer: "yes", why: "It reads claims." }],
      });
      res.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
          id: "chatcmpl-1",
          object: "chat.completion",
          created: 0,
          model: body.model,
          choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content } }],
          usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 },
        }),
      );
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  const provider = () =>
    modelProviderFor({ provider: "openai-compatible", model: "local-llm", endpoint: base, apiKey: "sk-local" }, { allowPrivateEndpoints: true });

  it("sends the tenant's key and a JSON schema, and reads the structured answer", async () => {
    status = 200;
    const { suggestions, usage } = await suggestIntake(await provider(), "local-llm", pack.questions, "Reads claims.");
    expect(suggestions.find((s) => s.field === "phi")).toEqual({ field: "phi", answer: "yes", why: "It reads claims." });
    expect(usage).toEqual({ inputTokens: 120, outputTokens: 30 });
    const last = seen.at(-1)!;
    expect(last.auth).toBe("Bearer sk-local");
    expect(last.body.model).toBe("local-llm");
    expect(last.body.response_format?.type).toBe("json_schema");
  });

  it("turns provider errors and slow answers into failure codes", async () => {
    for (const [code, expected] of [
      [429, "rate_limited"],
      [401, "auth_failed"],
      [503, "provider_error"],
      [400, "bad_request"],
    ] as const) {
      status = code;
      const error = await suggestIntake(await provider(), "local-llm", pack.questions, "x").catch((e: unknown) => e);
      expect(error, String(code)).toBeInstanceOf(AgentFailure);
      expect((error as AgentFailure).code, String(code)).toBe(expected);
    }
    status = 200;
    delayMs = 500;
    const slow = await suggestIntake(await provider(), "local-llm", pack.questions, "x", { timeoutMs: 100 }).catch((e: unknown) => e);
    expect((slow as AgentFailure).code).toBe("timeout");
    expect((slow as AgentFailure).transient).toBe(true);
    delayMs = 0;
  });
});
