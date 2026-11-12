/**
 * What an agent can reach: the tools it may call, grouped by the MCP server
 * (or other integration) that provides them. The approved tool set is part
 * of what a review approved, so a tool added after approval keeps the agent
 * from being cleared until a re-review covers it. Removing a tool never
 * needs one.
 */

/** read: only looks things up. write: changes data in the system behind it. external: reaches outside it (sends, posts, pays). */
export const TOOL_EFFECTS = ["read", "write", "external"] as const;
export type ToolEffect = (typeof TOOL_EFFECTS)[number];

export interface ToolInput {
  readonly server: string;
  readonly name: string;
  readonly effect: ToolEffect;
  /** True when the tool can see members' health information. */
  readonly phi: boolean;
  readonly description?: string | null;
}

export const TOOL_LIMITS = { server: 120, name: 128, description: 1000, perImport: 200 } as const;

/** A tool or server name: letters, digits and the punctuation MCP names use. */
const NAME = /^[A-Za-z0-9][A-Za-z0-9 _.:/@-]*$/;

/** Problems with one tool as entered, in words for the person entering it. */
export function toolProblems(tool: ToolInput): string[] {
  const problems: string[] = [];
  const server = tool.server.trim();
  const name = tool.name.trim();
  if (!server) problems.push("name the server or integration that provides it");
  else if (server.length > TOOL_LIMITS.server || !NAME.test(server)) problems.push(`"${server.slice(0, 40)}" is not a server name Aegis accepts`);
  if (!name) problems.push("name the tool");
  else if (name.length > TOOL_LIMITS.name || !NAME.test(name)) problems.push(`"${name.slice(0, 40)}" is not a tool name Aegis accepts`);
  if (!TOOL_EFFECTS.includes(tool.effect)) problems.push(`unknown effect "${String(tool.effect)}"`);
  if ((tool.description ?? "").length > TOOL_LIMITS.description) problems.push(`keep ${name || "the"} description under ${TOOL_LIMITS.description} characters`);
  return problems;
}

interface McpAnnotations {
  readonly readOnlyHint?: unknown;
  readonly destructiveHint?: unknown;
  readonly openWorldHint?: unknown;
}

/**
 * The effect MCP tool annotations declare. MCP's defaults are the cautious
 * ones (not read-only, open world), so a tool that says nothing is taken to
 * reach outside its system. Annotations are the server's own claims; the
 * reviewer still decides whether to believe them.
 */
export function effectFromAnnotations(annotations: McpAnnotations | undefined): ToolEffect {
  if (annotations?.readOnlyHint === true) return "read";
  if (annotations?.openWorldHint === false) return "write";
  return "external";
}

/**
 * Reads the result of an MCP `tools/list` call (or just its `tools` array)
 * into tools for one server. Health information cannot be read from a
 * manifest, so `phi` is left for the person to set.
 */
export function parseMcpToolList(json: string, server: string): { tools: ToolInput[]; problems: string[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { tools: [], problems: ["that is not JSON: paste the result of the server's tools/list call"] };
  }
  const root = parsed as { result?: { tools?: unknown }; tools?: unknown } | unknown[];
  const list = Array.isArray(root) ? root : (root as { result?: { tools?: unknown } }).result?.tools ?? (root as { tools?: unknown }).tools;
  if (!Array.isArray(list)) return { tools: [], problems: ["no tools array found: paste the result of the server's tools/list call"] };
  if (list.length > TOOL_LIMITS.perImport) return { tools: [], problems: [`import at most ${TOOL_LIMITS.perImport} tools at a time`] };

  const tools: ToolInput[] = [];
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const [i, raw] of list.entries()) {
    const item = (raw ?? {}) as { name?: unknown; description?: unknown; annotations?: McpAnnotations };
    if (typeof item.name !== "string") {
      problems.push(`tool ${i + 1} has no name`);
      continue;
    }
    const description = typeof item.description === "string" ? item.description.trim().slice(0, TOOL_LIMITS.description) : null;
    const tool: ToolInput = { server: server.trim(), name: item.name.trim(), effect: effectFromAnnotations(item.annotations), phi: false, description };
    const wrong = toolProblems(tool);
    if (wrong.length > 0) problems.push(...wrong);
    else if (!seen.has(tool.name)) {
      seen.add(tool.name);
      tools.push(tool);
    }
  }
  return { tools, problems: [...new Set(problems)] };
}

export interface ToolSummary {
  readonly tools: number;
  readonly servers: number;
  readonly writes: number;
  readonly external: number;
  readonly phi: number;
}

export function summarizeTools(tools: readonly Pick<ToolInput, "server" | "effect" | "phi">[]): ToolSummary {
  return {
    tools: tools.length,
    servers: new Set(tools.map((t) => t.server)).size,
    writes: tools.filter((t) => t.effect === "write").length,
    external: tools.filter((t) => t.effect === "external").length,
    phi: tools.filter((t) => t.phi).length,
  };
}
