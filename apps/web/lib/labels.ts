import type { AssetView, HistoryEntry } from "@aegis/core";
import {
  caseLabel,
  evaluate,
  type Answers,
  type AssetKind,
  type AssetState,
  type CaseTrigger,
  type ConditionState,
  type DeploymentMode,
  type DomainReviewStatus,
  type ExceptionState,
  type Tier,
} from "@aegis/domain";
import type { InitiativePack, PolicyPack } from "@aegis/frameworks";

/**
 * Every word the console shows for a state, an action or an audit event.
 * Plain words: sign, approve, reject, review, audit log. Short sentences.
 * IDs are written exactly as the system writes them.
 */

export type Tone = "ok" | "warn" | "bad" | "agent" | "seal" | "neutral";

export { caseLabel };

export const ASSET_KIND: Record<AssetKind, string> = {
  ai_system: "AI system",
  agent: "Agent",
  vendor_model: "Vendor model",
  content_item: "Member communication",
};

export const ASSET_STATE: Record<AssetState, { label: string; tone: Tone }> = {
  registered: { label: "Not in use", tone: "neutral" },
  active: { label: "In use", tone: "ok" },
  paused: { label: "Paused", tone: "warn" },
  retired: { label: "Retired", tone: "neutral" },
};

export const CASE_STATE: Record<string, { label: string; tone: Tone }> = {
  draft: { label: "Waiting on intake", tone: "warn" },
  submitted: { label: "Submitted", tone: "neutral" },
  triaged: { label: "Triaged", tone: "neutral" },
  in_review: { label: "In review", tone: "neutral" },
  ai_reviewed: { label: "AI reviewed", tone: "neutral" },
  changes_requested: { label: "Changes requested", tone: "warn" },
  fast_lane_approved: { label: "Approved in the fast lane", tone: "ok" },
  approved: { label: "Approved", tone: "ok" },
  conditionally_approved: { label: "Approved with conditions", tone: "ok" },
  rejected: { label: "Rejected", tone: "bad" },
};

export const TRIGGER: Record<CaseTrigger, string> = {
  initial: "Initial review",
  change: "Change review",
  periodic: "Periodic review",
  incident: "Incident review",
};

export const DEPLOYMENT: Record<DeploymentMode, string> = {
  shared: "Shared cloud",
  dedicated: "Dedicated",
  byoc: "Your cloud",
};

export const DECISIONS: Record<string, { label: string; needsReason: boolean; prompt: string }> = {
  approve: { label: "Approve", needsReason: false, prompt: "Note for the requester and auditors (optional)" },
  conditionally_approve: {
    label: "Approve with conditions",
    needsReason: true,
    prompt: "Why approve with conditions? The requester and auditors will read this.",
  },
  reject: { label: "Reject", needsReason: true, prompt: "Why reject it? The requester and auditors will read this." },
  request_changes: { label: "Request changes", needsReason: true, prompt: "What needs to change?" },
  start_review: { label: "Start the review", needsReason: false, prompt: "" },
};

export const OPERATIONS: Record<string, { label: string; needsReason: boolean; needsClearance: boolean }> = {
  activate: { label: "Put in use", needsReason: false, needsClearance: true },
  resume: { label: "Resume", needsReason: true, needsClearance: true },
  pause: { label: "Pause", needsReason: true, needsClearance: false },
  retire: { label: "Retire", needsReason: true, needsClearance: false },
};

export const REVIEW_STATUS: Record<DomainReviewStatus, { label: string; tone: Tone }> = {
  pending: { label: "Open", tone: "neutral" },
  drafted: { label: "Draft ready", tone: "agent" },
  signed: { label: "Signed", tone: "ok" },
  returned: { label: "Question for the owner", tone: "warn" },
  abstained: { label: "Abstained", tone: "neutral" },
};

