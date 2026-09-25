"use server";

import { GovernanceError, type NewCondition } from "@aegis/core";
import {
  IllegalTransitionError,
  type AssetAction,
  type AssetKind,
  type CaseTrigger,
  type ConditionAction,
  type DomainReviewAction,
} from "@aegis/domain";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { ActionState } from "@/lib/action-state";
import { governance } from "@/lib/db";
import { requireViewer } from "@/lib/viewer";

/** Run a governance call; turn a refusal into a message for the form, and let anything else fail loudly. */
async function attempt(fn: () => Promise<unknown>): Promise<ActionState> {
  try {
    await fn();
  } catch (error) {
    if (error instanceof GovernanceError || error instanceof IllegalTransitionError) {
      return { error: error.message.replace(/^Illegal transition: /, "") };
    }
    throw error;
  }
  revalidatePath("/registry", "layout");
  return { error: null };
}

const text = (form: FormData, key: string) => String(form.get(key) ?? "").trim();
const optional = (form: FormData, key: string) => text(form, key) || undefined;

function answers(form: FormData): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(text(form, "answers") || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Register an asset, open its first review and submit the intake: the requester's one form. */
export async function registerAndSubmit(_: ActionState, form: FormData): Promise<ActionState> {
  const { principal } = await requireViewer();
  const gov = await governance();
  let assetId: string | null = null;
  const result = await attempt(async () => {
    const asset = await gov.registerAsset(principal, { kind: text(form, "kind") as AssetKind, name: text(form, "name") });
    assetId = asset.id;
    const draft = await gov.openCase(principal, { assetId: asset.id });
    await gov.submitCase(principal, draft.id, answers(form));
  });
  // Once registered, the asset page is the place to finish, even if submitting failed.
  if (assetId) redirect(`/registry/${assetId}`);
  return result;
}

export async function submitIntake(_: ActionState, form: FormData): Promise<ActionState> {
  const { principal } = await requireViewer();
  const gov = await governance();
  return attempt(() => gov.submitCase(principal, text(form, "caseId"), answers(form)));
}

function conditions(form: FormData): NewCondition[] {
  try {
    const parsed: unknown = JSON.parse(text(form, "conditions") || "[]");
    return Array.isArray(parsed)
      ? parsed.flatMap((c) =>
          c && typeof c === "object" && typeof c.text === "string" ? [{ text: c.text, due: c.due as NewCondition["due"] }] : [],
        )
      : [];
  } catch {
    return [];
  }
}

export async function decide(_: ActionState, form: FormData): Promise<ActionState> {
  const { principal } = await requireViewer();
  const gov = await governance();
  return attempt(() =>
    gov.actOnCase(principal, text(form, "caseId"), text(form, "action"), optional(form, "reason"), {
      conditions: conditions(form),
    }),
  );
}

/** Sign, return, abstain or resume a domain review; or, as the owner, answer a returned one. */
export async function reviewAction(_: ActionState, form: FormData): Promise<ActionState> {
  const { principal } = await requireViewer();
  const gov = await governance();
  const proposals = text(form, "proposals")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return attempt(() =>
    gov.reviewDomain(principal, text(form, "caseId"), text(form, "domain"), text(form, "action") as DomainReviewAction, {
      expectedRevision: Number(text(form, "revision")),
      note: text(form, "note"),
      proposedConditions: proposals,
    }),
  );
}

export async function addEvidence(_: ActionState, form: FormData): Promise<ActionState> {
  const { principal } = await requireViewer();
  const gov = await governance();
  const kind = text(form, "kind") === "attestation" ? "attestation" : "link";
  return attempt(() =>
    gov.addEvidence(principal, {
      assetId: text(form, "assetId"),
      ...(optional(form, "controlId") ? { controlId: text(form, "controlId") } : { conditionId: text(form, "conditionId") }),
      kind,
      title: text(form, "title"),
      ...(kind === "link" ? { url: text(form, "url") } : { detail: text(form, "detail") }),
    }),
  );
}

export async function withdrawEvidence(_: ActionState, form: FormData): Promise<ActionState> {
  const { principal } = await requireViewer();
  const gov = await governance();
  return attempt(() => gov.withdrawEvidence(principal, text(form, "assetId"), text(form, "evidenceId")));
}

export async function requestException(_: ActionState, form: FormData): Promise<ActionState> {
  const { principal } = await requireViewer();
  const gov = await governance();
  return attempt(() =>
    gov.requestException(principal, {
      assetId: text(form, "assetId"),
      controlId: text(form, "controlId"),
      reason: text(form, "reason"),
      days: Number(text(form, "days") || "90"),
    }),
  );
}

export async function exceptionAction(_: ActionState, form: FormData): Promise<ActionState> {
  const { principal } = await requireViewer();
  const gov = await governance();
  return attempt(() =>
    gov.actOnException(
      principal,
      text(form, "exceptionId"),
      text(form, "action") as "approve" | "reject" | "revoke",
      optional(form, "reason"),
    ),
  );
}

export async function conditionAction(_: ActionState, form: FormData): Promise<ActionState> {
  const { principal } = await requireViewer();
  const gov = await governance();
  return attempt(() =>
    gov.actOnCondition(principal, text(form, "conditionId"), text(form, "action") as ConditionAction, optional(form, "reason")),
  );
}

export async function operate(_: ActionState, form: FormData): Promise<ActionState> {
  const { principal } = await requireViewer();
  const gov = await governance();
  return attempt(() =>
    gov.actOnAsset(principal, text(form, "assetId"), text(form, "action") as AssetAction, optional(form, "reason")),
  );
}

export async function openReview(_: ActionState, form: FormData): Promise<ActionState> {
  const { principal } = await requireViewer();
  const gov = await governance();
  return attempt(() =>
    gov.openCase(principal, { assetId: text(form, "assetId"), trigger: text(form, "trigger") as CaseTrigger }),
  );
}
