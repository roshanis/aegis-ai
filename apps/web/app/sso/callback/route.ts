import { ssoSignIn } from "@aegis/core";
import { NextResponse, type NextRequest } from "next/server";
import { database } from "@/lib/db";
import { finishSignIn, publicOrigin, tenantSso } from "@/lib/oidc";
import { ssoSessionMs, takePending, writeSession } from "@/lib/session";

/** The provider sends the person back here with a code; Aegis checks it and decides whether they come in. */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const origin = publicOrigin(request.url);
  const pending = await takePending();
  const back = (error: string) =>
    NextResponse.redirect(new URL(`/signin?${new URLSearchParams({ org: pending?.o ?? "", error })}`, origin), 303);
  if (!pending) return back("expired");
  if (request.nextUrl.searchParams.has("error")) return back("provider");

  const sso = await tenantSso(pending.o);
  if (!sso) return back("unknown");

  let identity;
  try {
    identity = await finishSignIn(sso, origin, request.nextUrl.search, {
      state: pending.state,
      nonce: pending.nonce,
      verifier: pending.v,
    });
  } catch (error) {
    console.error(`sign-in for ${pending.o} failed at the provider`, error);
    return back("provider");
  }

  const outcome = await ssoSignIn(await database(), sso.tenantId, identity);
  if (!outcome.ok) return back(outcome.reason);
  await writeSession(sso.tenantId, outcome.userId, new Date(Date.now() + ssoSessionMs()));
  return NextResponse.redirect(new URL("/today", origin), 303);
}
