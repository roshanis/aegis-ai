"use server";

import { SANDBOX_LIFETIME_MS, createSandbox, purgeExpiredSandboxes, sandboxPersonas } from "@aegis/core";
import { redirect } from "next/navigation";
import { database } from "@/lib/db";
import { clearSession, writeSession } from "@/lib/session";
import { getViewer } from "@/lib/viewer";

/** Give this visitor a private, seeded tenant and sign them in as its requester. */
export async function startSandbox(): Promise<void> {
  const db = await database();
  try {
    await purgeExpiredSandboxes(db);
  } catch (error) {
    // Cleanup must never block a new visitor; the next sandbox retries it.
    console.error("purging expired sandboxes failed", error);
  }
  const { tenantId, personas } = await createSandbox(db);
  const requester = personas.find((p) => p.roles.includes("requester"))!;
  await writeSession(tenantId, requester.userId, new Date(Date.now() + SANDBOX_LIFETIME_MS));
  redirect("/registry");
}

const SAFE_RETURN = /^\/(registry(\/[a-z0-9-]+)*|agents)$/;

/** Act as someone else in the same sandbox. Refused for any tenant that is not a live sandbox. */
export async function switchPersona(formData: FormData): Promise<void> {
  const viewer = await getViewer();
  if (!viewer?.tenant.sandboxExpiresAt) redirect("/");
  const personas = await sandboxPersonas(await database(), viewer.principal.tenantId);
  const target = personas.find((p) => p.userId === formData.get("userId"));
  if (!target) throw new Error("Switching people is only possible inside a sandbox.");
  await writeSession(viewer.principal.tenantId, target.userId, viewer.tenant.sandboxExpiresAt);
  const returnTo = String(formData.get("returnTo") ?? "");
  redirect(SAFE_RETURN.test(returnTo) ? returnTo : "/registry");
}

export async function signOut(): Promise<void> {
  await clearSession();
  redirect("/");
}
