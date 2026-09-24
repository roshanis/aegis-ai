/**
 * The minimal connection surface Aegis needs. A dedicated pg client and a
 * PGlite instance both satisfy it, so tests run on in-process Postgres and
 * production runs on any Postgres, in every deployment mode.
 */
export interface Connection {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
  /** Run a multi-statement script with no parameters (migrations). */
  exec(text: string): Promise<unknown>;
}
