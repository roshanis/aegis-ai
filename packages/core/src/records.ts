import { appendAudit, sha256Hex, verifyAuditChain, type AuditPayload, type Connection } from "@aegis/db";
import {
  can,
  caseLabel,
  isDecided,
  parseCaseLabel,
  type CaseKind,
  type ConditionDue,
  type ConditionState,
  type DomainReviewStatus,
  type DraftUse,
  type Principal,
} from "@aegis/domain";
import type { PolicyPack } from "@aegis/frameworks";
import type { Assurance, Person } from "./assurance";
import { GovernanceError } from "./errors";
import { UUID, actorId, canSee, toAsset, toCase, type Asset, type AssetRow, type Case, type CaseRow, type Kernel } from "./model";

/**
 * Records: the read side people use to answer "who decided this, why, and
 * can we prove it". The audit log, case records for one decision, search by
 * name or case number, the policy packs in force, and the evidence pack an
 * auditor exports. Everything here reads what the viewer may already see.
 */

export interface HistoryEntry {
  /** The event's position in the tenant's audit log. */
  readonly id: number;
  readonly at: Date;
  readonly action: string;
  readonly before: string | null;
  readonly after: string | null;
  readonly assetId: string | null;
  /** The asset's name as it is now; the log itself keeps only its id. */
  readonly assetName: string | null;
  readonly caseId: string | null;
  readonly caseNumber: number | null;
  readonly actor: { readonly kind: Principal["kind"]; readonly id: string; readonly name: string | null };
  /** True when this event decided a case. */
  readonly decision: boolean;
  /** The written reason, unless none was given or it has been erased. */
  readonly reason: string | null;
  readonly reasonStatus: "none" | "intact" | "erased" | "altered";
  /** The policy pack version the case was reviewed under. */
  readonly policy: { readonly packId: string; readonly packVersion: string } | null;
  readonly payload: AuditPayload;
  /** This event's link in the tenant's hash chain. */
  readonly hash: string;
}

/** Whether the tenant's audit log still verifies, recomputed from every event. */
export interface ChainStatus {
  readonly intact: boolean;
  /** The first event whose hash no longer matches, if any. */
  readonly brokenAt: number | null;
  readonly latest: string | null;
  readonly events: number;
}

export interface SignOff {
  readonly domain: string;
  readonly label: string;
  readonly status: DomainReviewStatus;
  readonly reviewer: Person | null;
  /** When the review last changed. */
  readonly at: Date;
  /** For a signature: whether the reviewer kept, edited or ignored the drafter's memo. */
  readonly fromDraft: DraftUse | null;
  /** The audit event that recorded the latest signature. */
  readonly hash: string | null;
}

/** One case, told from the audit log: what was decided, by whom, why, under which rule. */
export interface CaseRecord {
  readonly asset: Asset;
  readonly ownerName: string | null;
  readonly case: Case;
  readonly label: string;
  readonly pack: PolicyPack;
  /** Every event on this case, oldest first. */
  readonly events: readonly HistoryEntry[];
  /** The event that decided it, once decided. */
  readonly decision: HistoryEntry | null;
  /** The triage rule that set the tier, and its reason as the pack words it. */
  readonly tierRule: { readonly id: string | null; readonly because: string | null } | null;
  readonly signoffs: readonly SignOff[];
  readonly conditions: readonly {
    readonly id: string;
    readonly text: string | null;
    readonly due: ConditionDue;
    readonly state: ConditionState;
  }[];
  readonly fastLane: { readonly policyId: string; readonly accountableApprover: string } | null;
}

export interface CaseMatch {
  readonly caseId: string;
  readonly number: number;
  readonly label: string;
  readonly assetId: string;
  readonly assetName: string;
  readonly kind: CaseKind;
  readonly state: string;
  readonly decidedAt: Date | null;
}

export interface PackVersion {
  readonly packId: string;
  readonly version: string;
  readonly enabled: boolean;
  readonly addedAt: Date;
  readonly pack: PolicyPack;
}

