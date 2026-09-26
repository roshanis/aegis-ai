import type { Connection } from "./connection";

/**
 * Where connections come from. A transaction needs a connection to itself,
 * so services never share one across concurrent requests: a pool hands out
 * one per call, and a single in-process database (PGlite) runs one call at
 * a time.
 */
export interface Database {
  run<T>(fn: (conn: Connection) => Promise<T>): Promise<T>;
}

/** One connection, one call at a time. For PGlite in development and tests. */
export function serialized(conn: Connection): Database {
  let tail: Promise<unknown> = Promise.resolve();
  return {
    run(fn) {
      const result = tail.then(() => fn(conn));
      tail = result.catch(() => undefined);
      return result;
    },
  };
}

/** The slice of node-postgres' Pool that Aegis uses. */
export interface PoolLike {
  connect(): Promise<{
    query(text: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
    release(): void;
  }>;
}

/**
 * A connection pool, such as node-postgres' Pool: each call gets its own
 * client. Queries on that client run one after another even when a service
 * issues several at once, as a transaction must.
 */
export function pooled(pool: PoolLike): Database {
  return {
    async run(fn) {
      const client = await pool.connect();
      let tail: Promise<unknown> = Promise.resolve();
      const next = <T>(work: () => Promise<T>): Promise<T> => {
        const result = tail.then(work);
        tail = result.catch(() => undefined);
        return result;
      };
      try {
        return await fn({
          query: (text, params) => next(() => client.query(text, params)) as never,
          exec: (text) => next(() => client.query(text)),
        });
      } finally {
        client.release();
      }
    },
  };
}
