import { sandboxPersonas } from "@aegis/core";
import { can, caseLabel } from "@aegis/domain";
import Link from "next/link";
import type { ReactNode } from "react";
import { Logo } from "@/components/ds";
import { CommandPalette, PersonMenu, Rail, type PaletteItem } from "@/components/Shell";
import { database, governance } from "@/lib/db";
import { ASSET_STATE, DEPLOYMENT, currentReview, daysLeft, nextStep } from "@/lib/labels";
import { readTheme } from "@/lib/theme";
import { requireViewer } from "@/lib/viewer";

const PAGES: PaletteItem[] = [
  { href: "/today", label: "Today: the docket", group: "Pages" },
  { href: "/registry", label: "Registry", group: "Pages" },
  { href: "/reviews", label: "Reviews", group: "Pages" },
  { href: "/audit", label: "Audit log", group: "Pages" },
  { href: "/packs", label: "Policy packs", group: "Pages" },
  { href: "/agents", label: "Agents", group: "Pages" },
];

export default async function ConsoleLayout({ children }: { children: ReactNode }) {
  const { principal, tenant } = await requireViewer();
  const [views, personas, theme] = await Promise.all([
    (await governance()).listAssetViews(principal),
    tenant.sandboxExpiresAt ? sandboxPersonas(await database(), principal.tenantId) : Promise.resolve([]),
    readTheme(),
  ]);
  const me = { userId: principal.userId, displayName: principal.displayName, title: null, roles: principal.roles };
  const canRegister = can(principal, "asset.register");
  const palette: PaletteItem[] = [
    ...(canRegister ? [{ href: "/registry/new", label: "Register a system", group: "Pages" } as PaletteItem] : []),
    ...PAGES,
    ...views.map((v) => {
      const review = currentReview(v);
      return {
        href: `/registry/${v.asset.id}`,
        label: v.asset.name,
        meta: `${review ? `${caseLabel(review.number)} · ` : ""}${ASSET_STATE[v.asset.state].label}`,
        group: "Systems" as const,
      };
    }),
  ];
  const badge = `${tenant.sandboxExpiresAt ? `Sandbox · ${daysLeft(tenant.sandboxExpiresAt)}d left` : tenant.region.toUpperCase()} · ${DEPLOYMENT[tenant.deploymentMode]}`;

  return (
    <div className="app">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="topbar">
        <Link className="brand" href="/today" aria-label="Aegis, today">
          <Logo />
          <span className="brand-name">Aegis</span>
        </Link>
        <span className="sep" aria-hidden="true">
          /
        </span>
        <span className="tenant">{tenant.name}</span>
        <span className="badge">{badge}</span>
        <span className="grow" />
        <CommandPalette items={palette} />
        <span className="grow" />
        <PersonMenu current={me} personas={personas} theme={theme} />
      </header>
      <Rail reviews={views.filter((v) => nextStep(v) !== null).length} canRegister={canRegister} />
      <main className="main" id="main">
        {children}
      </main>
    </div>
  );
}
