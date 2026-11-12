import { PGlite } from "@electric-sql/pglite";
import { serialized, verifyAuditChain, withTenant } from "@aegis/db";
import { migrate } from "@aegis/db/migrate";
import { parseMcpToolList, userId, type HumanPrincipal, type Role } from "@aegis/domain";
import { healthcareAiPack } from "@aegis/frameworks";
import { beforeAll, describe, expect, it } from "vitest";
import { createGovernance, type Governance } from "./governance";
import { provisionTenant } from "./provision";

let db: PGlite;
let gov: Governance;
let clock = Date.UTC(2026, 10, 12, 9);
let admin: HumanPrincipal;
let owner: HumanPrincipal;
let other: HumanPrincipal;
let reviewer: HumanPrincipal;

const NO = Object.fromEntries(healthcareAiPack.questions.map((q) => [q.field, false]));

const MANIFEST = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  result: {
    tools: [
      { name: "get_claim", description: "Read one claim", annotations: { readOnlyHint: true } },
      { name: "set_claim_status", description: "Pend or release a claim", annotations: { readOnlyHint: false, openWorldHint: false } },
      { name: "send_member_letter", description: "Mail a letter to a member" },
    ],
  },
});

beforeAll(async () => {
  db = new PGlite();
  await migrate(db);
  gov = createGovernance(serialized(db), { now: () => new Date((clock += 60_000)) });
  const { tenantId, adminId } = await provisionTenant(db, {
    tenant: { id: "00000000-0000-4000-8000-0000000000e1", slug: "harbor", name: "Harbor Health" },
    admin: { email: "admin@harbor.test", displayName: "Ada Admin" },
    packs: [healthcareAiPack],
  });
  admin = { kind: "human", tenantId, userId: adminId, displayName: "Ada Admin", roles: ["admin"], reviewDomains: [] };
  const add = async (name: string, roles: Role[], reviewDomains: string[] = []): Promise<HumanPrincipal> => ({
    kind: "human",
    tenantId,
    userId: userId(await gov.addUser(admin, { email: `${name.split(" ")[0]!.toLowerCase()}@harbor.test`, displayName: name, roles, reviewDomains })),
    displayName: name,
    roles,
    reviewDomains,
  });
  owner = await add("Owen Owner", ["requester"]);
  other = await add("Rita Requester", ["requester"]);
  reviewer = await add("Sam Security", ["reviewer"], ["security"]);
}, 60_000);

/** A low-risk agent, approved in the fast lane, so it is cleared from the start. */
async function fastLaned(name: string) {
  const asset = await gov.registerAsset(owner, { kind: "agent", name });
  const draft = await gov.openCase(owner, { assetId: asset.id });
  const { case: submitted } = await gov.submitCase(owner, draft.id, NO);
  expect(submitted.state).toBe("fast_lane_approved");
  return asset.id;
}

describe("MCP manifests", () => {
  it("reads tools/list results, taking MCP's cautious defaults when a tool says nothing", () => {
    const { tools, problems } = parseMcpToolList(MANIFEST, "claims-core");
    expect(problems).toEqual([]);
    expect(tools.map((t) => [t.name, t.effect, t.phi])).toEqual([
      ["get_claim", "read", false],
      ["set_claim_status", "write", false],
      ["send_member_letter", "external", false],
    ]);
    expect(parseMcpToolList('[{"name":"a"},{"name":"a"},{}]', "s")).toEqual({
      tools: [{ server: "s", name: "a", effect: "external", phi: false, description: null }],
      problems: ["tool 3 has no name"],
    });
    expect(parseMcpToolList("not json", "s").problems[0]).toMatch(/not JSON/);
    expect(parseMcpToolList('{"result":{}}', "s").problems[0]).toMatch(/no tools array/);
  });
});

