import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Session tokens: a payload and its HMAC. A visitor can read their own
 * token but cannot forge one for another tenant or person.
 */
export interface SessionPayload {
  /** Tenant id. */
  readonly t: string;
  /** User id. */
  readonly u: string;
  /** Expiry, in milliseconds since the epoch. */
  readonly exp: number;
}

const mac = (body: string, secret: string) => createHmac("sha256", secret).update(body).digest("base64url");

export function signSession(payload: SessionPayload, secret: string): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${mac(body, secret)}`;
}

export function verifySession(token: string, secret: string, now: number = Date.now()): SessionPayload | null {
  const [body, signature, extra] = token.split(".");
  if (!body || !signature || extra !== undefined) return null;
  const expected = Buffer.from(mac(body, secret));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString()) as SessionPayload;
    if (typeof payload.t !== "string" || typeof payload.u !== "string" || typeof payload.exp !== "number") return null;
    return payload.exp > now ? payload : null;
  } catch {
    return null;
  }
}
