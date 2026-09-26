import "server-only";
import type { TenantInfo } from "@aegis/core";
import { tenantId, type HumanPrincipal } from "@aegis/domain";
import { redirect } from "next/navigation";
import { cache } from "react";
import { governance } from "./db";
import { readSession } from "./session";

export interface Viewer {
  readonly principal: HumanPrincipal;
  readonly tenant: TenantInfo;
}

/** The signed-in person for this request, or null. Expired sandboxes sign everyone out. */
export const getViewer = cache(async (): Promise<Viewer | null> => {
  const session = await readSession();
  if (!session) return null;
  let tenant: ReturnType<typeof tenantId>;
  try {
    tenant = tenantId(session.t);
  } catch {
    return null;
  }
  const gov = await governance();
  const principal = await gov.principal(tenant, session.u);
  if (!principal) return null;
  const info = await gov.tenant(principal);
  if (info.sandboxExpiresAt && info.sandboxExpiresAt <= new Date()) return null;
  return { principal, tenant: info };
});

export async function requireViewer(): Promise<Viewer> {
  const viewer = await getViewer();
  if (!viewer) redirect("/");
  return viewer;
}
