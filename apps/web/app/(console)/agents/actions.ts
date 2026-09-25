"use server";

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

/** Connect the tenant's model. A blank key keeps the saved one. */
export async function connectModel(_: ActionState, form: FormData): Promise<ActionState> {
  const { principal } = await requireViewer();
  const gov = await governance();
  return attempt(() =>
    gov.connectModel(principal, {
      provider: text(form, "provider"),
      model: text(form, "model"),
      endpoint: text(form, "endpoint") || null,
      apiVersion: text(form, "apiVersion") || null,
      apiKey: text(form, "apiKey") || null,
    }),
  );
}

export async function runEvaluation(_: ActionState, form: FormData): Promise<ActionState> {
  const { principal } = await requireViewer();
  const gov = await governance();
  return attempt(() => gov.startEval(principal, text(form, "agent")));
}

export async function switchAgent(_: ActionState, form: FormData): Promise<ActionState> {
  const { principal } = await requireViewer();
  const gov = await governance();
  return attempt(() => gov.setAgentEnabled(principal, text(form, "agent"), text(form, "enabled") === "true"));
}