export interface EventQuery {
  readonly assetId?: string;
  readonly caseId?: string;
  readonly actorKind?: Principal["kind"];
  /** Only events before this position, for paging back. */
  readonly beforeId?: number;
  readonly since?: Date;
  readonly limit?: number;
  readonly order?: "asc" | "desc";
}

interface EventRow {
  id: string;
  at: Date;
  action: string;
  before_state: string | null;
  after_state: string | null;
  asset_id: string | null;
  asset_name: string | null;
  case_id: string | null;
  case_number: number | null;
  actor_kind: Principal["kind"];
  actor_id: string;
  note_id: string | null;
  note_sha256: string | null;
  payload: AuditPayload;
  hash: string;
  display_name: string | null;
  body: string | null;
  case_kind: CaseKind | null;
  pack_id: string | null;
  pack_version: string | null;
}

const toEntry = (r: EventRow): HistoryEntry => ({
  id: Number(r.id),
  at: new Date(r.at),
  action: r.action,
  before: r.before_state,
  after: r.after_state,
  assetId: r.asset_id,
  assetName: r.asset_name,
  caseId: r.case_id,
  caseNumber: r.case_number === null ? null : Number(r.case_number),
  actor: { kind: r.actor_kind, id: r.actor_id, name: r.display_name },
  decision: r.case_kind !== null && r.after_state !== null && isDecided(r.case_kind, r.after_state),
  reason: r.body,
  reasonStatus:
    r.note_id === null ? "none" : r.body === null ? "erased" : sha256Hex(r.body) === r.note_sha256 ? "intact" : "altered",
  policy: r.pack_id && r.pack_version ? { packId: r.pack_id, packVersion: r.pack_version } : null,
  payload: r.payload,
  hash: r.hash,
});

const readsAll = (actor: Principal) => actor.kind === "system" || can(actor, "case.read_all");
const ILIKE_SPECIAL = /[\\%_]/g;

