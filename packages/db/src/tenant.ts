import type { TenantId } from "@aegis/domain";
import type { Connection } from "./connection";

/**
 * Run `fn` in a transaction scoped to one tenant. Inside it, queries run as
 * the aegis_app role with app.tenant_id set, so row-level security limits
 * every read and write to that tenant. This is the only way application
 * code should reach tenant data.
 */
export async function withTenant<T>(
  db: Connection,
  tenantId: TenantId,
  fn: (tx: Connection) => Promise<T>,
): Promise<T> {
  await db.exec("BEGIN");
  try {
    await db.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    await db.exec("SET LOCAL ROLE aegis_app");
    const result = await fn(db);
    await db.exec("COMMIT");
    return result;
  } catch (error) {
    await db.exec("ROLLBACK");
    throw error;
  }
}