export const EXCEPTION_STATE: Record<ExceptionState, { label: string; tone: Tone }> = {
  requested: { label: "Exception requested", tone: "warn" },
  approved: { label: "Exception approved", tone: "ok" },
  rejected: { label: "Exception rejected", tone: "bad" },
  revoked: { label: "Exception revoked", tone: "neutral" },
  expired: { label: "Exception expired", tone: "bad" },
};

export const CONDITION_STATE: Record<ConditionState, { label: string; tone: Tone }> = {
  open: { label: "Open", tone: "warn" },
  submitted: { label: "Evidence submitted", tone: "neutral" },
  met: { label: "Met", tone: "ok" },
  waived: { label: "Waived", tone: "neutral" },
};

export const CONDITION_ACTIONS: Record<string, { label: string; needsNote: boolean }> = {
  submit: { label: "Submit for acceptance", needsNote: false },
  accept: { label: "Accept", needsNote: false },
  return: { label: "Send back", needsNote: true },
  waive: { label: "Waive", needsNote: true },
};

const ACTORS: Record<string, string> = {
  "system:triage": "triage",
  "system:exception-expiry": "exception expiry",
  "system:drift-monitor": "drift monitor",
  "system:provisioning": "provisioning",
  "system:agent-evals": "golden-set evaluation",
  "system:review-drafter": "review drafter",
  "agent:review-drafter": "review drafter",
  "agent:intake": "intake assistant",
};

export const AGENT_NAME: Record<string, string> = { intake: "intake assistant", "review-drafter": "review drafter" };

export function actorName(actor: HistoryEntry["actor"]): string {
  if (actor.kind === "human") return actor.name ?? "A person who has been removed";
  return ACTORS[actor.id] ?? actor.id.replace(/^(system|agent):/, "");
}

/** "Avery Brooks" as "A. Brooks", for the audit log's wire lines. */
export function shortName(name: string): string {
  const parts = name.trim().split(/\s+/);
  return parts.length < 2 ? name : `${parts[0]![0]}. ${parts.slice(1).join(" ")}`;
}

export const hash4 = (hash: string | null | undefined) => (hash ? hash.slice(0, 4) : "");

export const AGENT_STATUS: Record<string, { label: string; tone: Tone }> = {
  on: { label: "On", tone: "ok" },
  ready: { label: "Passed · off", tone: "neutral" },
  blocked: { label: "Off", tone: "neutral" },
  evaluating: { label: "Evaluating", tone: "agent" },
  failed: { label: "Failed its golden set", tone: "bad" },
};

export const PROVIDERS: Record<string, { label: string; help: string }> = {
  scripted: { label: "Scripted demo", help: "Deterministic rules and templates. No AI, and nothing leaves Aegis." },
  openai: { label: "OpenAI", help: "Your organization's OpenAI API key." },
  "azure-openai": { label: "Azure OpenAI", help: "A deployment in your own Azure tenant." },
  "openai-compatible": { label: "Compatible endpoint", help: "Any server that speaks the OpenAI chat API over https." },
};

/** Why an agent run or a golden case failed, in plain words. */
export const FAILURE: Record<string, string> = {
  timeout: "didn't answer in time",
  rate_limited: "was rate limited by the model provider",
  provider_error: "couldn't reach the model provider",
  auth_failed: "was refused by the provider; check the key",
  bad_request: "was refused by the provider; check the model settings",
  endpoint_blocked: "was blocked: the endpoint is a private address",
  no_key: "has no readable key; enter it again",
  invalid_output: "answered in the wrong shape",
  decision_language: "tried to state a decision",
  unknown_control: "cited a control this case doesn't have",
  interrupted: "was interrupted by a restart",
  under_triage: "would have put the system in too low a risk tier",
  model_changed: "stopped because the model changed",
  incomplete: "stopped before finishing",
};

