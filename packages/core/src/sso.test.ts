import { randomBytes } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { serialized } from "@aegis/db";
import { migrate } from "@aegis/db/migrate";
import { userId, type HumanPrincipal, type TenantId } from "@aegis/domain";
import { healthcareAiPack } from "@aegis/frameworks";
import { beforeAll, describe, expect, it } from "vitest";
import { createGovernance, type Governance } from "./governance";
import { provisionTenant, purgeTenant } from "./provision";
import { createSandbox } from "./sandbox";
import { keyring } from "./secrets";
import { configureSso, ssoConfig, ssoSignIn } from "./sso";

const ISSUER = "https://login.acme-health.test";
const ring = keyring(randomBytes(32));
let db: PGlite;
let gov: Governance;
let tenant: TenantId;
let admin: HumanPrincipal;
let clock = Date.UTC(2026, 10, 12, 12);
const at = () => new Date((clock += 60_000));

const identity = (subject: string, email: string, extra: { name?: string; emailVerified?: boolean } = {}) => ({
  issuer: ISSUER,
  subject,
  email,
  ...extra,
});

async function audit(action: string) {
  const log = await gov.auditLog({ ...admin, roles: ["auditor"] }, { limit: 200 });
  return log.events.filter((e) => e.action === action);
}

beforeAll(async () => {
  db = new PGlite();
  await migrate(db);
  gov = createGovernance(serialized(db), { now: at });
  const provisioned = await provisionTenant(db, {
    tenant: { id: "00000000-0000-4000-8000-0000000000c1", slug: "acme-health", name: "Acme Health" },
    admin: { email: "Ada@Acme-Health.test", displayName: "Ada Admin" },
    packs: [healthcareAiPack],
  });
  tenant = provisioned.tenantId;
  admin = { kind: "human", tenantId: tenant, userId: provisioned.adminId, displayName: "Ada Admin", roles: ["admin"], reviewDomains: [] };
  await configureSso(db, ring, "acme-health", {
    issuer: ISSUER,
    clientId: "aegis-console",
    clientSecret: "s3cret-from-the-idp",
    emailDomains: ["acme-health.test", "@Acme.test"],
  });
}, 60_000);

describe("configuring a provider", () => {
  it("seals the client secret and hands it back only to the sign-in flow", async () => {
    const config = await ssoConfig(serialized(db), ring, "acme-health");
    expect(config).toMatchObject({
      tenantId: tenant,
      tenantName: "Acme Health",
      issuer: ISSUER,
      clientId: "aegis-console",
      clientSecret: "s3cret-from-the-idp",
      emailDomains: ["acme-health.test", "acme.test"],
    });
    const { rows } = await db.query<{ client_secret_sealed: string }>("SELECT client_secret_sealed FROM tenant_sso");
    expect(rows[0]!.client_secret_sealed).not.toContain("s3cret");
    const overview = await gov.people(admin);
    expect(overview.sso).toMatchObject({ issuer: ISSUER, hasClientSecret: true, joinRoles: null });
    expect(JSON.stringify(overview)).not.toContain("s3cret");
  });

  it("refuses plain http, empty domains, self-service admins and sandboxes", async () => {
    const base = { issuer: ISSUER, clientId: "x", emailDomains: ["acme-health.test"] };
    await expect(configureSso(db, ring, "acme-health", { ...base, issuer: "http://login.acme-health.test" })).rejects.toThrow(/https/);
    // Even with http allowed for tests, only a provider on this machine.
    await expect(
      configureSso(db, ring, "acme-health", { ...base, issuer: "http://login.acme-health.test" }, { allowHttpIssuer: true }),
    ).rejects.toThrow(/https/);
    await expect(configureSso(db, ring, "acme-health", { ...base, emailDomains: [" "] })).rejects.toThrow(/domain/);
    await expect(configureSso(db, ring, "acme-health", { ...base, emailDomains: ["not a domain"] })).rejects.toThrow(/domain/);
    await expect(configureSso(db, ring, "acme-health", { ...base, joinRoles: ["approver"] })).rejects.toThrow(/cannot join/);
    await expect(configureSso(db, ring, "acme-health", { ...base, joinRoles: ["admin"] })).rejects.toThrow(/cannot join/);
    await expect(configureSso(db, ring, "nobody", base)).rejects.toThrow(/no tenant/);
    const sandbox = await createSandbox(serialized(db));
    const { rows } = await db.query<{ slug: string }>("SELECT slug FROM tenants WHERE id = $1", [sandbox.tenantId]);
    await expect(configureSso(db, ring, rows[0]!.slug, base)).rejects.toThrow(/sandbox/);
    expect(await ssoConfig(serialized(db), ring, rows[0]!.slug)).toBeNull();
    await purgeTenant(db, sandbox.tenantId);
    // Seeding a sandbox runs the agents' golden sets and a dozen reviews; give it the time the sandbox tests do.
  }, 60_000);

  it("finds nothing for a tenant without a provider or a malformed name", async () => {
    await provisionTenant(db, {
      tenant: { id: "00000000-0000-4000-8000-0000000000c2", slug: "no-sso", name: "No SSO" },
      admin: { email: "admin@no-sso.test", displayName: "Admin" },
      packs: [healthcareAiPack],
    });
    expect(await ssoConfig(serialized(db), ring, "no-sso")).toBeNull();
    expect(await ssoConfig(serialized(db), ring, "../acme-health")).toBeNull();
    expect(await ssoSignIn(serialized(db), tenantIdOf("00000000-0000-4000-8000-0000000000c2"), identity("x", "admin@no-sso.test"))).toEqual({
      ok: false,
      reason: "not_configured",
    });
  });
});

