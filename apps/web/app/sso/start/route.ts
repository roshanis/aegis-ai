import { NextResponse, type NextRequest } from "next/server";
import { publicOrigin, startSignIn, tenantSso } from "@/lib/oidc";
import { writePending } from "@/lib/session";

/** Send the person to their organization's provider. */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const origin = publicOrigin(request.url);
  const org = (request.nextUrl.searchParams.get("org") ?? "").trim().toLowerCase();
  const back = (error: string) => NextResponse.redirect(new URL(`/signin?${new URLSearchParams({ org, error })}`, origin), 303);

  const sso = await tenantSso(org);
  if (!sso) return back("unknown");
  let started;
  try {
    started = await startSignIn(sso, origin);
  } catch (error) {
    console.error(`sign-in for ${org} could not reach its provider`, error);
    return back("provider");
  }
  await writePending({ o: sso.slug, state: started.state, nonce: started.nonce, v: started.verifier });
  return NextResponse.redirect(started.url, 303);
}
