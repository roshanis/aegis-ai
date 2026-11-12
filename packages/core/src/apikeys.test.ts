import { PGlite } from "@electric-sql/pglite";
import { serialized, verifyAuditChain, withTenant } from "@aegis/db";
import { migrate } from "@aegis/db/migrate";
import { userId, type HumanPrincipal, type Role } from "@aegis/domain";
import { healthcareAiPack } from "@aegis/frameworks";
import { beforeAll, describe, expect, it } from "vitest";
import { parseApiKey } from "./apikeys";
import { createGovernance, type Governance } from "./governance";
import { provisionTenant } from "./provision";

let db: PGlite;
let gov: Governance;
let clock = Date.UTC(2026, 10, 12, 9);
let admin: HumanPrincipal;
let second: HumanPrincipal;
let owner: HumanPrincipal;
let otherAdmin: HumanPrincipal;
let assetId: string;

const YES = Object.fromEntries(healthcareAiPack.questions.map((q) => [q.field, q.field === "phi"]));

beforeAll(async () => {
  db = new PGlite();
  await migrate(db);
  gov = createGovernance(serialized(db), { now: () => new Date((clock += 60_000)) });
  const made = await provisionTenant(db, {
    tenant: { id: "00000000-0000-4000-8000-0000000000f1", slug: "bay", name: "Bay Health" },
    admin: { email: "admin@bay.test", displayName: "Ada Admin" },
    packs: [healthcareAiPack],
  });
  admin = { kind: "human", tenantId: made.tenantId, userId: made.adminId, displayName: "Ada Admin", roles: ["admin"], reviewDomains: [] };
  const add = async (name: string, roles: Role[]): Promise<HumanPrincipal> => ({
    kind: "human",
    tenantId: made.tenantId,
    userId: userId(await gov.addUser(admin, { email: `${name.split(" ")[0]!.toLowerCase()}@bay.test`, displayName: name, roles })),
    displayName: name,
    roles,
    reviewDomains: [],
  });
  second = await add("Sid Second", ["admin"]);
  owner = await add("Owen Owner", ["requester"]);
  const other = await provisionTenant(db, {
    tenant: { id: "00000000-0000-4000-8000-0000000000f2", slug: "cove", name: "Cove Health" },
    admin: { email: "admin@cove.test", displayName: "Cy Cove" },
    packs: [healthcareAiPack],
  });
  otherAdmin = { kind: "human", tenantId: other.tenantId, userId: other.adminId, displayName: "Cy Cove", roles: ["admin"], reviewDomains: [] };

  const asset = await gov.registerAsset(owner, { kind: "ai_system", name: "Prior-auth summarizer" });
  const draft = await gov.openCase(owner, { assetId: asset.id });
  await gov.submitCase(owner, draft.id, YES);
  assetId = asset.id;
}, 60_000);

async function gateControl() {
  const { assurance } = await gov.getAsset(owner, assetId);
  return assurance.controls.find((c) => c.enforcement === "gate")!;
}

