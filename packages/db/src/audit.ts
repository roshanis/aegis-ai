import { createHash } from "node:crypto";
import type { Connection } from "./connection";

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Codes and identifiers only. Free text belongs in a note, referenced by id and hash. */
export type AuditPayload = Readonly<Record<string, string | number | boolean | null | readonly string[]>>;

export interface AuditEntry {
  readonly assetId?: string;
  readonly caseId?: string;
  readonly actorKind: "human" | "system" | "agent";
  readonly actorId: string;
  readonly action: string;
  readonly before?: string | null;
  readonly after?: string | null;
  readonly note?: { readonly id: string; readonly body: string };
  readonly payload?: AuditPayload;
  readonly at: Date;
}

/** Append one event to the current tenant's chain. The database computes the hash. */
export async function appendAudit(tx: Connection, entry: AuditEntry): Promise<void> {
  await tx.query(
    `INSERT INTO audit_events
       (tenant_id, asset_id, case_id, actor_kind, actor_id, action, before_state, after_state,
        note_id, note_sha256, payload, at)
     VALUES (current_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      entry.assetId ?? null,
      entry.caseId ?? null,
      entry.actorKind,
      entry.actorId,
      entry.action,
      entry.before ?? null,
      entry.after ?? null,
      entry.note?.id ?? null,
      entry.note ? sha256Hex(entry.note.body) : null,
      JSON.stringify(entry.payload ?? {}),
      entry.at.toISOString(),
    ],
  );
}

/**
 * Recompute a tenant's audit hash chain; returns the first broken event id,
 * or null. With `from`, only events after that verified point are walked,
 * the first of them chained to its hash.
 */
export async function verifyAuditChain(tx: Connection, from?: { readonly throughId: number; readonly throughHash: string }): Promise<number | null> {
  const { rows } = await tx.query<{ id: string; ok: boolean }>(
    `SELECT id, hash = audit_hash(e, coalesce(lag(hash) OVER (ORDER BY id), $2::text))
           AND prev_hash IS NOT DISTINCT FROM coalesce(lag(hash) OVER (ORDER BY id), $2::text) AS ok
     FROM audit_events e
     WHERE id > $1
     ORDER BY id`,
    [from?.throughId ?? 0, from?.throughHash ?? null],
  );
  const broken = rows.find((r) => !r.ok);
  return broken ? Number(broken.id) : null;
}

export interface ChainCheck {
  /** The first event whose hash no longer matches, if any. */
  readonly brokenAt: number | null;
  /** Events walked this time; the rest were verified before, up to the checkpoint. */
  readonly walked: number;
  readonly events: number;
  readonly latest: string | null;
}

/**
 * Verify the chain from the latest checkpoint, and record a new one when
 * at least `every` events have been verified since. The checkpointed event
 * must still carry its hash, or the chain reads as broken there. `full`
 * ignores checkpoints and walks everything.
 */
export async function checkAuditChain(tx: Connection, at: Date, options: { readonly full?: boolean; readonly every?: number } = {}): Promise<ChainCheck> {
  const every = options.every ?? 100;
  const { rows: head } = await tx.query<{ id: string | null; hash: string | null; n: number }>(
    "SELECT (SELECT id FROM audit_events ORDER BY id DESC LIMIT 1) AS id, (SELECT hash FROM audit_events ORDER BY id DESC LIMIT 1) AS hash, (SELECT count(*)::int FROM audit_events) AS n",
  );
  const latestId = head[0]?.id ? Number(head[0].id) : 0;
  const latest = head[0]?.hash ?? null;
  const events = head[0]?.n ?? 0;

  let from: { throughId: number; throughHash: string } | undefined;
  if (!options.full) {
    const { rows } = await tx.query<{ through_id: string; through_hash: string; still: string | null }>(
      `SELECT c.through_id, c.through_hash, e.hash AS still
       FROM audit_checkpoints c LEFT JOIN audit_events e ON e.id = c.through_id
       ORDER BY c.through_id DESC LIMIT 1`,
    );
    const cp = rows[0];
    if (cp) {
      if (cp.still !== cp.through_hash) return { brokenAt: Number(cp.through_id), walked: 0, events, latest };
      from = { throughId: Number(cp.through_id), throughHash: cp.through_hash };
    }
  }
  const brokenAt = await verifyAuditChain(tx, from);
  const walkedFrom = from?.throughId ?? 0;
  const { rows: walkedRows } = await tx.query<{ n: number }>("SELECT count(*)::int AS n FROM audit_events WHERE id > $1", [walkedFrom]);
  const walked = walkedRows[0]?.n ?? 0;
  if (brokenAt === null && latest && walked >= every) {
    await tx.query(
      `INSERT INTO audit_checkpoints (tenant_id, through_id, through_hash, events, verified_at)
       VALUES (current_tenant_id(), $1, $2, $3, $4) ON CONFLICT DO NOTHING`,
      [latestId, latest, events, at.toISOString()],
    );
  }
  return { brokenAt, walked, events, latest };
}
