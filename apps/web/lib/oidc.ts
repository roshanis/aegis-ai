import "server-only";
import { ssoConfig, type SsoConfig } from "@aegis/core";
import * as client from "openid-client";
import { runtime } from "./runtime";

/**
 * OpenID Connect against each customer tenant's own provider: discovery,
 * the authorization code flow with PKCE (S256), and ID token checks
 * (signature, issuer, audience, expiry, nonce) by openid-client. What the
 * person may do once the provider vouches for them is decided in
 * @aegis/core's ssoSignIn, never here.
 */

/** Plain http only to a test provider on this machine, and only when AEGIS_SSO_ALLOW_HTTP=1. */
function insecureAllowed(issuer: string): boolean {
  if (process.env.AEGIS_SSO_ALLOW_HTTP !== "1") return false;
  const url = new URL(issuer);
  return url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
}

/** The console's public origin. Required in production, where the request's own host cannot be trusted. */
export function publicOrigin(requestUrl: string): string {
  const configured = process.env.AEGIS_PUBLIC_URL;
  if (configured) return new URL(configured).origin;
  if (process.env.NODE_ENV === "production") throw new Error("Set AEGIS_PUBLIC_URL to the console's public URL.");
  return new URL(requestUrl).origin;
}

/** The one redirect URI every tenant registers with its provider. */
export const callbackUrl = (origin: string) => `${origin}/sso/callback`;

const DISCOVERY_TTL_MS = 10 * 60_000;
const discovered = new Map<string, { at: number; config: client.Configuration }>();

async function configuration(sso: SsoConfig): Promise<client.Configuration> {
  const key = `${sso.tenantId}|${sso.issuer}|${sso.clientId}|${sso.clientSecret ?? ""}`;
  const hit = discovered.get(key);
  if (hit && Date.now() - hit.at < DISCOVERY_TTL_MS) return hit.config;
  const options: client.DiscoveryRequestOptions = {
    timeout: 10,
    ...(insecureAllowed(sso.issuer) ? { execute: [client.allowInsecureRequests] } : {}),
  };
  const config = await client.discovery(
    new URL(sso.issuer),
    sso.clientId,
    sso.clientSecret ?? undefined,
    sso.clientSecret ? client.ClientSecretPost(sso.clientSecret) : client.None(),
    options,
  );
  discovered.set(key, { at: Date.now(), config });
  return config;
}

export async function tenantSso(slug: string): Promise<SsoConfig | null> {
  const { db, keys } = await runtime();
  return ssoConfig(db, keys, slug);
}

export interface Started {
  readonly url: URL;
  readonly state: string;
  readonly nonce: string;
  readonly verifier: string;
}

/** Where to send the person, and what to remember until they come back. */
export async function startSignIn(sso: SsoConfig, origin: string): Promise<Started> {
  const config = await configuration(sso);
  const verifier = client.randomPKCECodeVerifier();
  const state = client.randomState();
  const nonce = client.randomNonce();
  const url = client.buildAuthorizationUrl(config, {
    redirect_uri: callbackUrl(origin),
    scope: "openid email profile",
    response_type: "code",
    code_challenge: await client.calculatePKCECodeChallenge(verifier),
    code_challenge_method: "S256",
    state,
    nonce,
  });
  return { url, state, nonce, verifier };
}

export interface Verified {
  readonly issuer: string;
  readonly subject: string;
  readonly email: string;
  readonly emailVerified?: boolean;
  readonly name?: string;
}

/** Exchange the code and check the ID token. Throws if anything does not match. */
export async function finishSignIn(
  sso: SsoConfig,
  origin: string,
  search: string,
  pending: { state: string; nonce: string; verifier: string },
): Promise<Verified> {
  const config = await configuration(sso);
  const current = new URL(`${callbackUrl(origin)}${search}`);
  const tokens = await client.authorizationCodeGrant(config, current, {
    pkceCodeVerifier: pending.verifier,
    expectedState: pending.state,
    expectedNonce: pending.nonce,
    idTokenExpected: true,
  });
  const claims = tokens.claims();
  if (!claims) throw new Error("the provider sent no ID token");
  const email = typeof claims.email === "string" ? claims.email : "";
  const name = typeof claims.name === "string" ? claims.name : undefined;
  return {
    issuer: claims.iss,
    subject: claims.sub,
    email,
    ...(typeof claims.email_verified === "boolean" ? { emailVerified: claims.email_verified } : {}),
    ...(name ? { name } : {}),
  };
}
