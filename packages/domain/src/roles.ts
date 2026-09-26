import type { TenantId, UserId } from "./tenancy";

/**
 * Roles and permissions. Ported from Jeeves' authority rules and
 * generalized so tenants can grant several roles to one person while the
 * separation-of-duties checks below still hold.
 */
export const ROLES = [
  "requester",
  "reviewer",
  "approver",
  "admin",
  "auditor",
  "program_office",
] as const;
export type Role = (typeof ROLES)[number];

export type Permission =
  | "asset.register"
  | "case.submit"
  | "case.read_own"
  | "case.read_all"
  | "review.sign"
  | "case.decide"
  | "deployment.operate"
  | "policy.edit"
  | "tenant.manage"
  | "audit.export";

const GRANTS: Record<Role, readonly Permission[]> = {
  requester: ["asset.register", "case.submit", "case.read_own"],
  reviewer: ["case.read_all", "review.sign"],
  approver: ["case.read_all", "case.decide"],
  admin: ["asset.register", "case.read_all", "deployment.operate", "policy.edit", "tenant.manage"],
  auditor: ["case.read_all", "audit.export"],
  program_office: ["case.read_all"],
};

/** A signed-in person acting inside one tenant. */
export interface HumanPrincipal {
  readonly kind: "human";
  readonly tenantId: TenantId;
  readonly userId: UserId;
  readonly displayName: string;
  readonly roles: readonly Role[];
  /** Review domains this person may sign for, e.g. ["privacy", "security"]. */
  readonly reviewDomains: readonly string[];
}

/** Deterministic platform automation (triage, monitors). Never an LLM. */
export interface SystemPrincipal {
  readonly kind: "system";
  readonly tenantId: TenantId;
  readonly job: string;
}

/** An AI agent. It can draft and recommend; it holds no permissions at all. */
export interface AgentPrincipal {
  readonly kind: "agent";
  readonly tenantId: TenantId;
  readonly agent: string;
}

export type Principal = HumanPrincipal | SystemPrincipal | AgentPrincipal;

/**
 * Roles that may never be held together, because one would check the
 * other's work. Tenants can loosen role grants but not these pairs.
 */
const INCOMPATIBLE: readonly (readonly [Role, Role])[] = [
  ["admin", "approver"],
  ["requester", "approver"],
];

export function roleConflicts(roles: readonly Role[]): string[] {
  return INCOMPATIBLE.filter(([a, b]) => roles.includes(a) && roles.includes(b)).map(
    ([a, b]) => `${a} and ${b} cannot be held by the same person`,
  );
}

export function can(principal: Principal, permission: Permission): boolean {
  if (principal.kind !== "human") return false;
  if (roleConflicts(principal.roles).length > 0) return false;
  return principal.roles.some((role) => GRANTS[role].includes(permission));
}

/** Signing a review needs the permission AND the matching domain. */
export function canSignDomain(principal: Principal, domain: string): boolean {
  return (
    principal.kind === "human" &&
    can(principal, "review.sign") &&
    principal.reviewDomains.includes(domain)
  );
}
