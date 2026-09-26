import "server-only";
import { randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { signSession, verifySession, type SessionPayload } from "./token";

const COOKIE = "aegis_session";
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

export async function readSession(): Promise<SessionPayload | null> {
  const token = (await cookies()).get(COOKIE)?.value;
  return token ? verifySession(token, secret()) : null;
}

export async function writeSession(tenant: string, user: string, expires: Date): Promise<void> {
  (await cookies()).set(COOKIE, signSession({ t: tenant, u: user, exp: expires.getTime() }, secret()), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    expires,
  });
}

export async function clearSession(): Promise<void> {
  (await cookies()).delete(COOKIE);
}
