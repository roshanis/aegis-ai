import { randomUUID } from "node:crypto";
import { appendAudit, type Connection } from "@aegis/db";
import {
  can,
  isApproving,
  summarizeTools,
  toolProblems,
  type AssetState,
  type Principal,
  type ToolEffect,
  type ToolInput,
  type ToolSummary,
} from "@aegis/domain";
import { GovernanceError } from "./errors";
import { UUID, actorId, canSee, type Asset, type Kernel } from "./model";

/**
 * The agent and MCP tool inventory: which tools each agent may call, from
 * which server, and what they can do. The owner or an operator keeps it;
 * everyone who can see the agent can read it. A tool added after the
 * agent's approval takes away its clearance until a re-review.
 */

export interface ToolView {
  readonly id: string;
  readonly server: string;
  readonly name: string;
  readonly description: string | null;
  readonly effect: ToolEffect;
  readonly phi: boolean;
  readonly addedBy: string | null;
  readonly addedAt: Date;
  /** Added after the decision that last approved the agent; a re-review has to cover it. */
  readonly sinceApproval: boolean;
}

export interface AgentToolsView {
  readonly tools: readonly ToolView[];
  readonly summary: ToolSummary;
  /** Whether this viewer may add or remove tools. */
  readonly canEdit: boolean;
  /** When the agent was last approved, if ever. */
  readonly approvedAt: Date | null;
}

export interface InventoryRow extends ToolView {
  readonly assetId: string;
  readonly assetName: string;
  readonly assetState: AssetState;
}

interface ToolRow {
  id: string;
  asset_id: string;
  server: string;
  name: string;
  description: string | null;
  effect: ToolEffect;
  phi: boolean;
  added_by_name: string | null;
  added_at: Date;
}

const LIVE_TOOLS = `SELECT t.id, t.asset_id, t.server, t.name, t.description, t.effect, t.phi, u.display_name AS added_by_name, t.added_at
  FROM agent_tools t LEFT JOIN users u ON u.id = t.added_by
  WHERE t.removed_at IS NULL`;

function view(r: ToolRow, approvedAt: Date | null): ToolView {
  const addedAt = new Date(r.added_at);
  return {
    id: r.id,
    server: r.server,
    name: r.name,
    description: r.description,
    effect: r.effect,
    phi: r.phi,
    addedBy: r.added_by_name,
    addedAt,
    sinceApproval: approvedAt !== null && addedAt > approvedAt,
  };
}

