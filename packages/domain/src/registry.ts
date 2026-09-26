import { contentLifecycle, defineLifecycle, riskReviewLifecycle, type Lifecycle } from "./lifecycle";

/**
 * The registry. An asset is the long-lived record of something the tenant
 * governs: an AI system, an agent, a vendor model, or a piece of content.
 * Reviews are cases attached to an asset over time, so a re-review is a new
 * case on the same asset and its whole history stays in one place.
 */

export const ASSET_KINDS = ["ai_system", "agent", "vendor_model", "content_item"] as const;
export type AssetKind = (typeof ASSET_KINDS)[number];

/* ---------------------------------------------------------------------------
 * Asset operating lifecycle
 * ------------------------------------------------------------------------ */

export type AssetState = "registered" | "active" | "paused" | "retired";
export type AssetAction = "activate" | "pause" | "resume" | "retire";

const operate = ["deployment.operate", "system"] as const;
const retire = { to: "retired", by: ["deployment.operate"], requiresReason: true } as const;

/** Activating or resuming an asset must cite the review case that cleared it. */
export const assetLifecycle = defineLifecycle<AssetState, AssetAction>({
  registered: {
    activate: { to: "active", by: operate, requiresClearance: true },
    retire,
  },
  active: {
    pause: { to: "paused", by: operate, requiresReason: true },
    retire,
  },
  paused: {
    resume: { to: "active", by: operate, requiresReason: true, requiresClearance: true },
    retire,
  },
});

/* ---------------------------------------------------------------------------
 * Cases
 * ------------------------------------------------------------------------ */

export const CASE_KINDS = ["risk_review", "content_review"] as const;
export type CaseKind = (typeof CASE_KINDS)[number];

/** Why a case was opened. Every case after the first is a re-review. */
export const CASE_TRIGGERS = ["initial", "change", "periodic", "incident"] as const;
export type CaseTrigger = (typeof CASE_TRIGGERS)[number];

/** How people refer to a case: its number within the tenant, as in "CASE-0142". */
export function caseLabel(number: number): string {
  return `CASE-${String(number).padStart(4, "0")}`;
}

/** Reads "CASE-0142", "case 142" or "142" as case number 142; anything else as null. */
export function parseCaseLabel(text: string): number | null {
  const match = /^\s*(?:case[\s-]*)?#?0*(\d{1,9})\s*$/i.exec(text);
  const n = match ? Number(match[1]) : 0;
  return n > 0 ? n : null;
}

export function caseKindFor(kind: AssetKind): CaseKind {
  return kind === "content_item" ? "content_review" : "risk_review";
}

export const caseLifecycles: Readonly<Record<CaseKind, Lifecycle<string, string>>> = {
  risk_review: riskReviewLifecycle,
  content_review: contentLifecycle,
};

const APPROVING: Readonly<Record<CaseKind, readonly string[]>> = {
  risk_review: ["approved", "conditionally_approved", "fast_lane_approved"],
  content_review: ["approved"],
};

export function isApproving(kind: CaseKind, state: string): boolean {
  return APPROVING[kind].includes(state);
}

/** A decided case is closed: it approved or rejected, and cannot move again. */
export function isDecided(kind: CaseKind, state: string): boolean {
  return isApproving(kind, state) || state === "rejected";
}

/* ---------------------------------------------------------------------------
 * Clearance: may this asset be in use right now?
 * ------------------------------------------------------------------------ */

export interface CaseSummary {
  readonly id: string;
  readonly kind: CaseKind;
  readonly trigger: CaseTrigger;
  readonly state: string;
  readonly decidedAt: Date | null;
}

/** Whether an asset may be in use, with the case that decides it and, if not, why in plain words. */
export type Clearance =
  | { readonly cleared: true; readonly caseId: string }
  | { readonly cleared: false; readonly reason: string; readonly caseId: string | null };

/**
 * An asset is cleared when its most recently decided case approved it and no
 * incident review is still open. A later rejection revokes an earlier
 * approval; an open change or periodic review does not, because the version
 * already in use stays approved while the next one is reviewed.
 */
export function clearance(cases: readonly CaseSummary[]): Clearance {
  const incident = cases.find((c) => c.trigger === "incident" && c.decidedAt === null);
  if (incident) return { cleared: false, reason: "an incident review is still open", caseId: incident.id };

  const latest = cases
    .filter((c) => c.decidedAt !== null)
    .reduce<CaseSummary | undefined>((a, c) => (!a || c.decidedAt! > a.decidedAt! ? c : a), undefined);
  if (!latest) return { cleared: false, reason: "no review has approved it yet", caseId: null };
  if (isApproving(latest.kind, latest.state)) return { cleared: true, caseId: latest.id };
  return { cleared: false, reason: `its latest review was ${latest.state.replaceAll("_", " ")}`, caseId: latest.id };
}
