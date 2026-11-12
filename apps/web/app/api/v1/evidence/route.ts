import { NextResponse, type NextRequest } from "next/server";
import { governance } from "@/lib/db";
import { refusal } from "@/lib/errors";

/**
 * POST /api/v1/evidence — a tool posts evidence for one control or
 * condition, with an API key an admin made on the People page:
 *
 *   Authorization: Bearer aek.…
 *   { "assetId": "…", "controlId": "R-01", "title": "Fairness run 4812",
 *     "url": "https://ci.example/runs/4812" }
 *
 * With a url it is a link; with "detail" instead it is an attestation.
 */

const MAX_BODY = 16_384;
const STATUS: Record<string, number> = { forbidden: 401, not_found: 404, invalid: 422, conflict: 409, unavailable: 503 };

const problem = (status: number, error: string) =>
  NextResponse.json({ error }, { status, headers: status === 401 ? { "WWW-Authenticate": 'Bearer realm="aegis"' } : {} });

export async function POST(request: NextRequest): Promise<NextResponse> {
  const auth = request.headers.get("authorization") ?? "";
  const token = /^Bearer\s+(\S+)$/i.exec(auth)?.[1];
  if (!token) return problem(401, "send an API key as a Bearer token");

  const raw = await request.text();
  if (raw.length > MAX_BODY) return problem(413, `keep the body under ${MAX_BODY} bytes`);
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    body = parsed as Record<string, unknown>;
  } catch {
    return problem(400, "send a JSON object");
  }
  const str = (key: string) => (typeof body[key] === "string" ? (body[key] as string) : undefined);
  const url = str("url");

  try {
    const id = await (await governance()).addEvidenceWithKey(token, {
      assetId: str("assetId") ?? "",
      ...(str("controlId") ? { controlId: str("controlId")! } : { conditionId: str("conditionId") }),
      kind: url ? "link" : "attestation",
      title: str("title") ?? "",
      ...(url ? { url } : { detail: str("detail") }),
    });
    return NextResponse.json({ id }, { status: 201 });
  } catch (error) {
    const refused = refusal(error);
    if (refused) return problem(STATUS[refused.code] ?? 400, refused.message);
    throw error;
  }
}