const tenantIdOf = (id: string) => id as TenantId;

describe("signing in", () => {
  it("matches an added person by email, case-insensitively, then by subject, and audits it", async () => {
    const first = await ssoSignIn(serialized(db), tenant, identity("idp|ada", "ada@acme-health.test"), at());
    expect(first).toEqual({ ok: true, userId: admin.userId });
    // The provider's subject now identifies her, even if her address changes.
    const renamed = await ssoSignIn(serialized(db), tenant, identity("idp|ada", "ada.admin@acme.test"), at());
    expect(renamed).toEqual({ ok: true, userId: admin.userId });
    const signIns = await audit("user.sign_in");
    expect(signIns).toHaveLength(2);
    expect(signIns.every((e) => e.actor.id === admin.userId)).toBe(true);
  });

  it("refuses addresses outside the tenant's domains or that the provider has not verified", async () => {
    const db_ = serialized(db);
    expect(await ssoSignIn(db_, tenant, identity("idp|eve", "eve@evil.test"))).toEqual({ ok: false, reason: "email" });
    expect(await ssoSignIn(db_, tenant, identity("idp|eve", "eve@acme-health.test.evil.test"))).toEqual({ ok: false, reason: "email" });
    expect(await ssoSignIn(db_, tenant, identity("idp|eve", "ada@acme-health.test", { emailVerified: false }))).toEqual({
      ok: false,
      reason: "email",
    });
  });

  it("refuses an identity from another issuer", async () => {
    expect(
      await ssoSignIn(serialized(db), tenant, { ...identity("idp|ada", "ada@acme-health.test"), issuer: "https://evil.test" }),
    ).toEqual({ ok: false, reason: "not_configured" });
  });

  it("does not let a second identity take over a linked person through a reused address", async () => {
    expect(await ssoSignIn(serialized(db), tenant, identity("idp|imposter", "ADA@acme-health.test"))).toEqual({
      ok: false,
      reason: "conflict",
    });
  });

  it("turns away people nobody added, unless the tenant lets them join, and never as an admin", async () => {
    expect(await ssoSignIn(serialized(db), tenant, identity("idp|ravi", "ravi@acme-health.test"))).toEqual({
      ok: false,
      reason: "not_invited",
    });
    const before = await audit("user.sign_in");

    await configureSso(db, ring, "acme-health", {
      issuer: ISSUER,
      clientId: "aegis-console",
      clientSecret: "s3cret-from-the-idp",
      emailDomains: ["acme-health.test"],
      joinRoles: ["requester"],
    });
    const joined = await ssoSignIn(serialized(db), tenant, identity("idp|ravi", "ravi@acme-health.test", { name: "Ravi Rao" }), at());
    expect(joined.ok).toBe(true);
    const ravi = (await gov.people(admin)).people.find((p) => p.email === "ravi@acme-health.test");
    expect(ravi).toMatchObject({ displayName: "Ravi Rao", roles: ["requester"], linked: true, active: true });
    expect(await audit("user.join")).toHaveLength(1);
    expect(await audit("user.sign_in")).toHaveLength(before.length + 1);
  });
});

