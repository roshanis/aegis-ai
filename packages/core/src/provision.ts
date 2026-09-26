import { randomUUID } from "node:crypto";
import { appendAudit, type Connection } from "@aegis/db";
import { tenantId, userId, type DeploymentMode, type TenantId, type UserId } from "@aegis/domain";
import type { PolicyPack } from "@aegis/frameworks";

export interface ProvisionInput {
  readonly tenant: {
    readonly id: string;
    readonly slug: string;
    readonly name: string;
    readonly deploymentMode?: DeploymentMode;
    readonly region?: string;
    /** Makes this a sandbox, purged after this time. */
    readonly sandboxExpiresAt?: Date;
  };
  readonly admin: { readonly email: string; readonly displayName: string; readonly title?: string };
  readonly packs: readonly PolicyPack[];
}

/**
 * Create a tenant with its first admin and its enabled policy packs, in one
 * transaction. Runs on the platform connection (the migration owner, which
 * bypasses row-level security), never as aegis_app: creating a tenant is
 * deliberately impossible from inside one.
 */
export async function provisionTenant(
  platform: Connection,
  input: ProvisionInput,
  at: Date = new Date(),
): Promise<{ tenantId: TenantId; adminId: UserId }> {
  const id = tenantId(input.tenant.id);
  const adminId = userId(randomUUID());
  await platform.exec("BEGIN");
  try {
    await platform.query(
      `INSERT INTO tenants (id, slug, name, deployment_mode, region, sandbox_expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        id,
        input.tenant.slug,
        input.tenant.name,
        input.tenant.deploymentMode ?? "shared",
        input.tenant.region ?? "us",
        input.tenant.sandboxExpiresAt?.toISOString() ?? null,
      ],
    );
    // appendAudit writes to current_tenant_id().
    await platform.query("SELECT set_config('app.tenant_id', $1, true)", [id]);
    await platform.query(
      "INSERT INTO users (id, tenant_id, email, display_name, title, roles) VALUES ($1, $2, $3, $4, $5, '{admin}')",
      [adminId, id, input.admin.email, input.admin.displayName, input.admin.title ?? null],
    );
    for (const pack of input.packs) {
      await platform.query("INSERT INTO policy_packs (tenant_id, pack_id, version, content) VALUES ($1, $2, $3, $4)", [
        id,
        pack.id,
        pack.version,
        JSON.stringify(pack),
      ]);
    }
    await appendAudit(platform, {
      actorKind: "system",
      actorId: "system:provisioning",
      action: "tenant.provision",
      payload: { adminId, packs: input.packs.map((p) => `${p.id}@${p.version}`) },
      at,
    });
    await platform.exec("COMMIT");
  } catch (error) {
    await platform.exec("ROLLBACK");
    throw error;
  }
  return { tenantId: id, adminId };
}

/**
 * Delete every row a tenant owns, audit log included, in one transaction.
 * Runs on the platform connection; the audit log accepts deletes only for
 * the tenant named in app.purge_tenant.
 */
export async function purgeTenant(platform: Connection, tenant: TenantId): Promise<void> {
  await platform.exec("BEGIN");
  try {
    await platform.query("SELECT set_config('app.purge_tenant', $1, true), set_config('app.tenant_id', $1, true)", [
      tenant,
    ]);
    const tables = [
      "audit_events",
      "agent_runs",
      "agent_budgets",
      "agent_settings",
      "agent_evals",
      "model_connections",
      "tenant_keys",
      "evidence",
      "control_exceptions",
      "conditions",
      "domain_reviews",
      "notes",
      "cases",
      "assets",
      "policy_packs",
      "users",
      "tenants",
    ];
    for (const table of tables) {
      const column = table === "tenants" ? "id" : "tenant_id";
      await platform.query(`DELETE FROM ${table} WHERE ${column} = $1`, [tenant]);
    }
    await platform.exec("COMMIT");
  } catch (error) {
    await platform.exec("ROLLBACK");
    throw error;
  }
}