describe("API keys", () => {
  it("lets a tool post evidence with a key, recorded as the key acting for the admin who made it", async () => {
    const { id, key } = await gov.createApiKey(second, { name: "Fairness CI" });
    expect(parseApiKey(key)).toMatchObject({ keyId: id });
    const control = await gateControl();

    const evidenceId = await gov.addEvidenceWithKey(key, {
      assetId,
      controlId: control.id,
      kind: "link",
      title: "Fairness run 2026-11-12",
      url: "https://ci.bay.test/runs/4812",
    });
    const shown = (await gateControl()).evidence.find((e) => e.id === evidenceId)!;
    expect(shown).toMatchObject({ via: "Fairness CI", addedBy: { name: "Sid Second" } });
    expect((await gov.apiKeys(admin))[0]).toMatchObject({ name: "Fairness CI", createdBy: "Sid Second", revokedAt: null });
    expect((await gov.apiKeys(admin))[0]!.lastUsedAt).not.toBeNull();

    const { rows } = await withTenant(db, admin.tenantId, (tx) =>
      tx.query<{ actor_kind: string; actor_id: string; payload: Record<string, unknown> }>(
        "SELECT actor_kind, actor_id, payload FROM audit_events WHERE action = 'evidence.add' ORDER BY id DESC LIMIT 1",
      ),
    );
    expect(rows[0]).toMatchObject({ actor_kind: "system", actor_id: `api-key:${id}`, payload: { onBehalfOf: second.userId, evidenceId } });
    expect(await withTenant(db, admin.tenantId, verifyAuditChain)).toBeNull();
  });

  it("refuses bad, revoked, foreign and orphaned keys alike, and still checks the evidence", async () => {
    const control = await gateControl();
    const input = { assetId, controlId: control.id, kind: "attestation" as const, title: "Scan", detail: "No findings" };
    const { id, key } = await gov.createApiKey(admin, { name: "Scanner" });

    await expect(gov.addEvidenceWithKey(key, { ...input, controlId: "NOPE-1" })).rejects.toMatchObject({ code: "invalid" });
    await expect(gov.addEvidenceWithKey(key, { ...input, detail: "" })).rejects.toMatchObject({ code: "invalid" });

    const forged = key.slice(0, -4) + (key.endsWith("AAAA") ? "BBBB" : "AAAA");
    for (const bad of ["", "Bearer x", forged, key.replace(/^aek\.[0-9a-f]{32}/, `aek.${otherAdmin.tenantId.replaceAll("-", "")}`)]) {
      await expect(gov.addEvidenceWithKey(bad, input)).rejects.toMatchObject({ code: "forbidden", message: "that API key is not valid" });
    }

    // The other tenant's admin can neither see nor revoke it.
    expect(await gov.apiKeys(otherAdmin)).toEqual([]);
    await expect(gov.revokeApiKey(otherAdmin, id)).rejects.toMatchObject({ code: "not_found" });
    await expect(gov.apiKeys(owner)).rejects.toMatchObject({ code: "forbidden" });
    await expect(gov.createApiKey(owner, { name: "Mine" })).rejects.toMatchObject({ code: "forbidden" });

    await gov.revokeApiKey(admin, id);
    await expect(gov.addEvidenceWithKey(key, input)).rejects.toMatchObject({ code: "forbidden" });
    await expect(gov.revokeApiKey(admin, id)).rejects.toMatchObject({ code: "not_found" });

    // A key stops working when its maker stops being an admin.
    const { key: secondKey } = await gov.createApiKey(second, { name: "Second's key" });
    await gov.updatePerson(admin, second.userId, { roles: ["auditor"], reviewDomains: [], active: true });
    await expect(gov.addEvidenceWithKey(secondKey, input)).rejects.toMatchObject({ code: "forbidden" });
  });

  it("keeps only the hash, and never lets the app change a key's secret or scope", async () => {
    const { key } = await gov.createApiKey(admin, { name: "Hash check" });
    const secret = parseApiKey(key)!.secret;
    const { rows } = await withTenant(db, admin.tenantId, (tx) => tx.query<{ secret_sha256: string }>("SELECT secret_sha256 FROM api_keys"));
    expect(rows.every((r) => r.secret_sha256 !== secret && /^[0-9a-f]{64}$/.test(r.secret_sha256))).toBe(true);
    await expect(withTenant(db, admin.tenantId, (tx) => tx.exec("UPDATE api_keys SET scopes = '{evidence:write}'"))).rejects.toThrow(/permission denied/);
    await expect(withTenant(db, admin.tenantId, (tx) => tx.exec("DELETE FROM api_keys"))).rejects.toThrow(/permission denied/);
    await expect(gov.createApiKey(admin, { name: " " })).rejects.toMatchObject({ code: "invalid" });
  });
});
