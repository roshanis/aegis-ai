import "server-only";
import { createHmac, randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { signPending, signSession, verifyPending, verifySession, type PendingSignIn, type SessionPayload } from "./token";

const COOKIE = "aegis_session";
const PENDING = "aegis_sso";
/** How long a person has at their provider before the sign-in must start again. */
const PENDING_MS = 10 * 60_000;
const cache = globalThis as unknown as { aegisDevSecret?: string };

function secret(): string {
  const configured = process.env.AEGIS_SESSION_SECRET;
  if (configured && configured.length >= 32) return configured;
  if (process.env.NODE_ENV === "production") {
    throw new Error("Set AEGIS_SESSION_SECRET to at least 32 random characters.");
  }
  // Development only: sessions last until the dev server restarts.
  cache.aegisDevSecret ??= randomBytes(32).toString("hex");
  return cache.aegisDevSecret;
}

/**
 * A stable, unguessable stand-in for a client's address, for rate limits:
 * the address itself is never stored.
 */
export function clientKey(address: string): string {
  return createHmac("sha256", secret()).update(`client.${address}`).digest("hex").slice(0, 32);
}

const secure = () => process.env.NODE_ENV === "production";

/** How long a single sign-on session lasts: AEGIS_SESSION_HOURS, 12 by default, at most 24. */
export function ssoSessionMs(): number {
  const hours = Number(process.env.AEGIS_SESSION_HOURS);
  return (Number.isFinite(hours) && hours > 0 ? Math.min(hours, 24) : 12) * 3_600_000;
}

export async function readSession(): Promise<SessionPayload | null> {
  const token = (await cookies()).get(COOKIE)?.value;
  return token ? verifySession(token, secret()) : null;
}

export async function writeSession(tenant: string, user: string, expires: Date): Promise<void> {
  (await cookies()).set(COOKIE, signSession({ t: tenant, u: user, exp: expires.getTime() }, secret()), {
    httpOnly: true,
    sameSite: "lax",
    secure: secure(),
    path: "/",
    expires,
  });
}

export async function clearSession(): Promise<void> {
  (await cookies()).delete(COOKIE);
}

/**
 * The state, nonce and PKCE verifier of a sign-in under way. Lax, so the
 * provider's top-level redirect back carries it; scoped to /sso.
 */
export async function writePending(pending: Omit<PendingSignIn, "exp">): Promise<void> {
  const exp = Date.now() + PENDING_MS;
  (await cookies()).set(PENDING, signPending({ ...pending, exp }, secret()), {
    httpOnly: true,
    sameSite: "lax",
    secure: secure(),
    path: "/sso",
    expires: new Date(exp),
  });
}

/** Read and forget: each pending sign-in can finish once. */
export async function takePending(): Promise<PendingSignIn | null> {
  const jar = await cookies();
  const token = jar.get(PENDING)?.value;
  jar.delete({ name: PENDING, path: "/sso" });
  return token ? verifyPending(token, secret()) : null;
}