describe("managing people", () => {
  it("adds people, changes their roles, and switches them off, which ends their sessions", async () => {
    const id = await gov.addUser(admin, { email: "rowan@acme-health.test", displayName: "Rowan", roles: ["reviewer"], reviewDomains: ["privacy-hipaa"] });
    await expect(gov.addUser(admin, { email: "ROWAN@acme-health.test", displayName: "Rowan 2", roles: ["reviewer"] })).rejects.toThrow(/already/);
    await expect(gov.addUser(admin, { email: "rowan", displayName: "Rowan 3", roles: ["reviewer"] })).rejects.toThrow(/email/);

    expect(await ssoSignIn(serialized(db), tenant, identity("idp|rowan", "rowan@acme-health.test"), at())).toEqual({ ok: true, userId: id });
    expect(await gov.principal(tenant, id)).toMatchObject({ roles: ["reviewer"], reviewDomains: ["privacy-hipaa"] });

    await gov.updatePerson(admin, id, { roles: ["reviewer", "auditor"], reviewDomains: ["security", "privacy-hipaa"], active: true });
    expect(await gov.principal(tenant, id)).toMatchObject({ roles: ["reviewer", "auditor"], reviewDomains: ["privacy-hipaa", "security"] });

    await gov.updatePerson(admin, id, { roles: ["reviewer", "auditor"], reviewDomains: ["security", "privacy-hipaa"], active: false });
    expect(await gov.principal(tenant, id)).toBeNull();
    expect(await ssoSignIn(serialized(db), tenant, identity("idp|rowan", "rowan@acme-health.test"))).toEqual({ ok: false, reason: "inactive" });

    await gov.updatePerson(admin, id, { roles: ["reviewer"], reviewDomains: ["privacy-hipaa"], active: true });
    expect(await gov.principal(tenant, id)).not.toBeNull();
    const actions = (await gov.auditLog({ ...admin, roles: ["auditor"] }, { limit: 200 })).events.map((e) => e.action);
    expect(actions).toEqual(expect.arrayContaining(["user.add", "user.update", "user.deactivate", "user.reactivate"]));
  });

  it("refuses bad roles, unknown domains, and leaving the tenant without an admin", async () => {
    const id = (await gov.people(admin)).people.find((p) => p.email === "rowan@acme-health.test")!.userId;
    await expect(gov.updatePerson(admin, id, { roles: ["requester", "approver"], reviewDomains: [], active: true })).rejects.toThrow(
      /cannot be held/,
    );
    await expect(gov.updatePerson(admin, id, { roles: ["reviewer"], reviewDomains: ["astrology"], active: true })).rejects.toThrow(
      /unknown review domains/,
    );
    await expect(gov.updatePerson(admin, id, { roles: [], reviewDomains: [], active: true })).rejects.toThrow(/at least one role/);
    await expect(gov.updatePerson(admin, admin.userId, { roles: ["admin"], reviewDomains: [], active: false })).rejects.toThrow(
      /yourself/,
    );
    await expect(gov.updatePerson(admin, admin.userId, { roles: ["auditor"], reviewDomains: [], active: true })).rejects.toThrow(
      /another admin/,
    );

    // A second admin may demote the first, but not the last.
    await gov.updatePerson(admin, id, { roles: ["admin"], reviewDomains: [], active: true });
    const second: HumanPrincipal = { ...admin, userId: userId(id), displayName: "Rowan" };
    await gov.updatePerson(second, admin.userId, { roles: ["auditor"], reviewDomains: [], active: true });
    const ada: HumanPrincipal = { ...admin, roles: ["auditor"] };
    await expect(gov.updatePerson(ada, id, { roles: ["reviewer"], reviewDomains: [], active: true })).rejects.toThrow(/only an admin/);
    await gov.updatePerson(second, admin.userId, { roles: ["admin"], reviewDomains: [], active: true });
  });

  it("keeps the list to admins", async () => {
    const auditor: HumanPrincipal = { ...admin, roles: ["auditor"] };
    await expect(gov.people(auditor)).rejects.toThrow(/only an admin/);
  });
});