export function createRecords(k: Kernel, assurance: { view: (tx: Connection, actor: Principal, asset: Asset, cases: readonly Case[]) => Promise<Assurance> }) {
  /**
   * Audit events this viewer may see. People who read every case see the
   * whole log, tenant events included; a requester sees events on the
   * assets they own.
   */
  async function events(tx: Connection, actor: Principal, query: EventQuery = {}): Promise<HistoryEntry[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    const param = (value: unknown) => {
      params.push(value);
      return `$${params.length}`;
    };
    if (!readsAll(actor)) {
      if (actor.kind !== "human" || !can(actor, "case.read_own")) return [];
      where.push(`a.owner_id = ${param(actor.userId)}`);
    }
    if (query.assetId) where.push(`e.asset_id = ${param(UUID.test(query.assetId) ? query.assetId : null)}`);
    if (query.caseId) where.push(`e.case_id = ${param(UUID.test(query.caseId) ? query.caseId : null)}`);
    if (query.actorKind) where.push(`e.actor_kind = ${param(query.actorKind)}`);
    if (query.beforeId !== undefined) where.push(`e.id < ${param(query.beforeId)}`);
    if (query.since) where.push(`e.at >= ${param(query.since.toISOString())}`);
    const limit = Math.min(Math.max(query.limit ?? 500, 1), 1000);
    const { rows } = await tx.query<EventRow>(
      `SELECT e.id, e.at, e.action, e.before_state, e.after_state, e.asset_id, a.name AS asset_name,
              e.case_id, c.number AS case_number, e.actor_kind, e.actor_id, e.note_id, e.note_sha256,
              e.payload, e.hash, u.display_name, n.body, c.kind AS case_kind, c.pack_id, c.pack_version
       FROM audit_events e
       LEFT JOIN assets a ON a.id = e.asset_id
       LEFT JOIN users u ON e.actor_kind = 'human' AND u.id::text = e.actor_id
       LEFT JOIN notes n ON n.id = e.note_id
       LEFT JOIN cases c ON c.id = e.case_id
       ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY e.id ${query.order === "asc" ? "ASC" : "DESC"}
       LIMIT ${limit}`,
      params,
    );
    return rows.map(toEntry);
  }

  async function chainStatus(tx: Connection): Promise<ChainStatus> {
    const brokenAt = await verifyAuditChain(tx);
    const { rows } = await tx.query<{ hash: string | null; n: number }>(
      "SELECT (SELECT hash FROM audit_events ORDER BY id DESC LIMIT 1) AS hash, (SELECT count(*)::int FROM audit_events) AS n",
    );
    return { intact: brokenAt === null, brokenAt, latest: rows[0]?.hash ?? null, events: rows[0]?.n ?? 0 };
  }

  /** A case and its asset, if this viewer may see them. Reads only: nothing is locked. */
  async function findCase(tx: Connection, actor: Principal, caseId: string): Promise<{ asset: Asset; found: Case }> {
    const notFound = new GovernanceError("not_found", `case ${caseId} not found`);
    if (!UUID.test(caseId)) throw notFound;
    const { rows } = await tx.query<CaseRow & { a_id: string; a_kind: AssetRow["kind"]; a_name: string; a_state: AssetRow["state"]; a_owner: string; a_created: Date }>(
      `SELECT c.*, a.id AS a_id, a.kind AS a_kind, a.name AS a_name, a.state AS a_state, a.owner_id AS a_owner, a.created_at AS a_created
       FROM cases c JOIN assets a ON a.id = c.asset_id WHERE c.id = $1`,
      [caseId],
    );
    const row = rows[0];
    if (!row) throw notFound;
    const asset = toAsset({ id: row.a_id, kind: row.a_kind, name: row.a_name, state: row.a_state, owner_id: row.a_owner, created_at: row.a_created });
    if (!canSee(actor, asset)) throw notFound;
    return { asset, found: toCase(row) };
  }

  async function record(tx: Connection, actor: Principal, caseId: string): Promise<CaseRecord> {
    const { asset, found } = await findCase(tx, actor, caseId);
    const pack = await k.loadPack(tx, found);
    const labels = pack.kind === "initiative" ? pack.domains : {};
    const [log, owner, reviews, conditions] = await Promise.all([
      events(tx, actor, { caseId: found.id, order: "asc", limit: 1000 }),
      tx.query<{ display_name: string }>("SELECT display_name FROM users WHERE id = $1", [asset.ownerId]),
      tx.query<{ domain: string; status: DomainReviewStatus; reviewer_id: string | null; reviewer_name: string | null; updated_at: Date }>(
        `SELECT r.domain, r.status, r.reviewer_id, u.display_name AS reviewer_name, r.updated_at
         FROM domain_reviews r LEFT JOIN users u ON u.id = r.reviewer_id
         WHERE r.case_id = $1 ORDER BY r.domain`,
        [found.id],
      ),
      tx.query<{ id: string; due: ConditionDue; state: ConditionState; body: string | null }>(
        `SELECT c.id, c.due, c.state, n.body FROM conditions c LEFT JOIN notes n ON n.id = c.note_id
         WHERE c.case_id = $1 ORDER BY c.created_at, c.due, c.id`,
        [found.id],
      ),
    ]);
    const lastSign = (domain: string) => log.filter((e) => e.action === "review.sign" && e.payload.domain === domain).at(-1);
    const rule = found.triage && pack.kind === "initiative" ? pack.triage.tierRules.find((r) => r.id === found.triage!.tierRuleId) : undefined;
    const fast = log.find((e) => e.action === "case.fast_lane_approve");
    return {
      asset,
      ownerName: owner.rows[0]?.display_name ?? null,
      case: found,
      label: caseLabel(found.number),
      pack,
      events: log,
      decision: log.filter((e) => e.decision).at(-1) ?? null,
      tierRule: found.triage ? { id: found.triage.tierRuleId, because: rule?.because ?? null } : null,
      signoffs: reviews.rows.map((r) => {
        const signed = r.status === "signed" ? lastSign(r.domain) : undefined;
        return {
          domain: r.domain,
          label: labels[r.domain] ?? r.domain,
          status: r.status,
          reviewer: r.reviewer_id ? { id: r.reviewer_id, name: r.reviewer_name } : null,
          at: new Date(r.updated_at),
          fromDraft: typeof signed?.payload.fromDraft === "string" ? (signed.payload.fromDraft as DraftUse) : null,
          hash: signed?.hash ?? null,
        };
      }),
      conditions: conditions.rows.map((c) => ({ id: c.id, text: c.body, due: c.due, state: c.state })),
      fastLane: fast
        ? { policyId: String(fast.payload.fastLanePolicyId), accountableApprover: String(fast.payload.accountableApprover) }
        : null,
    };
  }

  return {
    /** The audit log as this viewer may see it, newest first unless asked otherwise, and whether the chain verifies. */
    auditLog(actor: Principal, query: EventQuery = {}): Promise<{ events: HistoryEntry[]; chain: ChainStatus }> {
      return k.inTenant(actor, async (tx) => ({ events: await events(tx, actor, query), chain: await chainStatus(tx) }));
    },

    /** Everything that happened to one asset and its cases, oldest first. */
    assetHistory(actor: Principal, assetId: string): Promise<HistoryEntry[]> {
      return k.inTenant(actor, async (tx) => {
        await k.loadAsset(tx, actor, assetId);
        return events(tx, actor, { assetId, order: "asc", limit: 1000 });
      });
    },

    /** Cases by number ("CASE-0142", "142") or by asset name, newest first. */
    findCases(actor: Principal, text: string): Promise<CaseMatch[]> {
      return k.inTenant(actor, async (tx) => {
        const query = text.trim().slice(0, 120);
        if (!query) return [];
        const { rows } = await tx.query<CaseRow & { name: string; a_kind: AssetRow["kind"]; a_state: AssetRow["state"]; a_owner: string; a_created: Date }>(
          `SELECT c.*, a.name, a.kind AS a_kind, a.state AS a_state, a.owner_id AS a_owner, a.created_at AS a_created
           FROM cases c JOIN assets a ON a.id = c.asset_id
           WHERE c.number = $1 OR a.name ILIKE $2
           ORDER BY c.number DESC LIMIT 50`,
          [parseCaseLabel(query) ?? 0, `%${query.replace(ILIKE_SPECIAL, "\\$&")}%`],
        );
        return rows
          .filter((r) =>
            canSee(actor, toAsset({ id: r.asset_id, kind: r.a_kind, name: r.name, state: r.a_state, owner_id: r.a_owner, created_at: r.a_created })),
          )
          .slice(0, 20)
          .map((r) => {
            const c = toCase(r);
            return {
              caseId: c.id,
              number: c.number,
              label: caseLabel(c.number),
              assetId: c.assetId,
              assetName: r.name,
              kind: c.kind,
              state: c.state,
              decidedAt: c.decidedAt,
            };
          });
      });
    },

    /** One case as the audit log tells it. */
    caseRecord(actor: Principal, caseId: string): Promise<CaseRecord> {
      return k.inTenant(actor, (tx) => record(tx, actor, caseId));
    },

    /** The latest decisions this viewer may see, newest first. */
    recentDecisions(actor: Principal, limit = 4): Promise<CaseRecord[]> {
      return k.inTenant(actor, async (tx) => {
        const { rows } = await tx.query<{ id: string; asset_id: string; owner_id: string }>(
          `SELECT c.id, c.asset_id, a.owner_id FROM cases c JOIN assets a ON a.id = c.asset_id
           WHERE c.decided_at IS NOT NULL ORDER BY c.decided_at DESC, c.number DESC LIMIT 200`,
        );
        const visible = rows.filter((r) => readsAll(actor) || (actor.kind === "human" && can(actor, "case.read_own") && r.owner_id === actor.userId));
        const records: CaseRecord[] = [];
        for (const row of visible.slice(0, Math.max(0, limit))) records.push(await record(tx, actor, row.id));
        return records;
      });
    },

    /** Every policy pack version the tenant holds, enabled first, newest first. */
    policyPacks(actor: Principal): Promise<PackVersion[]> {
      return k.inTenant(actor, async (tx) => {
        const { rows } = await tx.query<{ pack_id: string; version: string; enabled: boolean; created_at: Date; content: PolicyPack }>(
          "SELECT pack_id, version, enabled, created_at, content FROM policy_packs ORDER BY enabled DESC, pack_id, created_at DESC",
        );
        return rows.map((r) => ({ packId: r.pack_id, version: r.version, enabled: r.enabled, addedAt: new Date(r.created_at), pack: r.content }));
      });
    },

    /**
     * An auditor's evidence pack for one case: the decision, its sign-offs,
     * controls and evidence as they stand, conditions, every event with its
     * hash, and whether the chain verifies. The export itself is audited,
     * with the pack's fingerprint.
     */
    exportEvidencePack(actor: Principal, caseId: string): Promise<{ filename: string; body: string }> {
      return k.inTenant(actor, async (tx) => {
        if (!can(actor, "audit.export")) throw new GovernanceError("forbidden", "exporting evidence needs audit.export");
        const r = await record(tx, actor, caseId);
        const cases = await k.loadCases(tx, r.asset.id);
        const view = await assurance.view(tx, actor, r.asset, cases);
        const chain = await chainStatus(tx);
        const at = k.now();
        const person = (p: Person | null) => (p ? { id: p.id, name: p.name } : null);
        const pack = {
          format: "aegis.evidence-pack/1",
          generatedAt: at.toISOString(),
          case: {
            id: r.case.id,
            label: r.label,
            kind: r.case.kind,
            trigger: r.case.trigger,
            state: r.case.state,
            openedAt: r.case.createdAt.toISOString(),
            decidedAt: r.case.decidedAt?.toISOString() ?? null,
            policy: `${r.case.packId}@${r.case.packVersion}`,
            tier: r.case.tier,
            tierRule: r.tierRule,
            triage: r.case.triage,
            answers: r.case.answers,
            fastLane: r.fastLane,
          },
          asset: { id: r.asset.id, name: r.asset.name, kind: r.asset.kind, state: r.asset.state, owner: r.ownerName },
          decision: r.decision
            ? {
                action: r.decision.action,
                state: r.decision.after,
                at: r.decision.at.toISOString(),
                by: { kind: r.decision.actor.kind, id: r.decision.actor.id, name: r.decision.actor.name },
                reason: r.decision.reason,
                reasonStatus: r.decision.reasonStatus,
                hash: r.decision.hash,
              }
            : null,
          signoffs: r.signoffs.map((s) => ({ ...s, at: s.at.toISOString(), reviewer: person(s.reviewer) })),
          controlsAsOfExport: view.controls.map((c) => ({
            id: c.id,
            name: c.name,
            domain: c.domain,
            enforcement: c.enforcement,
            covered: c.covered,
            evidence: c.evidence.map((e) => ({
              kind: e.kind,
              title: e.title,
              url: e.url,
              detail: e.detail,
              addedBy: person(e.addedBy),
              addedAt: e.addedAt.toISOString(),
            })),
            exception: c.exception
              ? {
                  state: c.exception.state,
                  reason: c.exception.reason,
                  days: c.exception.days,
                  expiresAt: c.exception.expiresAt?.toISOString() ?? null,
                  requestedBy: person(c.exception.requestedBy),
                  decidedBy: person(c.exception.decidedBy),
                }
              : null,
          })),
          conditions: r.conditions,
          events: r.events.map((e) => ({
            id: e.id,
            at: e.at.toISOString(),
            action: e.action,
            before: e.before,
            after: e.after,
            actor: e.actor,
            reason: e.reason,
            reasonStatus: e.reasonStatus,
            payload: e.payload,
            hash: e.hash,
          })),
          chain,
        };
        const body = JSON.stringify(pack, null, 2);
        await appendAudit(tx, {
          assetId: r.asset.id,
          caseId: r.case.id,
          actorKind: actor.kind,
          actorId: actorId(actor),
          action: "audit.export",
          payload: { format: pack.format, contentSha256: sha256Hex(body) },
          at,
        });
        return { filename: `${r.label}-evidence-pack.json`, body };
      });
    },
  };
}

export type Records = ReturnType<typeof createRecords>;
