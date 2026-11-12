import { randomUUID } from "node:crypto";
import { appendAudit, withTenant, type Connection, type Database } from "@aegis/db";
import { ROLES, roleConflicts, tenantId, type Role, type TenantId, type UserId } from "@aegis/domain";
import { GovernanceError } from "./errors";
import { openSecret, sealSecret, type Keyring } from "./secrets";

/**
 * Single sign-on through each customer tenant's own OpenID Connect provider.
 * Aegis keeps no passwords: the provider proves who someone is, and the
 * tenant's own records say whether they may come in and what they may do.
 *
 * The protocol (discovery, PKCE, ID token checks) lives in the web app; this
 * module holds the tenant's settings and the decision on an identity the
 * provider has already vouched for.
 */

const SECRET_PURPOSE = "sso.client_secret";
const SLUG = /^[a-z0-9][a-z0-9-]{1,62}$/;
const DOMAIN = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** What the sign-in flow needs to talk to a tenant's provider. */
export interface SsoConfig {
  readonly tenantId: TenantId;
  readonly tenantName: string;
  readonly slug: string;
  readonly issuer: string;
  readonly clientId: string;
  /** Null for a public client, which relies on PKCE alone. */
  readonly clientSecret: string | null;
  readonly emailDomains: readonly string[];
}

/** The settings an admin sees. The client secret never leaves the server. */
export interface SsoSettings {
  readonly issuer: string;
  readonly clientId: string;
  readonly hasClientSecret: boolean;
  readonly emailDomains: readonly string[];
  /** Roles for people who sign in without being added; null means they must be added first. */
  readonly joinRoles: readonly Role[] | null;
  readonly updatedAt: Date;
}

export interface SsoInput {
  readonly issuer: string;
  readonly clientId: string;
  readonly clientSecret?: string | null;
  readonly emailDomains: readonly string[];
  readonly joinRoles?: readonly Role[] | null;
}

/** Who the provider says signed in, after the web app has checked the ID token. */
export interface SsoIdentity {
  readonly issuer: string;
  readonly subject: string;
  readonly email: string;
  /** The provider's email_verified claim; absent when it does not send one. */
  readonly emailVerified?: boolean;
  readonly name?: string;
}

export type SsoRefusal =
  /** The tenant has no provider, or the identity came from another one. */
  | "not_configured"
  /** The address is not at one of the tenant's domains, or the provider says it is unverified. */
  | "email"
  /** Nobody in the tenant has this address, and the tenant does not let people join on their own. */
  | "not_invited"
  /** An admin switched this person off. */
  | "inactive"
  /** The address belongs to a person already linked to a different identity at the provider. */
  | "conflict";

export type SsoOutcome = { readonly ok: true; readonly userId: UserId } | { readonly ok: false; readonly reason: SsoRefusal };

export function normalizeDomains(domains: readonly string[]): string[] {
  const clean = [...new Set(domains.map((d) => d.trim().toLowerCase().replace(/^@/, "")).filter(Boolean))];
  if (clean.length === 0) throw new GovernanceError("invalid", "name at least one email domain");
  const bad = clean.filter((d) => !DOMAIN.test(d));
  if (bad.length > 0) throw new GovernanceError("invalid", `not an email domain: ${bad.join(", ")}`);
  return clean.sort();
}

function validIssuer(issuer: string, allowHttp: boolean): string {
  let url: URL;
  try {
    url = new URL(issuer.trim());
  } catch {
    throw new GovernanceError("invalid", "the issuer must be a URL");
  }
  // Plain http only for a test provider on this machine.
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(allowHttp && loopback && url.protocol === "http:")) {
    throw new GovernanceError("invalid", "the issuer must use https");
  }
  if (url.search || url.hash || url.username || url.password) {
    throw new GovernanceError("invalid", "the issuer cannot carry a query, fragment or credentials");
  }
  // Issuers compare as exact strings, so keep what was typed apart from surrounding space.
  return issuer.trim();
}

