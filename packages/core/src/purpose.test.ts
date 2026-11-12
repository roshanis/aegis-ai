import { PGlite } from "@electric-sql/pglite";
import { serialized, sha256Hex, verifyAuditChain, withTenant } from "@aegis/db";
import { migrate } from "@aegis/db/migrate";
import { userId, type HumanPrincipal } from "@aegis/domain";
import { healthcareAiPack } from "@aegis/frameworks";
import { beforeAll, describe, expect, it } from "vitest";
import { createGovernance, type Governance } from "./governance";
import { provisionTenant } from "./provision";

let db: PGlite;
let gov: Governance;
let clock = Date.UTC(2026, 10, 12, 9);
let admin: HumanPrincipal;
let owner: HumanPrincipal;

const NO = Object.fromEntries(healthcareAiPack.questions.map((q) => [q.field, false]));

beforeAll(async () => {
  db = new PGlite();
  await migrate(db);
  gov = createGovernance(serialized(db), { now: () => new Date((clock += 60_000)) });
  const made = await provisionTenant(db, {
    tenant: { id: "00000000-0000-4000-8000-0000000000a7", slug: "pier", name: "Pier Health" },
    admin: { email: "admin@pier.test", displayName: "Ada Admin" },
    packs: [healthcareAiPack],
  });
  admin = { kind: "human", tenantId: made.tenantId, userId: made.adminId, displayName: "Ada Admin", roles: ["admin"], reviewDomains: [] };
  owner = {
    kind: "human",
    tenantId: made.tenantId,
    userId: userId(await gov.addUser(admin, { email: "owen@pier.test", displayName: "Owen Owner", roles: ["requester"] })),
    displayName: "Owen Owner",
    roles: ["requester"],
    reviewDomains: [],
  };
}, 60_000);

describe("intake purpose", () => {
  it("saves the requester's words with the case as a note, audits only their hash, and erases cleanly", async () => {
    const asset = await gov.registerAsset(owner, { kind: "ai_system", name: "Letter summarizer" });
    const draft = await gov.openCase(owner, { assetId: asset.id });
    const words = "Summarizes  appeal letters\nfor the nurse reviewer.";
    const { case: submitted } = await gov.submitCase(owner, draft.id, NO, { purpose: words });
    expect(submitted.purpose).toBe("Summarizes appeal letters for the nurse reviewer.");
    const view = await gov.getAsset(owner, asset.id);
    expect(view.cases.at(-1)!.purpose).toBe("Summarizes appeal letters for the nurse reviewer.");
    expect((await gov.caseRecord(admin, draft.id)).case.purpose).toBe("Summarizes appeal letters for the nurse reviewer.");

    const { rows } = await withTenant(db, admin.tenantId, (tx) =>
      tx.query<{ payload: Record<string, unknown> }>("SELECT payload FROM audit_events WHERE case_id = $1 AND action = 'case.submit'", [draft.id]),
    );
    expect(rows[0]!.payload).toMatchObject({ purposeSha256: sha256Hex("Summarizes appeal letters for the nurse reviewer.") });
    expect(JSON.stringify(rows)).not.toContain("appeal letters");

    // An erasure deletes the note; the case simply has no purpose, and the chain still verifies.
    await withTenant(db, admin.tenantId, (tx) => tx.query("DELETE FROM notes WHERE id = $1", [rows[0]!.payload.purposeNoteId]));
    expect((await gov.getAsset(owner, asset.id)).cases.at(-1)!.purpose).toBeNull();
    expect(await withTenant(db, admin.tenantId, verifyAuditChain)).toBeNull();
  });

  it("keeps it optional, and refuses an essay", async () => {
    const asset = await gov.registerAsset(owner, { kind: "ai_system", name: "No words" });
    const draft = await gov.openCase(owner, { assetId: asset.id });
    await expect(gov.submitCase(owner, draft.id, NO, { purpose: "x".repeat(2001) })).rejects.toMatchObject({ code: "invalid" });
    const { case: submitted } = await gov.submitCase(owner, draft.id, NO, { purpose: "   " });
    expect(submitted.purpose).toBeNull();
  });
});
