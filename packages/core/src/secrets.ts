import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import type { Connection } from "@aegis/db";
import type { TenantId } from "@aegis/domain";
import { GovernanceError } from "./errors";

/**
 * Envelope encryption for tenant secrets such as model keys. The platform
 * master key (AEGIS_MASTER_KEY) wraps one data key per tenant; the data
 * key encrypts that tenant's secrets. Every ciphertext is bound to its
 * tenant and purpose, so a row copied into another tenant cannot be
 * decrypted there. Deleting a tenant's data key shreds all its secrets.
 */

export interface Keyring {
  /** The master key new data keys are wrapped with. */
  readonly current: { readonly id: string; readonly key: Buffer };
  byId(id: string): Buffer | undefined;
}

const keyId = (key: Buffer) => createHash("sha256").update(key).digest("hex").slice(0, 12);

export function keyring(...keys: Buffer[]): Keyring {
  if (keys.length === 0 || keys.some((k) => k.length !== 32)) throw new Error("master keys must be 32 bytes");
  const byId = new Map(keys.map((key) => [keyId(key), key]));
  return { current: { id: keyId(keys[0]!), key: keys[0]! }, byId: (id) => byId.get(id) };
}

/**
 * AEGIS_MASTER_KEY is 32 random bytes in base64; AEGIS_MASTER_KEY_PREVIOUS
 * keeps an old key readable during rotation. Production refuses to start
 * without one. Development falls back to a fixed, publicly known key so a
 * local database stays readable across restarts; it protects nothing.
 */
export function keyringFromEnv(env: Readonly<Record<string, string | undefined>> = process.env): Keyring {
  const decode = (value: string, name: string) => {
    const key = Buffer.from(value.trim(), "base64");
    if (key.length !== 32) throw new Error(`${name} must be 32 bytes, base64-encoded`);
    return key;
  };
  if (env.AEGIS_MASTER_KEY) {
    const keys = [decode(env.AEGIS_MASTER_KEY, "AEGIS_MASTER_KEY")];
    if (env.AEGIS_MASTER_KEY_PREVIOUS) keys.push(decode(env.AEGIS_MASTER_KEY_PREVIOUS, "AEGIS_MASTER_KEY_PREVIOUS"));
    return keyring(...keys);
  }
  if (env.NODE_ENV === "production") throw new Error("Set AEGIS_MASTER_KEY to 32 random bytes, base64-encoded.");
  return keyring(createHash("sha256").update("aegis development master key; never use in production").digest());
}

const b64 = (b: Buffer) => b.toString("base64url");

function seal(key: Buffer, plaintext: Buffer, aad: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return ["v1", b64(iv), b64(cipher.getAuthTag()), b64(body)].join(".");
}

function open(key: Buffer, sealed: string, aad: string): Buffer {
  const [version, iv, tag, body] = sealed.split(".");
  if (version !== "v1" || !iv || !tag || body === undefined) throw new Error("unreadable ciphertext");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(body, "base64url")), decipher.final()]);
}

/** The tenant's data key, created on first use. Call inside a tenant transaction. */
async function dataKey(tx: Connection, ring: Keyring, tenant: TenantId, at: Date | null): Promise<Buffer | null> {
  const wrapAad = `aegis:tenant-key:${tenant}`;
  const { rows } = await tx.query<{ kek_id: string; wrapped_key: string }>("SELECT kek_id, wrapped_key FROM tenant_keys");
  const row = rows[0];
  if (row) {
    const kek = ring.byId(row.kek_id);
    if (!kek) throw new GovernanceError("conflict", "this tenant's secrets were sealed with a master key this server does not have");
    return open(kek, row.wrapped_key, wrapAad);
  }
  if (!at) return null;
  const key = randomBytes(32);
  await tx.query(
    "INSERT INTO tenant_keys (tenant_id, kek_id, wrapped_key, created_at) VALUES (current_tenant_id(), $1, $2, $3)",
    [ring.current.id, seal(ring.current.key, key, wrapAad), at.toISOString()],
  );
  return key;
}

export async function sealSecret(
  tx: Connection,
  ring: Keyring,
  tenant: TenantId,
  purpose: string,
  secret: string,
  at: Date,
): Promise<string> {
  return seal((await dataKey(tx, ring, tenant, at))!, Buffer.from(secret, "utf8"), `aegis:${tenant}:${purpose}`);
}

/** The secret, or null when it cannot be read, for example because it was sealed for another tenant. */
export async function openSecret(
  tx: Connection,
  ring: Keyring,
  tenant: TenantId,
  purpose: string,
  sealed: string,
): Promise<string | null> {
  // A missing master key is an operator problem and says so; a ciphertext that will not open is just unreadable.
  const key = await dataKey(tx, ring, tenant, null);
  if (!key) return null;
  try {
    return open(key, sealed, `aegis:${tenant}:${purpose}`).toString("utf8");
  } catch {
    return null;
  }
}
