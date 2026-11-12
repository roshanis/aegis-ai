import type { Connection } from "./connection";

export interface RateLimit {
  readonly limit: number;
  readonly windowMs: number;
}

/**
 * Count one hit against `bucket` in the current fixed window, on the
 * platform connection. Returns whether it is within the limit and, when
 * not, how many seconds until the window turns. Windows older than a day
 * are pruned as it goes.
 */
export async function takeRateToken(
  conn: Connection,
  bucket: string,
  { limit, windowMs }: RateLimit,
  at: Date = new Date(),
): Promise<{ ok: boolean; retryAfter: number }> {
  const start = new Date(Math.floor(at.getTime() / windowMs) * windowMs);
  const { rows } = await conn.query<{ hits: number }>(
    `INSERT INTO rate_limits (bucket, window_start, hits) VALUES ($1, $2, 1)
     ON CONFLICT (bucket, window_start) DO UPDATE SET hits = rate_limits.hits + 1
     RETURNING hits`,
    [bucket, start.toISOString()],
  );
  if (Math.random() < 0.02) {
    await conn.query("DELETE FROM rate_limits WHERE window_start < $1", [new Date(at.getTime() - 86_400_000).toISOString()]);
  }
  const hits = rows[0]?.hits ?? 1;
  return { ok: hits <= limit, retryAfter: Math.max(1, Math.ceil((start.getTime() + windowMs - at.getTime()) / 1000)) };
}
