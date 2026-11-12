import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Logo } from "@/components/ds";
import { getViewer } from "@/lib/viewer";

export const metadata: Metadata = { title: "Sign in" };

const PROBLEM: Record<string, string> = {
  unknown: "No organization by that name signs in here. Check the name with your admin.",
  provider: "Your sign-in provider didn't finish the sign-in. Try again.",
  expired: "That sign-in took too long or was already used. Start again.",
  not_configured: "That sign-in came from a provider this organization doesn't use.",
  email: "Sign in with your verified work email at this organization.",
  not_invited: "You haven't been added to this organization yet. Ask an admin to add you.",
  inactive: "Your access here is switched off. Ask an admin to switch it back on.",
  conflict: "Your email is already linked to a different sign-in. Ask an admin.",
};

export default async function SignIn({ searchParams }: { searchParams: Promise<{ org?: string; error?: string }> }) {
  if (await getViewer()) redirect("/today");
  const { org = "", error } = await searchParams;
  const problem = error ? (PROBLEM[error] ?? PROBLEM.provider) : null;
  return (
    <div className="landing">
      <header className="spread">
        <Link className="brand" href="/" aria-label="Aegis home">
          <Logo size={28} />
          <span className="brand-name" style={{ fontSize: 32 }}>
            Aegis
          </span>
        </Link>
      </header>
      <main className="landing-hero signin">
        <h1>Sign in</h1>
        <form action="/sso/start" method="get" className="stack" style={{ gap: 12, maxWidth: 420, width: "100%" }}>
          <div className="field">
            <label htmlFor="org">Organization</label>
            <input
              id="org"
              name="org"
              required
              defaultValue={org}
              placeholder="acme-health"
              autoComplete="organization"
              autoCapitalize="none"
              spellCheck={false}
              pattern="[A-Za-z0-9][A-Za-z0-9-]{1,62}"
            />
          </div>
          {problem ? (
            <p className="error" role="alert">
              {problem}
            </p>
          ) : null}
          <button className="btn btn-primary btn-lg" type="submit">
            Continue to your sign-in
          </button>
        </form>
        <span className="hint">
          Just looking? <Link href="/">Open a sandbox</Link>
        </span>
      </main>
    </div>
  );
}
