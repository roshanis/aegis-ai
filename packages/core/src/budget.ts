import { createHash } from "node:crypto";
import type { Connection } from "@aegis/db";

/**
 * Token controls for a tenant's agents. The tenant pays for every model
 * call, so Aegis checks what a call would add before making it: cached and
 * unchanged answers cost nothing, and admins cap monthly and per-person use.
 */

export const DEFAULT_DAILY_INTAKE_PER_PERSON = 30;

export interface Budget {
  /** Input plus output tokens per calendar month (UTC); null means no cap. */
  readonly monthlyTokens: number | null;
  readonly dailyIntakePerPerson: number;
}

export interface TokenUsage {
  readonly budget: Budget;
  readonly monthTokens: number;
  readonly monthCalls: number;
  /** Requests answered from cache or an unchanged draft, with no model call. */
  readonly monthReused: number;
  readonly monthStart: Date;
}

export const monthStart = (at: Date) => new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1));
export const dayStart = (at: Date) => new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));

/** A stable digest of what a model call would see, for skipping repeat calls. */
export function inputHash(...parts: readonly unknown[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

export async function loadBudget(tx: Connection): Promise<Budget> {
  const { rows } = await tx.query<{ monthly_tokens: number | null; daily_intake_per_person: number }>(
    "SELECT monthly_tokens, daily_intake_per_person FROM agent_budgets",
  );
  return {
    monthlyTokens: rows[0]?.monthly_tokens ?? null,
    dailyIntakePerPerson: rows[0]?.daily_intake_per_person ?? DEFAULT_DAILY_INTAKE_PER_PERSON,
  };
}

export async function tokenUsage(tx: Connection, at: Date): Promise<TokenUsage> {
  const start = monthStart(at);
  const [budget, { rows }] = await Promise.all([
    loadBudget(tx),
    tx.query<{ tokens: string | null; calls: string; reused: string }>(
      `SELECT sum(coalesce(input_tokens, 0) + coalesce(output_tokens, 0)) AS tokens,
              count(*) FILTER (WHERE NOT result ? 'reused') AS calls,
              count(*) FILTER (WHERE result ? 'reused') AS reused
       FROM agent_runs WHERE started_at >= $1`,
      [start.toISOString()],
    ),
  ]);
  return {
    budget,
    monthTokens: Number(rows[0]?.tokens ?? 0),
    monthCalls: Number(rows[0]?.calls ?? 0),
    monthReused: Number(rows[0]?.reused ?? 0),
    monthStart: start,
  };
}

/** Why a new model call must not start, or null when it may. */
export async function monthlyBlock(tx: Connection, at: Date): Promise<string | null> {
  const usage = await tokenUsage(tx, at);
  const cap = usage.budget.monthlyTokens;
  return cap !== null && usage.monthTokens >= cap ? "budget" : null;
}

/** Intake requests this person made today that reached the model. */
export async function intakeCallsToday(tx: Connection, userId: string, at: Date): Promise<number> {
  const { rows } = await tx.query<{ n: string }>(
    `SELECT count(*) AS n FROM agent_runs
     WHERE purpose = 'intake' AND requested_by = $1 AND started_at >= $2 AND NOT result ? 'reused'`,
    [userId, dayStart(at).toISOString()],
  );
  return Number(rows[0]?.n ?? 0);
}

/**
 * A small time-limited cache of intake answers per tenant, so asking again
 * about the same description, on the same model and pack, costs nothing.
 * Process-local: a miss on another instance only costs one call.
 */
export class AnswerCache<T> {
  private readonly entries = new Map<string, { value: T; expires: number }>();

  constructor(
    private readonly ttlMs = 30 * 60_000,
    private readonly max = 500,
  ) {}

  get(key: string, now: number): T | undefined {
    const hit = this.entries.get(key);
    if (!hit) return undefined;
    if (hit.expires <= now) {
      this.entries.delete(key);
      return undefined;
    }
    return hit.value;
  }

  set(key: string, value: T, now: number): void {
    this.entries.delete(key);
    this.entries.set(key, { value, expires: now + this.ttlMs });
    while (this.entries.size > this.max) this.entries.delete(this.entries.keys().next().value!);
  }
}
