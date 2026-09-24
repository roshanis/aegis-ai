import { sandboxPersonas } from "@aegis/core";
import { can } from "@aegis/domain";
import type { ReactNode } from "react";
import { Brand } from "@/components/Brand";
import { Nav } from "@/components/Nav";
import { PersonaSwitcher } from "@/components/PersonaSwitcher";
import { database, governance } from "@/lib/db";
import { ROLE, daysLeft, nextStep } from "@/lib/labels";
import { requireViewer } from "@/lib/viewer";
import { signOut } from "../actions";

export default async function ConsoleLayout({ children }: { children: ReactNode }) {
  const { principal, tenant } = await requireViewer();
  const views = await (await governance()).listAssetViews(principal);
  const personas = tenant.sandboxExpiresAt ? await sandboxPersonas(await database(), principal.tenantId) : [];
  const me = { userId: principal.userId, displayName: principal.displayName, title: null, roles: principal.roles };
  const role = ROLE[principal.roles[0] ?? ""];

  return (
    <div className="shell">
      <aside className="sidebar">
        <Brand />
        <Nav
          assets={views.length}
          needsYou={views.filter((v) => nextStep(v) !== null).length}
          canRegister={can(principal, "asset.register")}
        />
        <div className="tenant-card">
          <strong>{tenant.name}</strong>
          {tenant.sandboxExpiresAt ? (
            <span className="muted">Sandbox · {daysLeft(tenant.sandboxExpiresAt)} days left</span>
          ) : null}
          <form action={signOut}>
            <button className="btn btn-block" type="submit" style={{ marginTop: 6 }}>
              Sign out
            </button>
          </form>
        </div>
      </aside>
      <div className="main">
        <header className="topbar">
          <p className="muted hide-narrow">
            <strong style={{ color: "var(--text)" }}>{role?.label}.</strong> {role?.blurb}
          </p>
          <PersonaSwitcher current={me} personas={personas} />
        </header>
        <main className="content">{children}</main>
      </div>
    </div>
  );
}
