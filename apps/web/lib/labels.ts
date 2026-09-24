import type { AssetView, HistoryEntry } from "@aegis/core";
import type { AssetKind, AssetState, CaseTrigger, Tier } from "@aegis/domain";

export type Tone = "neutral" | "info" | "good" | "warn" | "bad" | "accent";

export const ASSET_KIND: Record<AssetKind, string> = {
  ai_system: "AI system",
  agent: "Agent",
  vendor_model: "Vendor model",
  content_item: "Member communication",
};

export const ASSET_STATE: Record<AssetState, { label: string; tone: Tone }> = {
  registered: { label: "Not in use", tone: "neutral" },
  active: { label: "In use", tone: "good" },
  paused: { label: "Paused", tone: "warn" },
  retired: { label: "Retired", tone: "neutral" },
};

export const CASE_STATE: Record<string, { label: string; tone: Tone }> = {
  draft: { label: "Waiting on intake", tone: "warn" },
  submitted: { label: "Submitted", tone: "info" },
  triaged: { label: "Triaged", tone: "info" },
  in_review: { label: "In review", tone: "info" },
  ai_reviewed: { label: "AI reviewed", tone: "info" },
  changes_requested: { label: "Changes requested", tone: "warn" },
  fast_lane_approved: { label: "Fast-lane approved", tone: "good" },
  approved: { label: "Approved", tone: "good" },
  conditionally_approved: { label: "Approved with conditions", tone: "good" },
  rejected: { label: "Rejected", tone: "bad" },
};

export const TRIGGER: Record<CaseTrigger, string> = {
  initial: "Initial review",
  change: "Change review",
  periodic: "Periodic review",
  incident: "Incident review",
};

export const TIER: Record<Tier, { label: string; tone: Tone }> = {
  low: { label: "Low risk", tone: "good" },
  medium: { label: "Medium risk", tone: "warn" },
  high: { label: "High risk", tone: "bad" },
  critical: { label: "Critical risk", tone: "bad" },
};

export const DECISIONS: Record<string, { label: string; tone: Tone; needsReason: boolean }> = {
  approve: { label: "Approve", tone: "good", needsReason: false },
  conditionally_approve: { label: "Approve with conditions", tone: "accent", needsReason: true },
  reject: { label: "Reject", tone: "bad", needsReason: true },
  request_changes: { label: "Request changes", tone: "warn", needsReason: true },
  start_review: { label: "Start review", tone: "accent", needsReason: false },
};

export const OPERATIONS: Record<string, { label: string; tone: Tone; needsReason: boolean; needsClearance: boolean }> = {
  activate: { label: "Put in use", tone: "good", needsReason: false, needsClearance: true },
  resume: { label: "Resume", tone: "good", needsReason: true, needsClearance: true },
  pause: { label: "Pause", tone: "warn", needsReason: true, needsClearance: false },
  retire: { label: "Retire", tone: "bad", needsReason: true, needsClearance: false },
};

const SYSTEM_JOBS: Record<string, string> = {
  "system:triage": "Automated triage",
  "system:drift-monitor": "Drift monitor",
  "system:provisioning": "Provisioning",
};

export function actorName(actor: HistoryEntry["actor"]): string {
  if (actor.kind === "human") return actor.name ?? "A person who has been removed";
  return SYSTEM_JOBS[actor.id] ?? actor.id.replace(/^(system|agent):/, "");
}

/** One line in plain language for an audit event. */
export function describe(entry: HistoryEntry): string {
  const p = entry.payload;
  switch (entry.action) {
    case "asset.register":
      return "registered it";
    case "case.open":
      return `opened ${(TRIGGER[p.trigger as CaseTrigger] ?? "a review").toLowerCase()}`;
    case "case.submit":
    case "case.resubmit":
      return "submitted the intake";
    case "case.triage":
      return `triaged it as ${(TIER[p.tier as Tier]?.label ?? "unknown risk").toLowerCase()}`;
    case "case.start_review":
      return "sent it to full review";
    case "case.fast_lane_approve":
      return `approved it in the fast lane, accountable: ${String(p.accountableApprover)}`;
    case "case.approve":
      return "approved it";
    case "case.conditionally_approve":
      return "approved it with conditions";
    case "case.reject":
      return "rejected it";
    case "asset.activate":
      return "put it in use";
    case "asset.pause":
      return "paused it";
    case "asset.resume":
      return "resumed it";
    case "asset.retire":
      return "retired it";
    default:
      return entry.action;
  }
}

export interface NextStep {
  readonly label: string;
  readonly tone: Tone;
}

/** The one thing this viewer should do next on this asset, if anything. */
export function nextStep(view: AssetView): NextStep | null {
  const caseActions = view.actions.openCase;
  const trigger = view.openCase ? TRIGGER[view.openCase.trigger].toLowerCase() : "";
  if (caseActions.includes("submit") || caseActions.includes("resubmit")) {
    return { label: `Answer the ${trigger} intake`, tone: "warn" };
  }
  if (caseActions.includes("approve")) {
    const tier = view.openCase?.tier ? `${TIER[view.openCase.tier].label.toLowerCase()} ` : "";
    return { label: `Decide on this ${tier}review`, tone: "accent" };
  }
  if (caseActions.includes("start_review")) return { label: "Start the review", tone: "accent" };
  if (view.clearance.cleared && view.actions.asset.includes("activate")) {
    return { label: "Approved: put it in use", tone: "good" };
  }
  if (view.clearance.cleared && view.actions.asset.includes("resume")) {
    return { label: "Cleared again: resume it", tone: "good" };
  }
  if (view.actions.newCase.includes("initial")) return { label: "Start its first review", tone: "warn" };
  return null;
}

/** The review to show on a registry row: the one under way, or else the latest. */
export function currentReview(view: AssetView) {
  return view.openCase ?? view.cases.at(-1) ?? null;
}

const UTC = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
  timeZone: "UTC",
});

export const formatTime = (at: Date) => `${UTC.format(at)} UTC`;

export function ago(at: Date, now: Date = new Date()): string {
  const minutes = Math.round((now.getTime() - at.getTime()) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export function daysLeft(until: Date, now: Date = new Date()): number {
  return Math.max(0, Math.ceil((until.getTime() - now.getTime()) / 86_400_000));
}

export const ROLE: Record<string, { label: string; blurb: string }> = {
  requester: { label: "Requester", blurb: "You register AI systems and answer their intake." },
  approver: { label: "Approver", blurb: "You decide reviews. You can't decide your own." },
  reviewer: { label: "Reviewer", blurb: "You sign off reviews in your domains." },
  admin: { label: "Admin", blurb: "You put cleared systems in use, pause them, and manage people." },
  auditor: { label: "Auditor", blurb: "You see everything and change nothing." },
  program_office: { label: "Program office", blurb: "You follow the whole portfolio." },
};

export const initials = (name: string) =>
  name
    .split(/\s+/)
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
