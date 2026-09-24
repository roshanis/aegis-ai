import type { AgentPrincipal, HumanPrincipal, Role, SystemPrincipal } from "./roles";
import { tenantId, userId, type TenantId } from "./tenancy";

export const TENANT_A = tenantId("00000000-0000-4000-8000-00000000000a");

let seq = 0;
export function human(roles: Role[], reviewDomains: string[] = [], tenant: TenantId = TENANT_A): HumanPrincipal {
  seq += 1;
  return {
    kind: "human",
    tenantId: tenant,
    userId: userId(`00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`),
    displayName: roles.join("+"),
    roles,
    reviewDomains,
  };
}

export const system: SystemPrincipal = { kind: "system", tenantId: TENANT_A, job: "triage" };
export const agent: AgentPrincipal = { kind: "agent", tenantId: TENANT_A, agent: "reviewer-drafter" };