/** One golden-set failure code, e.g. "missed_gate:S-01" or "wrong:phi", in plain words. */
export function evalFinding(code: string, fields: Readonly<Record<string, string>> = {}): string {
  const [kind, subject = ""] = code.split(":");
  switch (kind) {
    case "missed_gate":
      return `missed gate control ${subject} with nothing on file`;
    case "contradicts_evidence":
      return `said ${subject} had no evidence when it did`;
    case "no_question":
      return "asked the owner nothing when evidence was missing";
    case "wrong":
      return `answered "${fields[subject] ?? subject}" wrongly`;
    case "unsure":
      return `was unsure about "${fields[subject] ?? subject}"`;
    default:
      return FAILURE[kind!] ?? code;
  }
}

const TIER_WORD: Record<Tier, string> = { low: "low", medium: "medium", high: "high", critical: "critical" };

/** One line in plain language for an audit event. `labels` names review domains. */
export function describe(entry: HistoryEntry, labels: Readonly<Record<string, string>> = {}): string {
  const p = entry.payload;
  const domain = typeof p.domain === "string" ? (labels[p.domain] ?? p.domain) : "";
  const agent = typeof p.agentId === "string" ? (AGENT_NAME[p.agentId] ?? p.agentId) : "the agent";
  switch (entry.action) {
    case "review.sign":
      return p.fromDraft === "as_drafted"
        ? `signed ${domain}, keeping the drafter's memo`
        : p.fromDraft === "edited"
          ? `signed ${domain}, editing the drafter's memo`
          : `signed ${domain}`;
    case "review.draft":
      return `drafted the ${domain} review`;
    case "review.return":
      return `asked the owner a question on ${domain}`;
    case "review.respond":
      return `answered the ${domain} reviewer`;
    case "review.abstain":
      return `abstained from ${domain}`;
    case "review.resume":
      return `resumed the ${domain} review`;
    case "evidence.add":
      return p.controlId ? `added evidence for ${String(p.controlId)}` : "added evidence for a condition";
    case "evidence.withdraw":
      return "withdrew evidence";
    case "exception.request":
      return `requested a ${String(p.days)}-day exception for ${String(p.controlId)}`;
    case "exception.approve":
      return `approved the exception for ${String(p.controlId)}`;
    case "exception.reject":
      return `rejected the exception for ${String(p.controlId)}`;
    case "exception.revoke":
      return `revoked the exception for ${String(p.controlId)}`;
    case "exception.expire":
      return `marked the exception for ${String(p.controlId)} expired`;
    case "condition.add":
      return `set a condition (${p.due === "before_use" ? "before use" : "ongoing"})`;
    case "condition.submit":
      return "submitted a condition as met";
    case "condition.accept":
      return "accepted a condition as met";
    case "condition.return":
      return "sent a condition back";
    case "condition.waive":
      return "waived a condition";
    case "asset.register":
      return "registered it";
    case "case.open":
      return `opened ${(TRIGGER[p.trigger as CaseTrigger] ?? "a review").toLowerCase()}`;
    case "case.submit":
    case "case.resubmit":
      return typeof p.suggested === "number" && p.suggested > 0
        ? `submitted the intake, keeping ${String(p.keptAsSuggested)} of ${p.suggested} suggested answers`
        : "submitted the intake";
    case "case.triage":
      return `set the tier to ${TIER_WORD[p.tier as Tier] ?? "unknown"} by rule ${String(p.tierRuleId ?? "none")}`;
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
    case "case.request_changes":
      return "asked for changes";
    case "asset.activate":
      return "put it in use";
    case "asset.pause":
      return "paused it";
    case "asset.resume":
      return "resumed it";
    case "asset.retire":
      return "retired it";
    case "audit.export":
      return "exported the evidence pack";
    case "agent.connect":
      return p.keyChanged ? "connected the agents' model, with a new key" : "connected the agents' model";
    case "agent.evaluate":
      return `started the ${agent}'s golden set`;
    case "agent.evaluated":
      return entry.after === "passed"
        ? `passed the ${agent}'s golden set`
        : entry.after === "failed"
          ? `failed the ${agent}'s golden set`
          : `stopped the ${agent}'s golden set`;
    case "agent.enable":
      return `turned on the ${agent}`;
    case "agent.disable":
      return p.because === "model_changed" ? `turned off the ${agent}: the model changed` : `turned off the ${agent}`;
    case "user.add":
      return "added a person";
    case "tenant.provision":
      return "set up this organization";
    default:
      return entry.action;
  }
}

