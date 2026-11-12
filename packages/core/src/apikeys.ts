import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { appendAudit, withTenant, type Database } from "@aegis/db";
import { can, tenantId, type Principal, type TenantId } from "@aegis/domain";
import { GovernanceError } from "./errors";
import { UUID, actorId, type Kernel } from "./model";

/**
 * API keys for a tenant's own tools: a CI pipeline posting a fairness test
 * run, a scanner posting its report. A key reads
 * `aek.<tenant>.<key id>.<secret>`; Aegis keeps only the secret's hash and
 * shows the key once. A key acts for the admin who made it, only while
 * they are still an active admin, and only for its scopes.
 */

export const API_SCOPES = ["evidence:write"] as const;

/** Calls per key: enough for a busy pipeline, not for a flood. */
export const API_KEY_RATE = { limit: 120, windowMs: 60_000 } as const;
export type ApiScope = (typeof API_SCOPES)[number];

export interface ApiKeyView {
  readonly id: string;
  readonly name: string;
  readonly scopes: readonly ApiScope[];
  readonly createdBy: string | null;
  readonly createdAt: Date;
  readonly lastUsedAt: Date | null;
  readonly revokedAt: Date | null;
}

const hex = (uuid: string) => uuid.replaceAll("-", "");
const uuid = (h: string) => `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const KEY = /^aek\.([0-9a-f]{32})\.([0-9a-f]{32})\.([A-Za-z0-9_-]{43})$/;

export function parseApiKey(token: string): { tenant: string; keyId: string; secret: string } | null {
  const m = KEY.exec(token.trim());
  if (!m) return null;
  const [tenant, keyId] = [uuid(m[1]!), uuid(m[2]!)];
  return UUID.test(tenant) && UUID.test(keyId) ? { tenant, keyId, secret: m[3]! } : null;
}

function requireAdmin(actor: Principal): void {
  if (!can(actor, "tenant.manage")) throw new GovernanceError("forbidden", "only an admin manages API keys");
}

/**
 * Who a key acts for, if it is genuine, live and holds the scope. Marks it
 * used. Says nothing about why a key fails, so a caller cannot probe.
 */
export async function authenticateApiKey(
  db: Database,
  token: string,
  scope: ApiScope,
  at: Date = new Date(),
): Promise<{ tenant: TenantId; keyId: string; userId: string } | null> {
  const parsed = parseApiKey(token);
  if (!parsed) return null;
  const tenant = tenantId(parsed.tenant);
  return db.run((conn) =>
    withTenant(conn, tenant, async (tx) => {
      const { rows } = await tx.query<{ secret_sha256: string; scopes: string[]; created_by: string }>(
        "SELECT secret_sha256, scopes, created_by FROM api_keys WHERE id = $1 AND revoked_at IS NULL",
        [parsed.keyId],
      );
      const row = rows[0];
      const presented = Buffer.from(sha256(parsed.secret), "hex");
      const stored = Buffer.from(row?.secret_sha256 ?? "0".repeat(64), "hex");
      if (!timingSafeEqual(presented, stored) || !row || !row.scopes.includes(scope)) return null;
      await tx.query("UPDATE api_keys SET last_used_at = $2 WHERE id = $1", [parsed.keyId, at.toISOString()]);
      return { tenant, keyId: parsed.keyId, userId: row.created_by };
    }),
  ).catch(() => null);
}

export function createApiKeys(k: Kernel) {
  return {
    /** Every key in the tenant, live and revoked, newest first. Admins only. */
    apiKeys(actor: Principal): Promise<readonly ApiKeyView[]> {
      return k.inTenant(actor, async (tx) => {
        requireAdmin(actor);
        const { rows } = await tx.query<{
          id: string;
          name: string;
          scopes: ApiScope[];
          created_by_name: string | null;
          created_at: Date;
          last_used_at: Date | null;
          revoked_at: Date | null;
        }>(
          `SELECT k.id, k.name, k.scopes, u.display_name AS created_by_name, k.created_at, k.last_used_at, k.revoked_at
           FROM api_keys k LEFT JOIN users u ON u.id = k.created_by
           ORDER BY k.revoked_at IS NOT NULL, k.created_at DESC, k.id`,
        );
        return rows.map((r) => ({
          id: r.id,
          name: r.name,
          scopes: r.scopes,
          createdBy: r.created_by_name,
          createdAt: new Date(r.created_at),
          lastUsedAt: r.last_used_at ? new Date(r.last_used_at) : null,
          revokedAt: r.revoked_at ? new Date(r.revoked_at) : null,
        }));
      });
    },

    /** Make a key. The returned `key` is the only time anyone sees it. */
    createApiKey(actor: Principal, input: { readonly name: string; readonly scopes?: readonly ApiScope[] }): Promise<{ id: string; key: string }> {
      return k.inTenant(actor, async (tx) => {
        requireAdmin(actor);
        if (actor.kind !== "human") throw new GovernanceError("forbidden", "only a person makes API keys");
        const name = input.name.trim();
        if (!name || name.length > 80) throw new GovernanceError("invalid", "name the key, in under 80 characters, after the tool that uses it");
        const scopes = [...new Set(input.scopes ?? ["evidence:write"])];
        if (scopes.length === 0 || scopes.some((s) => !(API_SCOPES as readonly string[]).includes(s))) throw new GovernanceError("invalid", "unknown scope");
        const id = randomUUID();
        const secret = randomBytes(32).toString("base64url");
        const at = k.now();
        await tx.query(
          `INSERT INTO api_keys (id, tenant_id, name, secret_sha256, scopes, created_by, created_at)
           VALUES ($1, current_tenant_id(), $2, $3, $4, $5, $6)`,
          [id, name, sha256(secret), scopes, actor.userId, at.toISOString()],
        );
        await appendAudit(tx, { actorKind: actor.kind, actorId: actorId(actor), action: "api_key.create", payload: { keyId: id, scopes }, at });
        return { id, key: `aek.${hex(actor.tenantId)}.${hex(id)}.${secret}` };
      });
    },

    revokeApiKey(actor: Principal, keyId: string): Promise<void> {
      return k.inTenant(actor, async (tx) => {
        requireAdmin(actor);
        if (!UUID.test(keyId)) throw new GovernanceError("not_found", "no such key");
        const at = k.now();
        const { rows } = await tx.query(
          "UPDATE api_keys SET revoked_by = $2, revoked_at = $3 WHERE id = $1 AND revoked_at IS NULL RETURNING id",
          [keyId, actorId(actor), at.toISOString()],
        );
        if (rows.length === 0) throw new GovernanceError("not_found", "no such live key");
        await appendAudit(tx, { actorKind: actor.kind, actorId: actorId(actor), action: "api_key.revoke", payload: { keyId }, at });
      });
    },
  };
}