describe("agent tool inventory", () => {
  it("keeps an agent cleared while its tools stand, and takes clearance away when a tool is added after approval", async () => {
    const assetId = await fastLaned("Claims status agent");
    const { tools } = parseMcpToolList(MANIFEST, "claims-core");
    // Tools added before the fast-lane decision would be covered by it; here the decision came first.
    expect((await gov.getAsset(owner, assetId)).clearance.cleared).toBe(true);

    const first = await gov.addAgentTools(owner, assetId, tools.map((t) => (t.name === "get_claim" ? { ...t, phi: true } : t)));
    expect(first).toEqual({ added: 3, skipped: 0 });
    const blocked = await gov.getAsset(owner, assetId);
    expect(blocked.clearance).toMatchObject({ cleared: false });
    expect(blocked.clearance.cleared ? "" : blocked.clearance.reason).toMatch(
      /^3 tools were added after its approval and need a re-review: claims-core\/get_claim, claims-core\/send_member_letter, claims-core\/set_claim_status$/,
    );
    await expect(gov.actOnAsset(admin, assetId, "activate")).rejects.toThrow(/re-review/);

    const view = await gov.agentTools(reviewer, assetId);
    expect(view.canEdit).toBe(false);
    expect(view.summary).toEqual({ tools: 3, servers: 1, writes: 1, external: 1, phi: 1 });
    expect(view.tools.every((t) => t.sinceApproval)).toBe(true);

    // Importing the same manifest again adds nothing.
    expect(await gov.addAgentTools(owner, assetId, tools)).toEqual({ added: 0, skipped: 3 });

    // Removing the new tools gives clearance back; removal never needs a re-review.
    for (const t of view.tools) await gov.removeAgentTool(owner, assetId, t.id);
    expect((await gov.getAsset(owner, assetId)).clearance.cleared).toBe(true);
    expect((await gov.agentTools(owner, assetId)).tools).toEqual([]);

    // A change review that approves covers the tools added before it.
    await gov.addAgentTools(owner, assetId, tools.slice(0, 1));
    const change = await gov.openCase(owner, { assetId, trigger: "change" });
    await gov.submitCase(owner, change.id, NO);
    const after = await gov.getAsset(owner, assetId);
    expect(after.clearance.cleared).toBe(true);
    expect((await gov.agentTools(owner, assetId)).tools.map((t) => t.sinceApproval)).toEqual([false]);

    const events = await withTenant(db, admin.tenantId, (tx) =>
      tx.query<{ action: string; payload: Record<string, unknown> }>(
        "SELECT action, payload FROM audit_events WHERE asset_id = $1 AND action LIKE 'agent.%' ORDER BY id",
        [assetId],
      ),
    );
    expect(events.rows.map((e) => e.action)).toEqual([
      "agent.tools_add",
      "agent.tool_remove",
      "agent.tool_remove",
      "agent.tool_remove",
      "agent.tools_add",
    ]);
    expect(events.rows[0]!.payload).toEqual({
      tools: ["claims-core/get_claim read phi", "claims-core/set_claim_status write", "claims-core/send_member_letter external"],
      afterApproval: true,
    });
    expect(await withTenant(db, admin.tenantId, verifyAuditChain)).toBeNull();
  });

  it("lets only the owner or an operator change the tools, only on agents, and not once retired", async () => {
    const assetId = await fastLaned("Provider directory agent");
    const tool = { server: "directory", name: "find_provider", effect: "read" as const, phi: false };
    await expect(gov.addAgentTools(other, assetId, [tool])).rejects.toMatchObject({ code: "not_found" });
    await expect(gov.addAgentTools(reviewer, assetId, [tool])).rejects.toMatchObject({ code: "forbidden" });
    await expect(gov.addAgentTools(owner, assetId, [])).rejects.toMatchObject({ code: "invalid" });
    await expect(gov.addAgentTools(owner, assetId, [{ ...tool, name: "drop table; --" }])).rejects.toMatchObject({ code: "invalid" });
    await expect(gov.addAgentTools(owner, assetId, [{ ...tool, effect: "delete" as never }])).rejects.toMatchObject({ code: "invalid" });
    expect(await gov.addAgentTools(admin, assetId, [tool])).toEqual({ added: 1, skipped: 0 });

    const system = await gov.registerAsset(owner, { kind: "ai_system", name: "Not an agent" });
    await expect(gov.agentTools(owner, system.id)).rejects.toMatchObject({ code: "invalid" });

    await gov.actOnAsset(admin, assetId, "retire", "Replaced by the claims status agent.");
    await expect(gov.addAgentTools(admin, assetId, [{ ...tool, name: "other" }])).rejects.toMatchObject({ code: "forbidden" });
    expect((await gov.agentTools(owner, assetId)).canEdit).toBe(false);
  });

  it("lists every live tool on agents the viewer can see, and never edits or deletes a row", async () => {
    const rows = await gov.toolInventory(reviewer);
    expect(rows.map((r) => `${r.assetName}: ${r.server}/${r.name}`)).toEqual(["Claims status agent: claims-core/get_claim"]);
    expect(await gov.toolInventory(other)).toEqual([]);
    await expect(withTenant(db, admin.tenantId, (tx) => tx.exec("UPDATE agent_tools SET name = 'x'"))).rejects.toThrow(/permission denied/);
    await expect(withTenant(db, admin.tenantId, (tx) => tx.exec("DELETE FROM agent_tools"))).rejects.toThrow(/permission denied/);
  });
});
