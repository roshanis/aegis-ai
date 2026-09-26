import { describe, expect, it } from "vitest";
import { signSession, verifySession } from "./token";

const secret = "s".repeat(32);
const payload = { t: "00000000-0000-4000-8000-00000000000a", u: "00000000-0000-4000-8000-000000000001", exp: 2_000 };

describe("session tokens", () => {
  it("round-trips a valid token", () => {
    expect(verifySession(signSession(payload, secret), secret, 1_000)).toEqual(payload);
  });

  it("rejects a token for another tenant, a wrong secret, or an expired one", () => {
    const token = signSession(payload, secret);
    const [, signature] = token.split(".");
    const forged = `${Buffer.from(JSON.stringify({ ...payload, t: "00000000-0000-4000-8000-00000000000b" })).toString("base64url")}.${signature}`;
    expect(verifySession(forged, secret, 1_000)).toBeNull();
    expect(verifySession(token, "x".repeat(32), 1_000)).toBeNull();
    expect(verifySession(token, secret, 2_000)).toBeNull();
    expect(verifySession("garbage", secret, 1_000)).toBeNull();
    expect(verifySession(`${token}.x`, secret, 1_000)).toBeNull();
  });
});
