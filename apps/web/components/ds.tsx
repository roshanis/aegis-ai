import type { Tier } from "@aegis/domain";
import type { ReactNode } from "react";
import { initials, type Tone } from "@/lib/labels";

/**
 * The Aegis design system's primitives: the logo, outline icons, actor
 * marks, the risk dial, tier text and tags. Server-safe; no state.
 */

type IconName =
  | "today"
  | "registry"
  | "intake"
  | "reviews"
  | "audit"
  | "packs"
  | "agents"
  | "search"
  | "lock"
  | "check"
  | "cross"
  | "download"
  | "link";

const PATHS: Record<IconName, ReactNode> = {
  today: (
    <>
      <path d="M4 5.5h13v13a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z" />
      <path d="M17 9h3v9.5a2 2 0 0 1-2 2M7.5 9h6M7.5 12.5h6M7.5 16h4" />
    </>
  ),
  registry: (
    <>
      <rect x="3.5" y="3.5" width="7" height="7" rx="1.5" />
      <rect x="13.5" y="3.5" width="7" height="7" rx="1.5" />
      <rect x="3.5" y="13.5" width="7" height="7" rx="1.5" />
      <rect x="13.5" y="13.5" width="7" height="7" rx="1.5" />
    </>
  ),
  intake: <path d="M12 5v14M5 12h14" />,
  reviews: (
    <>
      <path d="M3.5 13.5l2.5-8h12l2.5 8v5h-17z" />
      <path d="M3.5 13.5h5l1 2h5l1-2h5" />
    </>
  ),
  audit: (
    <>
      <rect x="3" y="8" width="6" height="8" rx="1.5" />
      <rect x="15" y="8" width="6" height="8" rx="1.5" />
      <path d="M9 12h6" />
    </>
  ),
  packs: (
    <>
      <path d="M12 3l9 5-9 5-9-5z" />
      <path d="M3 13l9 5 9-5" />
    </>
  ),
  agents: <circle cx="12" cy="12" r="8" strokeDasharray="3 2.4" />,
  search: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="M16 16l4.5 4.5" />
    </>
  ),
  lock: (
    <>
      <rect x="5" y="11" width="14" height="9" rx="2" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </>
  ),
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  cross: <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" />,
  download: <path d="M12 4v11M7 10.5l5 5 5-5M5 19.5h14" />,
  link: (
    <>
      <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" />
      <path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />
    </>
  ),
};

export function Icon({ name, size = 20 }: { name: IconName; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {PATHS[name]}
    </svg>
  );
}

export function Logo({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinejoin="round" strokeLinecap="round" aria-hidden="true">
      <path d="M12 2.5l8 3v6c0 5-3.4 8.6-8 10-4.6-1.4-8-5-8-10v-6l8-3z" />
      <path d="M8.5 12l2.5 2.5 4.5-5" />
    </svg>
  );
}

export type MarkKind = "human" | "system" | "agent" | "pending" | "future";

/** Who acted: a person is a filled seal, a system job a square, an agent a dashed ring. Always shown with a name. */
export function ActorMark({ kind, name, size = 28 }: { kind: MarkKind; name?: string | null; size?: number }) {
  const style = { "--size": `${size}px` } as React.CSSProperties;
  if (kind === "human") {
    return (
      <span className="mark mark-person" style={style} aria-hidden="true">
        {name ? initials(name) : "?"}
      </span>
    );
  }
  if (kind === "system") {
    return (
      <span className="mark" style={style} aria-hidden="true">
        <span className="mark-system" />
      </span>
    );
  }
  return <span className={`mark mark-${kind}`} style={style} aria-hidden="true" />;
}

/** A mark with the name beside it, and a role or detail under the name. */
export function Actor({ kind, name, detail, size = 28 }: { kind: MarkKind; name: string; detail?: string | null; size?: number }) {
  return (
    <span className="actor">
      <ActorMark kind={kind} name={name} size={size} />
      <span className="actor-name">
        <strong>{name}</strong>
        {detail ? <span>{detail}</span> : null}
      </span>
    </span>
  );
}

const TIER_ORDER: readonly Tier[] = ["low", "medium", "high", "critical"];
export const TIER_NAME: Record<Tier, string> = { low: "Low", medium: "Medium", high: "High", critical: "Critical" };

/* Four arcs on a half circle, centre (110, 112), radius 90, with small gaps. */
const ARCS: readonly (readonly [number, number])[] = [
  [180, 137],
  [133, 92],
  [88, 47],
  [43, 0],
];
const pt = (deg: number) => {
  const a = (deg * Math.PI) / 180;
  return `${(110 + 90 * Math.cos(a)).toFixed(1)} ${(112 - 90 * Math.sin(a)).toFixed(1)}`;
};

/** The tier, the rule that set it, and why: set by rules, never by AI. */
export function RiskDial({
  tier,
  ruleId,
  because,
  small = false,
  label,
}: {
  tier: Tier;
  ruleId: string | null;
  because: string;
  small?: boolean;
  label?: string;
}) {
  const at = TIER_ORDER.indexOf(tier);
  return (
    <figure className={`dial-card${small ? " dial-sm" : ""}`} data-tier={tier} aria-label={label ?? `${TIER_NAME[tier]} risk`}>
      <div className="dial">
        <svg viewBox="0 0 220 124" aria-hidden="true" fill="none" strokeWidth={16}>
          {ARCS.map(([from, to], i) => (
            <path key={from} className={i <= at ? `arc-${TIER_ORDER[i]}` : "arc-off"} d={`M ${pt(from)} A 90 90 0 0 1 ${pt(to)}`} />
          ))}
        </svg>
        <div className="dial-label">
          <span className="dial-tier">{TIER_NAME[tier]}</span>
        </div>
      </div>
      <span className="dial-rule">Risk tier · rule {ruleId ?? "none matched"}</span>
      <figcaption className="reason dial-why">because it {because}</figcaption>
    </figure>
  );
}

/** Four bars, filled up to the tier, in the tier's colour. */
export function Meter({ tier }: { tier: Tier }) {
  const at = TIER_ORDER.indexOf(tier);
  return (
    <div className="meter" data-tier={tier} aria-hidden="true">
      {TIER_ORDER.map((t, i) => (
        <span key={t} data-on={i <= at} />
      ))}
    </div>
  );
}

export function TierText({ tier, suffix = "" }: { tier: Tier | null; suffix?: string }) {
  if (!tier) return <span className="tier">—</span>;
  return (
    <span className="tier" data-tier={tier}>
      {TIER_NAME[tier]}
      {suffix}
    </span>
  );
}

export function Tag({ tone = "neutral", children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span className="tag" data-tone={tone}>
      {children}
    </span>
  );
}

/** The frame every piece of agent output sits in. Never put approve or sign buttons inside it. */
export function AgentDraftFrame({
  agent,
  meta,
  children,
  label,
}: {
  agent: string;
  meta?: string;
  children: ReactNode;
  label?: string;
}) {
  return (
    <section className="agent-draft" aria-label={label ?? `Draft by ${agent}`}>
      <div className="agent-draft-head">
        <span className="mark mark-agent" style={{ "--size": "20px" } as React.CSSProperties} aria-hidden="true" />
        <span className="title">Draft by {agent}</span>
        <Tag tone="agent">Draft only · cannot approve</Tag>
        {meta ? <span className="meta">{meta}</span> : null}
      </div>
      <div className="agent-draft-body">{children}</div>
    </section>
  );
}