export function createTools(k: Kernel) {
  const canEdit = (actor: Principal, asset: Asset) =>
    asset.state !== "retired" &&
    actor.kind === "human" &&
    ((asset.ownerId === actor.userId && can(actor, "asset.register")) || can(actor, "deployment.operate"));

  async function agent(tx: Connection, actor: Principal, assetId: string, lock = false): Promise<Asset> {
    if (!UUID.test(assetId)) throw new GovernanceError("not_found", "no such agent");
    const asset = await k.loadAsset(tx, actor, assetId, lock);
    if (asset.kind !== "agent") throw new GovernanceError("invalid", "only agents have a tool inventory");
    return asset;
  }

  /** When the agent was last approved, cleared now or not; tools added after it need a re-review. */
  async function approvedAt(tx: Connection, assetId: string): Promise<Date | null> {
    const approvals = (await k.loadCases(tx, assetId))
      .filter((c) => c.decidedAt !== null && isApproving(c.kind, c.state))
      .map((c) => c.decidedAt!.getTime());
    return approvals.length > 0 ? new Date(Math.max(...approvals)) : null;
  }

  return {
    agentTools(actor: Principal, assetId: string): Promise<AgentToolsView> {
      return k.inTenant(actor, async (tx) => {
        const asset = await agent(tx, actor, assetId);
        const since = await approvedAt(tx, asset.id);
        const { rows } = await tx.query<ToolRow>(`${LIVE_TOOLS} AND t.asset_id = $1 ORDER BY t.server, t.name`, [asset.id]);
        const tools = rows.map((r) => view(r, since));
        return { tools, summary: summarizeTools(tools), canEdit: canEdit(actor, asset), approvedAt: since };
      });
    },

    /**
     * Add tools to an agent. Tools it already has are skipped, so importing
     * a server's manifest again adds only what is new. Returns how many
     * were added.
     */
    addAgentTools(actor: Principal, assetId: string, input: readonly ToolInput[]): Promise<{ added: number; skipped: number }> {
      return k.inTenant(actor, async (tx) => {
        const asset = await agent(tx, actor, assetId, true);
        if (!canEdit(actor, asset)) {
          throw new GovernanceError("forbidden", asset.state === "retired" ? "a retired agent's tools cannot change" : "only the owner or an operator changes an agent's tools");
        }
        if (input.length === 0) throw new GovernanceError("invalid", "add at least one tool");
        const problems = [...new Set(input.flatMap(toolProblems))];
        if (problems.length > 0) throw new GovernanceError("invalid", problems.join("; "));

        const { rows: live } = await tx.query<{ server: string; name: string }>(
          "SELECT server, name FROM agent_tools WHERE asset_id = $1 AND removed_at IS NULL",
          [asset.id],
        );
        const have = new Set(live.map((t) => `${t.server}\n${t.name}`));
        const at = k.now();
        const added: { server: string; name: string; effect: ToolEffect; phi: boolean }[] = [];
        for (const t of input) {
          const server = t.server.trim();
          const name = t.name.trim();
          const key = `${server}\n${name}`;
          if (have.has(key)) continue;
          have.add(key);
          await tx.query(
            `INSERT INTO agent_tools (id, tenant_id, asset_id, server, name, description, effect, phi, added_by, added_at)
             VALUES ($1, current_tenant_id(), $2, $3, $4, $5, $6, $7, $8, $9)`,
            [randomUUID(), asset.id, server, name, t.description?.trim() || null, t.effect, t.phi, actorId(actor), at.toISOString()],
          );
          added.push({ server, name, effect: t.effect, phi: t.phi });
        }
        if (added.length > 0) {
          const since = await approvedAt(tx, asset.id);
          await appendAudit(tx, {
            actorKind: actor.kind,
            actorId: actorId(actor),
            assetId: asset.id,
            action: "agent.tools_add",
            // Flat strings, as the audit payload holds no nested records: "server/name effect[ phi]".
            payload: { tools: added.map((t) => `${t.server}/${t.name} ${t.effect}${t.phi ? " phi" : ""}`), afterApproval: since !== null },
            at,
          });
        }
        return { added: added.length, skipped: input.length - added.length };
      });
    },

    /** Take a tool away from an agent. Never needs a re-review. */
    removeAgentTool(actor: Principal, assetId: string, toolId: string): Promise<void> {
      return k.inTenant(actor, async (tx) => {
        const asset = await agent(tx, actor, assetId, true);
        if (!canEdit(actor, asset)) throw new GovernanceError("forbidden", "only the owner or an operator changes an agent's tools");
        if (!UUID.test(toolId)) throw new GovernanceError("not_found", "no such tool");
        const at = k.now();
        const { rows } = await tx.query<{ server: string; name: string }>(
          `UPDATE agent_tools SET removed_by = $3, removed_at = $4
           WHERE id = $1 AND asset_id = $2 AND removed_at IS NULL RETURNING server, name`,
          [toolId, asset.id, actorId(actor), at.toISOString()],
        );
        const removed = rows[0];
        if (!removed) throw new GovernanceError("not_found", "no such tool");
        await appendAudit(tx, {
          actorKind: actor.kind,
          actorId: actorId(actor),
          assetId: asset.id,
          action: "agent.tool_remove",
          payload: { server: removed.server, name: removed.name },
          at,
        });
      });
    },

    /** Every live tool on every agent this viewer can see, for the inventory page. */
    toolInventory(actor: Principal): Promise<readonly InventoryRow[]> {
      return k.inTenant(actor, async (tx) => {
        const { rows } = await tx.query<ToolRow & { asset_name: string; asset_state: AssetState; owner_id: string; kind: "agent"; created_at: Date }>(
          `SELECT t.id, t.asset_id, t.server, t.name, t.description, t.effect, t.phi, u.display_name AS added_by_name, t.added_at,
                  a.name AS asset_name, a.state AS asset_state, a.owner_id, a.kind, a.created_at
           FROM agent_tools t JOIN assets a ON a.id = t.asset_id LEFT JOIN users u ON u.id = t.added_by
           WHERE t.removed_at IS NULL AND a.state <> 'retired'
           ORDER BY lower(a.name), a.id, t.server, t.name`,
        );
        const visible = rows.filter((r) =>
          canSee(actor, { id: r.asset_id, kind: r.kind, name: r.asset_name, state: r.asset_state, ownerId: r.owner_id, createdAt: r.created_at }),
        );
        const approvals = new Map<string, Date | null>();
        for (const id of new Set(visible.map((r) => r.asset_id))) approvals.set(id, await approvedAt(tx, id));
        return visible.map((r) => ({
          ...view(r, approvals.get(r.asset_id) ?? null),
          assetId: r.asset_id,
          assetName: r.asset_name,
          assetState: r.asset_state,
        }));
      });
    },
  };
}
