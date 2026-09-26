import Link from "next/link";
import { ActorMark, Logo } from "@/components/ds";
import { getViewer } from "@/lib/viewer";
import { signOut, startSandbox } from "./actions";

const MARKS = [
  {
    kind: "human" as const,
    name: "Avery Brooks",
    title: "People sign and decide",
    body: "Each review team signs its seat. An approver decides.",
  },
  {
    kind: "system" as const,
    name: "",
    title: "Rules set the tier, not AI",
    body: "Your policy pack sets the tier and names the rule.",
  },
  {
    kind: "agent" as const,
    name: "",
    title: "Agents draft, behind a gate",
    body: "Agents draft. They stay off until they pass their tests.",
  },
];

export default async function Landing() {
  const viewer = await getViewer();
  return (
    <div className="landing">
      <header className="spread">
        <span className="brand">
          <Logo size={28} />
          <span className="brand-name" style={{ fontSize: 32 }}>
            Aegis
          </span>
        </span>
        {viewer ? (
          <form action={signOut}>
            <button className="btn btn-sm" type="submit">
              Start over
            </button>
          </form>
        ) : null}
      </header>

      <main className="landing-hero">
        <span className="eyebrow">AI governance for health plans</span>
        <h1>
          Agents draft, <em>people decide.</em>
        </h1>
        <p>Register every AI system, triage it by your own rules, and prove who approved what.</p>
        <div className="row" style={{ gap: 16 }}>
          {viewer ? (
            <Link className="btn btn-primary btn-lg" href="/today">
              Continue as {viewer.principal.displayName}
            </Link>
          ) : (
            <form action={startSandbox}>
              <button className="btn btn-primary btn-lg" type="submit">
                Open a sandbox
              </button>
            </form>
          )}
          <span className="hint">
            {viewer ? viewer.tenant.name : "Sample data · 7 days · no sign-up"}
          </span>
        </div>
      </main>

      <section className="landing-marks" aria-label="How Aegis works">
        {MARKS.map((m) => (
          <div className="panel" key={m.title}>
            <ActorMark kind={m.kind} name={m.name || null} size={40} />
            <h2 className="title">{m.title}</h2>
            <p className="muted">{m.body}</p>
          </div>
        ))}
      </section>

      <footer className="mono-s muted">Append-only, hash-chained audit log · policy packs as versioned data · BSL 1.1</footer>
    </div>
  );
}
