/**
 * Tenancy primitives. Every record in Aegis belongs to exactly one tenant,
 * and every request runs as a Principal scoped to one tenant. The database
 * enforces the same boundary with row-level security; these types make it
 * impossible to call domain services without choosing a tenant first.
 */

declare const brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [brand]: B };

export type TenantId = Brand<string, "TenantId">;
export type UserId = Brand<string, "UserId">;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function tenantId(value: string): TenantId {
  if (!UUID.test(value)) throw new Error(`invalid tenant id: ${value}`);
  return value as TenantId;
}

export function userId(value: string): UserId {
  if (!UUID.test(value)) throw new Error(`invalid user id: ${value}`);
  return value as UserId;
}

/** How a tenant is hosted. One codebase serves all three. */
export type DeploymentMode = "shared" | "dedicated" | "byoc";

export interface TenantSettings {
  readonly deploymentMode: DeploymentMode;
  /** Data residency region, e.g. "us", "eu". Storage and model calls stay in it. */
  readonly region: string;
  /** Policy packs enabled for this tenant, by pack id. */
  readonly policyPacks: readonly string[];
}
