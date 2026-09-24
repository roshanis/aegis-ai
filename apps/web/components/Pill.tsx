import type { Tone } from "@/lib/labels";

export function Pill({ tone, children, plain }: { tone: Tone; children: React.ReactNode; plain?: boolean }) {
  return <span className={`pill tone-${tone}${plain ? " plain" : ""}`}>{children}</span>;
}
