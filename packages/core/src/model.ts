import type { AuditPayload, Connection } from "@aegis/db";
import {
  can,
  type Answers,
  type AssetKind,
  type AssetState,
  type CaseKind,
  type CaseSummary,
  type CaseTrigger,
  type Principal,
  type Tier,
  type TriageResult,
} from "@aegis/domain";
import type { PolicyPack } from "@aegis/frameworks";

/** Shared records and plumbing for the governance services. */

export interface Asset {
  readonly id: string;
  readonly kind: AssetKind;
  readonly name: string;
  readonly state: AssetState;
  readonly ownerId: string;
  readonly createdAt: Date;
}

export interface Case extends CaseSummary {
  readonly assetId: string;
  readonly ownerId: string;
  readonly packId: string;
  readonly packVersion: string;
  readonly answers: Answers;
  readonly tier: Tier | null;
  readonly triage: TriageResult | null;
  readonly createdAt: Date;
}

/** Case actions that only the service performs, as part of submitting or of automation. */
export const SERVICE_ACTIONS = new Set(["submit", "resubmit", "triage", "fast_lane_approve", "record_ai_review"]);
export const SUBMIT_ACTIONS = new Set(["submit", "resubmit"]);
export const PACK_KIND: Record<CaseKind, PolicyPack["kind"]> = { risk_review: "initiative", content_review: "content" };
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function actorId(actor: Principal): string {
  switch (actor.kind) {
    case "human":
      return actor.userId;
    case "system":
      return `system:${actor.job}`;
    case "agent":
      return `agent:${actor.agent}`;
  }
}

export function canSee(actor: Principal, asset: Asset): boolean {
  if (actor.kind === "system") return true;
  if (can(actor, "case.read_all")) return true;
  return actor.kind === "human" && can(actor, "case.read_own") && asset.ownerId === actor.userId;
}

export interface AssetRow {
  id: string;
  kind: AssetKind;
  name: string;
  state: AssetState;
  owner_id: string;
  created_at: Date;
}

export interface CaseRow {
  id: string;
  asset_id: string;
  kind: CaseKind;
  trigger: CaseTrigger;
  state: string;
  owner_id: string;
  pack_id: string;
  pack_version: string;
  answers: Answers;
  tier: Tier | null;
  triage: TriageResult | null;
  decided_at: Date | null;
  created_at: Date;
}

export const toAsset = (r: AssetRow): Asset => ({
  id: r.id,
  kind: r.kind,
  name: r.name,
  state: r.state,
  ownerId: r.owner_id,
  createdAt: new Date(r.created_at),
});

export const toCase = (r: CaseRow): Case => ({
  id: r.id,
  assetId: r.asset_id,
  kind: r.kind,
  trigger: r.trigger,
  state: r.state,
  ownerId: r.owner_id,
  packId: r.pack_id,
  packVersion: r.pack_version,
  answers: r.answers,
  tier: r.tier,
  triage: r.triage,
  decidedAt: r.decided_at ? new Date(r.decided_at) : null,
  createdAt: new Date(r.created_at),
});

/**
 * What every service module shares: the clock, tenant-scoped transactions,
 * visibility-checked loaders, notes, and the one way to move a case.
 */
export interface Kernel {
  readonly now: () => Date;
  inTenant<T>(actor: Principal, fn: (tx: Connection) => Promise<T>): Promise<T>;
  /** Run `hook` once this transaction has committed; never if it rolls back. */
  afterCommit(tx: Connection, hook: () => void): void;
  loadAsset(tx: Connection, actor: Principal, assetId: string, lock?: boolean): Promise<Asset>;
  loadCase(tx: Connection, actor: Principal, caseId: string): Promise<Case>;
  loadCases(tx: Connection, assetId: string): Promise<Case[]>;
  loadPack(tx: Connection, c: Pick<Case, "packId" | "packVersion">): Promise<PolicyPack>;
  writeNote(
    tx: Connection,
    actor: Principal,
    target: { assetId: string; caseId?: string },
    body: string | null,
  ): Promise<{ id: string; body: string } | undefined>;
  moveCase(
    tx: Connection,
    current: Case,
    action: string,
    actor: Principal,
    context?: { reason?: string; policyId?: string; accountableApprover?: string },
    payload?: AuditPayload,
  ): Promise<Case>;
}
