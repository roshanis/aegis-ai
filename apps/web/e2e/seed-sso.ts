/**
 * Give the e2e database a customer tenant that signs in through the mock
 * provider. Runs on the platform connection before the server starts, and
 * again harmlessly on a database that already has it.
 */
import { mkdir } from "node:fs/promises";
import { configureSso, keyringFromEnv, provisionTenant } from "@aegis/core";
import type { Connection } from "@aegis/db";
import { migrate } from "@aegis/db/migrate";
import { healthcareAiPack } from "@aegis/frameworks";

const E2E_ORG = "acme-health";

async function seed(conn: Connection) {
  await migrate(conn);
  const { rows } = await conn.query("SELECT 1 FROM tenants WHERE slug = $1", [E2E_ORG]);
  if (rows.length === 0) {
    await provisionTenant(conn, {
      tenant: { id: "00000000-0000-4000-8000-0000000e2e01", slug: E2E_ORG, name: "Acme Health" },
      admin: { email: "ada@acme-health.test", displayName: "Ada Admin" },
      packs: [healthcareAiPack],
    });
  }
  await configureSso(
    conn,
    keyringFromEnv(),
    E2E_ORG,
    {
      issuer: `http://localhost:${process.env.MOCK_IDP_PORT ?? 3201}`,
      clientId: "aegis-e2e",
      clientSecret: "e2e-client-secret",
      emailDomains: ["acme-health.test"],
      joinRoles: null,
    },
    { allowHttpIssuer: true },
  );
}

const url = process.env.DATABASE_URL;
if (url) {
  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await seed({ query: (text, params) => client.query(text, params) as never, exec: (text) => client.query(text) });
  } finally {
    await client.end();
  }
} else {
  const { PGlite } = await import("@electric-sql/pglite");
  const dir = process.env.AEGIS_PGLITE_DIR ?? ".data/pglite";
  await mkdir(dir, { recursive: true });
  const db = new PGlite(dir);
  try {
    await seed(db);
  } finally {
    await db.close();
  }
}
console.log(`seeded ${E2E_ORG} for single sign-on`);
