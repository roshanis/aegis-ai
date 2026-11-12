/**
 * Platform commands for customer tenants, run by the people who operate
 * Aegis, never from the console. They connect as the migration owner, like
 * `pnpm db:migrate`: DATABASE_URL for Postgres, otherwise the local PGlite.
 *
 *   pnpm platform create  --slug acme-health --name "Acme Health" \
 *                         --admin-email ada@acme-health.com --admin-name "Ada Lovelace" \
 *                         [--pack healthcare-ai] [--mode shared|dedicated|byoc] [--region us]
 *   pnpm platform sso     --slug acme-health --issuer https://login.acme-health.com \
 *                         --client-id aegis [--client-secret-env ACME_SSO_SECRET] \
 *                         --domains acme-health.com,acme.com [--join-roles requester]
 *   pnpm platform offboard --slug acme-health --confirm acme-health
 *
 * The client secret is read from the named environment variable so it never
 * lands in shell history. Offboarding deletes every row the tenant owns,
 * audit log included; export what the customer keeps first.
 */
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { parseArgs } from "node:util";
import { configureSso, keyringFromEnv, provisionTenant, purgeTenant } from "@aegis/core";
import type { Connection } from "@aegis/db";
import { tenantId, type DeploymentMode, type Role } from "@aegis/domain";
import { findPack } from "@aegis/frameworks";

async function withPlatform<T>(fn: (conn: Connection) => Promise<T>): Promise<T> {
  const url = process.env.DATABASE_URL;
  if (url) {
    const { default: pg } = await import("pg");
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    try {
      return await fn({ query: (text, params) => client.query(text, params) as never, exec: (text) => client.query(text) });
    } finally {
      await client.end();
    }
  }
  const { PGlite } = await import("@electric-sql/pglite");
  const dir = process.env.AEGIS_PGLITE_DIR ?? ".data/pglite";
  await mkdir(dir, { recursive: true });
  const db = new PGlite(dir);
  try {
    return await fn(db);
  } finally {
    await db.close();
  }
}

const [command, ...rest] = process.argv.slice(2);
const { values } = parseArgs({
  args: rest,
  options: {
    slug: { type: "string" },
    name: { type: "string" },
    "admin-email": { type: "string" },
    "admin-name": { type: "string" },
    pack: { type: "string", multiple: true },
    mode: { type: "string" },
    region: { type: "string" },
    issuer: { type: "string" },
    "client-id": { type: "string" },
    "client-secret-env": { type: "string" },
    domains: { type: "string" },
    "join-roles": { type: "string" },
    confirm: { type: "string" },
  },
});

function need(key: keyof typeof values): string {
  const value = values[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`--${key} is required`);
  return value.trim();
}

async function main(): Promise<string> {
  switch (command) {
    case "create": {
      const slug = need("slug");
      const packs = (values.pack ?? ["healthcare-ai"]).map((id) => {
        const pack = findPack(id);
        if (!pack) throw new Error(`no built-in pack ${id}`);
        return pack;
      });
      const { tenantId: id, adminId } = await withPlatform((conn) =>
        provisionTenant(conn, {
          tenant: {
            id: randomUUID(),
            slug,
            name: need("name"),
            deploymentMode: (values.mode ?? "shared") as DeploymentMode,
            region: values.region ?? "us",
          },
          admin: { email: need("admin-email"), displayName: need("admin-name") },
          packs,
        }),
      );
      return `created ${slug} (${id}); first admin ${adminId}. Next: pnpm platform sso --slug ${slug} …`;
    }
    case "sso": {
      const slug = need("slug");
      const secretEnv = values["client-secret-env"];
      const clientSecret = secretEnv ? process.env[secretEnv] : undefined;
      if (secretEnv && !clientSecret) throw new Error(`${secretEnv} is empty`);
      const joinRoles = values["join-roles"] ? (values["join-roles"].split(",").map((r) => r.trim()) as Role[]) : null;
      await withPlatform((conn) =>
        configureSso(
          conn,
          keyringFromEnv(),
          slug,
          {
            issuer: need("issuer"),
            clientId: need("client-id"),
            clientSecret: clientSecret ?? null,
            emailDomains: need("domains").split(","),
            joinRoles,
          },
          { allowHttpIssuer: process.env.AEGIS_SSO_ALLOW_HTTP === "1" },
        ),
      );
      return `${slug} now signs in through ${need("issuer")}`;
    }
    case "offboard": {
      const slug = need("slug");
      if (values.confirm !== slug) throw new Error(`repeat the tenant's slug with --confirm ${slug} to delete it for good`);
      await withPlatform(async (conn) => {
        const { rows } = await conn.query<{ id: string; sandbox_expires_at: Date | null }>(
          "SELECT id, sandbox_expires_at FROM tenants WHERE slug = $1",
          [slug],
        );
        if (!rows[0]) throw new Error(`no tenant ${slug}`);
        await purgeTenant(conn, tenantId(rows[0].id));
      });
      return `deleted ${slug} and everything it owned`;
    }
    default:
      throw new Error("usage: pnpm platform create | sso | offboard (see scripts/platform.ts)");
  }
}

main().then(
  (message) => console.log(message),
  (error: unknown) => {
    console.error((error as Error).message);
    process.exitCode = 1;
  },
);
