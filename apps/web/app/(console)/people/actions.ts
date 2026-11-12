"use server";

import type { Role } from "@aegis/domain";
import { revalidatePath } from "next/cache";
import type { ActionState } from "@/lib/action-state";
import { governance } from "@/lib/db";
import { refusal } from "@/lib/errors";
import { requireViewer } from "@/lib/viewer";

async function attempt(fn: () => Promise<unknown>): Promise<ActionState> {
  try {
    await fn();
  } catch (error) {
    const refused = refusal(error);
    if (refused) return { error: refused.message };
    throw error;
  }
  revalidatePath("/", "layout");
  return { error: null };
}

const text = (form: FormData, key: string) => String(form.get(key) ?? "").trim();
const all = (form: FormData, key: string) => form.getAll(key).map(String);

export async function addPerson(_: ActionState, form: FormData): Promise<ActionState> {
  const { principal } = await requireViewer();
  const gov = await governance();
  return attempt(() =>
    gov.addUser(principal, {
      email: text(form, "email"),
      displayName: text(form, "displayName"),
      ...(text(form, "title") ? { title: text(form, "title") } : {}),
      roles: all(form, "roles") as Role[],
      reviewDomains: all(form, "reviewDomains"),
    }),
  );
}

export async function updatePerson(_: ActionState, form: FormData): Promise<ActionState> {
  const { principal } = await requireViewer();
  const gov = await governance();
  return attempt(() =>
    gov.updatePerson(principal, text(form, "userId"), {
      roles: all(form, "roles") as Role[],
      reviewDomains: all(form, "reviewDomains"),
      active: text(form, "active") === "true",
    }),
  );
}
