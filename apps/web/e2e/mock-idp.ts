/**
 * A minimal OpenID Connect provider for end-to-end tests: discovery, JWKS,
 * an authorize page where the tester types who they are, and a token
 * endpoint that checks the client secret and PKCE before issuing an RS256
 * ID token. Never for real use: anyone can claim any address.
 */
import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import { SignJWT, exportJWK, generateKeyPair } from "jose";

const PORT = Number(process.env.MOCK_IDP_PORT ?? 3201);
const ISSUER = `http://localhost:${PORT}`;
const CLIENT_ID = process.env.MOCK_IDP_CLIENT_ID ?? "aegis-e2e";
const CLIENT_SECRET = process.env.MOCK_IDP_CLIENT_SECRET ?? "e2e-client-secret";

const { privateKey, publicKey } = await generateKeyPair("RS256");
const jwk = { ...(await exportJWK(publicKey)), kid: "e2e", alg: "RS256", use: "sig" };

interface Grant {
  readonly redirectUri: string;
  readonly challenge: string;
  readonly nonce: string;
  readonly email: string;
  readonly name: string;
  readonly subject: string;
  readonly verified: boolean;
}
const codes = new Map<string, Grant>();

const html = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const body = async (req: IncomingMessage) => {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return new URLSearchParams(raw);
};

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", ISSUER);
  const json = (status: number, payload: unknown) => {
    res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(payload));
  };

  if (url.pathname === "/.well-known/openid-configuration") {
    return json(200, {
      issuer: ISSUER,
      authorization_endpoint: `${ISSUER}/authorize`,
      token_endpoint: `${ISSUER}/token`,
      jwks_uri: `${ISSUER}/jwks`,
      response_types_supported: ["code"],
      subject_types_supported: ["public"],
      id_token_signing_alg_values_supported: ["RS256"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["client_secret_post"],
      scopes_supported: ["openid", "email", "profile"],
    });
  }
  if (url.pathname === "/jwks") return json(200, { keys: [jwk] });

  if (url.pathname === "/authorize" && req.method === "GET") {
    const p = url.searchParams;
    if (p.get("client_id") !== CLIENT_ID || p.get("code_challenge_method") !== "S256" || !p.get("code_challenge")) {
      return json(400, { error: "invalid_request" });
    }
    const hidden = ["redirect_uri", "state", "nonce", "code_challenge"]
      .map((k) => `<input type="hidden" name="${k}" value="${html(p.get(k) ?? "")}">`)
      .join("");
    res.writeHead(200, { "content-type": "text/html" }).end(`<!doctype html><title>Test provider</title>
      <h1>Test provider</h1>
      <form method="post" action="/authorize">${hidden}
        <label>Email <input name="email" type="email" required></label>
        <label>Name <input name="name"></label>
        <label><input type="checkbox" name="unverified" value="1"> Email not verified</label>
        <button type="submit">Sign in at the provider</button>
      </form>`);
    return;
  }

  if (url.pathname === "/authorize" && req.method === "POST") {
    const form = await body(req);
    const email = form.get("email") ?? "";
    const code = randomBytes(16).toString("base64url");
    codes.set(code, {
      redirectUri: form.get("redirect_uri") ?? "",
      challenge: form.get("code_challenge") ?? "",
      nonce: form.get("nonce") ?? "",
      email,
      name: form.get("name") ?? "",
      subject: `e2e|${email.toLowerCase()}`,
      verified: form.get("unverified") !== "1",
    });
    const back = new URL(form.get("redirect_uri") ?? "");
    back.searchParams.set("code", code);
    back.searchParams.set("state", form.get("state") ?? "");
    back.searchParams.set("iss", ISSUER);
    res.writeHead(303, { location: back.toString() }).end();
    return;
  }

  if (url.pathname === "/token" && req.method === "POST") {
    const form = await body(req);
    const grant = codes.get(form.get("code") ?? "");
    codes.delete(form.get("code") ?? "");
    if (!grant) return json(400, { error: "invalid_grant" });
    if (form.get("client_id") !== CLIENT_ID || form.get("client_secret") !== CLIENT_SECRET) return json(401, { error: "invalid_client" });
    if (form.get("redirect_uri") !== grant.redirectUri) return json(400, { error: "invalid_grant" });
    const challenge = createHash("sha256").update(form.get("code_verifier") ?? "").digest("base64url");
    if (challenge !== grant.challenge) return json(400, { error: "invalid_grant" });
    const idToken = await new SignJWT({
      email: grant.email,
      email_verified: grant.verified,
      ...(grant.name ? { name: grant.name } : {}),
      nonce: grant.nonce,
    })
      .setProtectedHeader({ alg: "RS256", kid: "e2e" })
      .setIssuer(ISSUER)
      .setAudience(CLIENT_ID)
      .setSubject(grant.subject)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);
    return json(200, { access_token: randomBytes(16).toString("base64url"), token_type: "Bearer", expires_in: 300, id_token: idToken });
  }

  json(404, { error: "not_found" });
}).listen(PORT, () => console.log(`mock provider at ${ISSUER}`));