function validJoinRoles(roles: readonly Role[] | null | undefined): Role[] | null {
  if (roles === null || roles === undefined) return null;
  const unknown = roles.filter((r) => !ROLES.includes(r));
  if (unknown.length > 0) throw new GovernanceError("invalid", `unknown roles: ${unknown.join(", ")}`);
  if (roles.length === 0) throw new GovernanceError("invalid", "give people who join at least one role, or require an invitation");
  // Self-service sign-up must never grant authority over other people's work.
  const elevated = roles.filter((r) => r === "admin" || r === "approver");
  if (elevated.length > 0) throw new GovernanceError("invalid", `people cannot join as ${elevated.join(" or ")}; add them instead`);
  const conflicts = roleConflicts(roles);
  if (conflicts.length > 0) throw new GovernanceError("invalid", conflicts.join("; "));
  return [...new Set(roles)];
}

/**
 * Set or replace a tenant's provider. Runs on the platform connection (the
 * migration owner), like provisioning: a tenant cannot point its own sign-in
 * somewhere else from inside the console.
 */
export async function configureSso(
  platform: Connection,
  ring: Keyring,
  slug: string,
  input: SsoInput,
  /** allowHttpIssuer admits http://localhost issuers, for test providers. */
  options: { readonly at?: Date; readonly allowHttpIssuer?: boolean } = {},
): Promise<TenantId> {
  const at = options.at ?? new Date();
  const issuer = validIssuer(input.issuer, options.allowHttpIssuer ?? false);
  const clientId = input.clientId.trim();
  if (!clientId || clientId.length > 512) throw new GovernanceError("invalid", "give the client ID the provider issued");
  const emailDomains = normalizeDomains(input.emailDomains);
  const joinRoles = validJoinRoles(input.joinRoles);

  const { rows } = await platform.query<{ id: string; sandbox_expires_at: Date | null }>(
    "SELECT id, sandbox_expires_at FROM tenants WHERE slug = $1",
    [slug],
  );
  const row = rows[0];
  if (!row) throw new GovernanceError("not_found", `no tenant ${slug}`);
  if (row.sandbox_expires_at) throw new GovernanceError("invalid", "sandboxes do not use single sign-on");
  const tenant = tenantId(row.id);

  await platform.exec("BEGIN");
  try {
    await platform.query("SELECT set_config('app.tenant_id', $1, true)", [tenant]);
    const sealed = input.clientSecret ? await sealSecret(platform, ring, tenant, SECRET_PURPOSE, input.clientSecret, at) : null;
    await platform.query(
      `INSERT INTO tenant_sso (tenant_id, issuer, client_id, client_secret_sealed, email_domains, join_roles, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (tenant_id) DO UPDATE SET issuer = $2, client_id = $3, client_secret_sealed = $4,
         email_domains = $5, join_roles = $6, updated_at = $7`,
      [tenant, issuer, clientId, sealed, emailDomains, joinRoles, at.toISOString()],
    );
    await appendAudit(platform, {
      actorKind: "system",
      actorId: "system:provisioning",
      action: "tenant.sso",
      payload: { issuer, clientId, confidential: sealed !== null, emailDomains, joinRoles },
      at,
    });
    await platform.exec("COMMIT");
  } catch (error) {
    await platform.exec("ROLLBACK");
    throw error;
  }
  return tenant;
}

/**
 * The provider settings for the tenant at `slug`, or null when it has none.
 * Sandboxes never sign in this way.
 */
export async function ssoConfig(db: Database, ring: Keyring, slug: string): Promise<SsoConfig | null> {
  if (!SLUG.test(slug)) return null;
  return db.run(async (conn) => {
    // Finding a tenant by name happens before anyone is inside one: the platform connection.
    const { rows } = await conn.query<{ id: string; name: string }>(
      "SELECT id, name FROM tenants WHERE slug = $1 AND sandbox_expires_at IS NULL",
      [slug],
    );
    const row = rows[0];
    if (!row) return null;
    const tenant = tenantId(row.id);
    return withTenant(conn, tenant, async (tx) => {
      const { rows: sso } = await tx.query<{
        issuer: string;
        client_id: string;
        client_secret_sealed: string | null;
        email_domains: string[];
      }>("SELECT issuer, client_id, client_secret_sealed, email_domains FROM tenant_sso");
      const s = sso[0];
      if (!s) return null;
      const clientSecret = s.client_secret_sealed
        ? await openSecret(tx, ring, tenant, SECRET_PURPOSE, s.client_secret_sealed)
        : null;
      if (s.client_secret_sealed && clientSecret === null) {
        throw new GovernanceError("conflict", "this tenant's client secret cannot be read; set it again");
      }
      return {
        tenantId: tenant,
        tenantName: row.name,
        slug,
        issuer: s.issuer,
        clientId: s.client_id,
        clientSecret,
        emailDomains: s.email_domains,
      };
    });
  });
}

