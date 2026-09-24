import Link from "next/link";
import { Brand } from "@/components/Brand";
import { getViewer } from "@/lib/viewer";
import { signOut, startSandbox } from "./actions";

const icon = (d: string) => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d={d} />
  </svg>
);

const FEATURES = [
  {
    icon: icon("M4 6h16M4 12h16M4 18h10"),
    title: "One registry",
    body: "Every AI system, agent and vendor model, with whether it's cleared for use right now. Re-reviews attach to the same record.",
  },
  {
    icon: icon("M12 3v18M5 7l-3 6a3 3 0 0 0 6 0L5 7Zm14 0-3 6a3 3 0 0 0 6 0l-3-6ZM5 7h14"),
    title: "Triage you can explain",
    body: "Your policy decides the risk tier and who must review, with the rule that fired shown to the requester. No model involved.",
  },
  {
    icon: icon("M9 12l2 2 4-4M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6l8-3Z"),
    title: "Decisions you can prove",
    body: "Who approved it, why, under which policy version, in a tamper-evident log that still honours erasure requests.",
  },
];

export default async function Landing() {
  const viewer = await getViewer();
  return (
    <div className="landing">
      <nav className="landing-nav">
        <Brand />
        {viewer ? (
          <form action={signOut}>
            <button className="btn" type="submit">
              Start over
            </button>
          </form>
        ) : null}
      </nav>

      <section className="hero">
        <span className="eyebrow">AI governance for health plans</span>
        <h1>
          Know every AI system you run. <span className="gradient-text">Prove every decision.</span>
        </h1>
        <p className="lede">
          Aegis keeps one registry of your AI, triages risk with your own policy, routes each review to the right
          people, and records who approved what, why, and under which policy version. Agents draft; people decide.
        </p>
        <div className="row">
          {viewer ? (
            <Link className="btn btn-primary btn-lg" href="/registry">
              Continue as {viewer.principal.displayName} →
            </Link>
          ) : (
            <form action={startSandbox}>
              <button className="btn btn-primary btn-lg" type="submit">
                Open a sandbox →
              </button>
            </form>
          )}
          <span className="faint">
            {viewer
              ? `${viewer.tenant.name}, your private sandbox`
              : "A private tenant with sample data, yours for 7 days. No sign-up."}
          </span>
        </div>
      </section>

      <section className="features">
        {FEATURES.map((f) => (
          <div className="card feature" key={f.title}>
            <span className="feature-icon" aria-hidden>
              {f.icon}
            </span>
            <h2>{f.title}</h2>
            <p className="muted">{f.body}</p>
          </div>
        ))}
      </section>
    </div>
  );
}