/** An audit event as a wire line: the action code, what it touched, and the case. */
export function wireAction(entry: HistoryEntry): string {
  const verb = entry.action.split(".").slice(1).join(".") || entry.action;
  const parts = [verb];
  if (typeof entry.payload.domain === "string") parts.push(entry.payload.domain);
  if (typeof entry.payload.controlId === "string") parts.push(entry.payload.controlId);
  if (typeof entry.payload.agentId === "string") parts.push(entry.payload.agentId);
  if (entry.caseNumber) parts.push(caseLabel(entry.caseNumber));
  else if (entry.assetName) parts.push(entry.assetName);
  return parts.join(" ");
}

export interface NextStep {
  readonly label: string;
  readonly tone: Tone;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
export { plural };

/** The one thing this viewer should do next on this asset, if anything. */
export function nextStep(view: AssetView): NextStep | null {
  const caseActions = view.actions.openCase;
  const { reviews, readiness, controls, conditions } = view.assurance;
  const trigger = view.openCase ? TRIGGER[view.openCase.trigger].toLowerCase() : "";
  if (caseActions.includes("submit") || caseActions.includes("resubmit")) {
    return { label: `Answer the ${trigger} intake`, tone: "warn" };
  }
  if (reviews.some((r) => r.actions.includes("respond"))) return { label: "Answer a reviewer's question", tone: "warn" };
  const toSign = reviews.filter((r) => r.actions.includes("sign"));
  if (toSign.length > 0) {
    const drafted = toSign.filter((r) => r.status === "drafted").length;
    return {
      label: `Review ${toSign.length === 1 ? toSign[0]!.label : plural(toSign.length, "domain")}${drafted > 0 ? ` · ${drafted === toSign.length ? (drafted === 1 ? "draft" : "drafts") : `${drafted} drafts`} ready` : ""}`,
      tone: "seal",
    };
  }
  if (caseActions.includes("approve") && (readiness?.canApprove || readiness?.canConditionallyApprove)) {
    return { label: "Decide on this review", tone: "seal" };
  }
  if (controls.some((c) => c.exception?.actions.includes("approve"))) return { label: "Decide an exception", tone: "seal" };
  if (conditions.some((c) => c.actions.includes("accept"))) return { label: "Check a condition's evidence", tone: "seal" };
  const uncovered = controls.filter((c) => c.enforcement === "gate" && !c.covered).length;
  if (view.viewerIsOwner && uncovered > 0 && view.asset.state !== "retired") {
    return { label: `Add evidence for ${plural(uncovered, "control")}`, tone: "warn" };
  }
  if (view.viewerIsOwner && conditions.some((c) => c.state === "open" && c.actions.includes("submit"))) {
    return { label: "Show a condition is met", tone: "warn" };
  }
  if (caseActions.includes("start_review")) return { label: "Start the review", tone: "seal" };
  if (view.clearance.cleared && view.actions.asset.includes("activate")) {
    return { label: "Approved: put it in use", tone: "ok" };
  }
  if (view.clearance.cleared && view.actions.asset.includes("resume")) {
    return { label: "Cleared again: resume it", tone: "ok" };
  }
  if (view.actions.newCase.includes("initial")) return { label: "Start its first review", tone: "warn" };
  return null;
}

/** The review to show on a registry row: the one under way, or else the latest. */
export function currentReview(view: AssetView) {
  return view.openCase ?? view.cases.at(-1) ?? null;
}

/** Where an asset is: intake, review, decided, in use, or back in review. */
export function stageOf(view: AssetView): { at: number; warn: boolean; label: string } {
  const open = view.openCase;
  const decidedBefore = view.cases.some((c) => c.decidedAt !== null);
  const state = ASSET_STATE[view.asset.state].label;
  if (view.asset.state === "retired") return { at: -1, warn: false, label: "Retired" };
  if (open && decidedBefore) {
    const paused = view.asset.state === "paused" ? "Paused · " : "";
    return { at: 4, warn: open.trigger === "incident", label: `${paused}${TRIGGER[open.trigger]} · ${CASE_STATE[open.state]?.label.toLowerCase() ?? open.state}` };
  }
  if (open) {
    const intake = open.state === "draft" || open.state === "changes_requested";
    return { at: intake ? 0 : 1, warn: open.state === "changes_requested", label: CASE_STATE[open.state]?.label ?? open.state };
  }
  if (view.asset.state === "active") return { at: 3, warn: false, label: state };
  if (view.asset.state === "paused") return { at: 3, warn: true, label: state };
  if (decidedBefore) {
    const latest = view.cases.at(-1)!;
    return { at: 2, warn: latest.state === "rejected", label: `${CASE_STATE[latest.state]?.label ?? latest.state} · not in use` };
  }
  return { at: 0, warn: true, label: "Not started" };
}

/** Finishes "… risk, because it": the pack's own sentence for the rule, else the rule's reason. */
export function becauseText(pack: PolicyPack | null, ruleId: string | null): string {
  const initiative = pack?.kind === "initiative" ? pack : null;
  const id = ruleId ?? "default";
  const worded = initiative?.sentence?.because[id];
  if (worded) return worded;
  const rule = initiative?.triage.tierRules.find((r) => r.id === ruleId);
  return rule ? `was placed here by the rule: ${rule.because}` : "trips none of the policy's risk rules";
}

/** Why a review domain has a seat at the table for these answers, as the pack words it. */
export function whySeat(pack: InitiativePack, tier: Tier, answers: Answers, domain: string): string {
  if (pack.triage.baseDomains[tier].includes(domain)) return `every ${tier}-risk system gets this review`;
  const added = pack.triage.domainRules.filter((r) => r.add.includes(domain) && evaluate(r.when, answers)).map((r) => r.because);
  return added.length > 0 ? added.join("; ") : "the policy pack requires it";
}

const UTC = (options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", ...options });
const TIME = UTC({ hour: "2-digit", minute: "2-digit", hour12: false });
const DAY = UTC({ month: "short", day: "numeric" });
const LONG = UTC({ weekday: "long", day: "numeric", month: "long", year: "numeric" });

export const clock = (at: Date) => TIME.format(at);
export const formatDate = (at: Date) => DAY.format(at);
export const formatLongDate = (at: Date) => LONG.format(at);
export const formatTime = (at: Date) => `${DAY.format(at)}, ${TIME.format(at)} UTC`;

export function ago(at: Date, now: Date = new Date()): string {
  const minutes = Math.round((now.getTime() - at.getTime()) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/** "2d", "5h": how long something has waited. */
export function age(at: Date, now: Date = new Date()): string {
  const hours = (now.getTime() - at.getTime()) / 3_600_000;
  if (hours < 1) return "now";
  if (hours < 48) return `${Math.round(hours)}h`;
  return `${Math.round(hours / 24)}d`;
}

export function daysLeft(until: Date, now: Date = new Date()): number {
  return Math.max(0, Math.ceil((until.getTime() - now.getTime()) / 86_400_000));
}

export const ROLE: Record<string, { label: string; blurb: string }> = {
  requester: { label: "Requester", blurb: "You register AI systems and answer their intake." },
  approver: { label: "Approver", blurb: "You decide reviews. You can't decide your own." },
  reviewer: { label: "Reviewer", blurb: "You sign reviews in your domains." },
  admin: { label: "Admin", blurb: "You put cleared systems in use, pause them, and manage people." },
  auditor: { label: "Auditor", blurb: "You see everything, change nothing, and export evidence." },
  program_office: { label: "Program office", blurb: "You follow the whole portfolio." },
};

export const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