export async function loadSsoSettings(tx: Connection): Promise<SsoSettings | null> {
  const { rows } = await tx.query<{
    issuer: string;
    client_id: string;
    client_secret_sealed: string | null;
    email_domains: string[];
    join_roles: Role[] | null;
    updated_at: Date;
  }>("SELECT issuer, client_id, client_secret_sealed, email_domains, join_roles, updated_at FROM tenant_sso");
  const s = rows[0];
  if (!s) return null;
  return {
    issuer: s.issuer,
    clientId: s.client_id,
    hasClientSecret: s.client_secret_sealed !== null,
    emailDomains: s.email_domains,
    joinRoles: s.join_roles,
    updatedAt: new Date(s.updated_at),
  };
}

const emailDomain = (email: string) => email.slice(email.lastIndexOf("@") + 1).toLowerCase();

/**
 * Decide whether the person the provider vouched for may come in, and as
 * whom. A person already linked is found by the provider's subject; the
 * first time, by email, and the subject is linked then. With join roles set,
 * someone at the tenant's domains who has not been added joins with those
 * roles. Every way in is audited; refusals are not, so nobody outside the
 * tenant can write to its audit log.
 */
export async function ssoSignIn(
  db: Database,
  tenant: TenantId,
  identity: SsoIdentity,
  at: Date = new Date(),
): Promise<SsoOutcome> {
  const email = identity.email.trim();
  const refuse = (reason: SsoRefusal): SsoOutcome => ({ ok: false, reason });
  return db.run((conn) =>
    withTenant(conn, tenant, async (tx) => {
      const settings = await loadSsoSettings(tx);
      if (!settings || settings.issuer !== identity.issuer || !identity.subject) return refuse("not_configured");
      if (!email.includes("@") || identity.emailVerified === false) return refuse("email");
      if (!settings.emailDomains.includes(emailDomain(email))) return refuse("email");

      type Row = { id: string; active: boolean; sso_subject: string | null };
      const bySubject = await tx.query<Row>("SELECT id, active, sso_subject FROM users WHERE sso_subject = $1", [
        identity.subject,
      ]);
      let person = bySubject.rows[0];
      let linked = false;
      if (!person) {
        const byEmail = await tx.query<Row>("SELECT id, active, sso_subject FROM users WHERE lower(email) = lower($1)", [email]);
        person = byEmail.rows[0];
        // Someone else at the provider already claimed this person; a reissued address must not take over.
        if (person?.sso_subject) return refuse("conflict");
        linked = person !== undefined;
      }

      if (person && !person.active) return refuse("inactive");

      let joined = false;
      let id: string;
      if (person) {
        id = person.id;
        await tx.query(
          "UPDATE users SET last_sign_in_at = $2, sso_subject = coalesce(sso_subject, $3) WHERE id = $1",
          [id, at.toISOString(), identity.subject],
        );
      } else {
        if (!settings.joinRoles) return refuse("not_invited");
        id = randomUUID();
        const displayName = identity.name?.trim().slice(0, 120) || email.slice(0, email.indexOf("@"));
        await tx.query(
          `INSERT INTO users (id, tenant_id, email, display_name, roles, sso_subject, last_sign_in_at)
           VALUES ($1, current_tenant_id(), $2, $3, $4, $5, $6)`,
          [id, email, displayName, settings.joinRoles, identity.subject, at.toISOString()],
        );
        joined = true;
      }

      if (joined) {
        await appendAudit(tx, {
          actorKind: "system",
          actorId: "system:sso",
          action: "user.join",
          payload: { userId: id, roles: [...settings.joinRoles!] },
          at,
        });
      }
      await appendAudit(tx, {
        actorKind: "human",
        actorId: id,
        action: "user.sign_in",
        payload: { method: "oidc", issuer: settings.issuer, ...(linked ? { linked: true } : {}) },
        at,
      });
      return { ok: true, userId: id as UserId };
    }),
  );
}
