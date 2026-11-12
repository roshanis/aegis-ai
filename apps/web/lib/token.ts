import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Signed cookies: a JSON payload and its HMAC. A visitor can read their own
 * token but cannot forge one for another tenant or person. Each kind of
 * token signs under its own label, so one can never be replayed as another.
 */
export interface SessionPayload {
  /** Tenant id. */
  readonly t: string;
  /** User id. */
  readonly u: string;
  /** Expiry, in milliseconds since the epoch. */
  readonly exp: number;
}

/** A sign-in under way at a tenant's provider, kept until the provider sends the person back. */
export interface PendingSignIn {
  /** Tenant slug. */
  readonly o: string;
  readonly state: string;
  readonly nonce: string;
  /** PKCE code verifier. */
  readonly v: string;
  readonly exp: number;
}

const mac = (label: string, body: string, secret: string) =>
  createHmac("sha256", secret).update(`${label}.${body}`).digest("base64url");

function sign(label: string, payload: object, secret: string): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${mac(label, body, secret)}`;
}

function verify(label: string, token: string, secret: string, now: number): Record<string, unknown> | null {
  const [body, signature, extra] = token.split(".");
  if (!body || !signature || extra !== undefined) return null;
  const expected = Buffer.from(mac(label, body, secret));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString()) as Record<string, unknown>;
    if (typeof payload.exp !== "number" || payload.exp <= now) return null;
    return payload;
  } catch {
    return null;
  }
}

const strings = (payload: Record<string, unknown>, keys: readonly string[]) => keys.every((k) => typeof payload[k] === "string");

export function signSession(payload: SessionPayload, secret: string): string {
  return sign("session", payload, secret);
}

export function verifySession(token: string, secret: string, now: number = Date.now()): SessionPayload | null {
  const payload = verify("session", token, secret, now);
  return payload && strings(payload, ["t", "u"]) ? (payload as unknown as SessionPayload) : null;
}

export function signPending(payload: PendingSignIn, secret: string): string {
  return sign("sso", payload, secret);
}

export function verifyPending(token: string, secret: string, now: number = Date.now()): PendingSignIn | null {
  const payload = verify("sso", token, secret, now);
  return payload && strings(payload, ["o", "state", "nonce", "v"]) ? (payload as unknown as PendingSignIn) : null;
}
