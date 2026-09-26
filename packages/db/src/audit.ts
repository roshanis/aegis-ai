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

/** Recompute a tenant's audit hash chain; returns the first broken event id, or null. */
export async function verifyAuditChain(tx: Connection): Promise<number | null> {
  const { rows } = await tx.query<{ id: string; ok: boolean }>(`
    SELECT id, hash = audit_hash(e, lag(hash) OVER (ORDER BY id))
           AND prev_hash IS NOT DISTINCT FROM lag(hash) OVER (ORDER BY id) AS ok
    FROM audit_events e
    ORDER BY id`);
  const broken = rows.find((r) => !r.ok);
  return broken ? Number(broken.id) : null;
}
