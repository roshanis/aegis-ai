import { Agent, Runner, setTracingDisabled, type ModelProvider } from "@openai/agents-core";
import type { z } from "zod";
import { classifyFailure } from "./errors";

// The SDK's tracing exports prompts and outputs to OpenAI's trace store.
// Tenant data stays out of it: nothing here turns it back on.
setTracingDisabled(true);

export interface AgentUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface RunOptions {
  /** Default 60 seconds. */
  readonly timeoutMs?: number;
}

/**
 * Most output tokens one call may produce. A ceiling against runaway
 * answers, set well above a normal answer: reasoning models count their
 * reasoning against it, and a cut-off answer fails as invalid_output.
 */
export const OUTPUT_CAP = { intake: 2_000, draft: 4_000 } as const;

/** One model turn with structured output and no tools: agents read what they are given and nothing else. */
export async function runStructured<T extends z.ZodType>(
  provider: ModelProvider,
  spec: { name: string; instructions: string; model: string; outputType: T; maxOutputTokens: number },
  input: string,
  options: RunOptions = {},
): Promise<{ output: z.infer<T>; usage: AgentUsage }> {
  const agent = new Agent({
    name: spec.name,
    instructions: spec.instructions,
    model: spec.model,
    outputType: spec.outputType,
    modelSettings: { maxTokens: spec.maxOutputTokens },
    tools: [],
  });
  const runner = new Runner({ modelProvider: provider, tracingDisabled: true });
  try {
    const result = await runner.run(agent, input, {
      maxTurns: 1,
      signal: AbortSignal.timeout(options.timeoutMs ?? 60_000),
    });
    const usage = result.state.usage;
    return {
      output: result.finalOutput as z.infer<T>,
      usage: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens },
    };
  } catch (error) {
    throw classifyFailure(error);
  }
}
