"use client";

import type { Persona } from "@aegis/core";
import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";
import { switchPersona } from "@/app/actions";
import { ROLE, initials } from "@/lib/labels";

export function PersonaSwitcher({ current, personas }: { current: Persona; personas: readonly Persona[] }) {
  const path = usePathname();
  const menu = useRef<HTMLDetailsElement>(null);
  // A native <details> stays open until its summary is clicked again; close it the way menus close.
  useEffect(() => {
    const close = (event: Event) => {
      const details = menu.current;
      if (!details?.open) return;
      const outside = event instanceof KeyboardEvent ? event.key === "Escape" : !details.contains(event.target as Node);
      if (outside) details.open = false;
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", close);
    };
  }, []);
  const role = ROLE[current.roles[0] ?? ""]?.label ?? "";
  const identity = (
    <>
      <span className="avatar" aria-hidden>
        {initials(current.displayName)}
      </span>
      <span className="stack" style={{ gap: 0 }}>
        <strong style={{ fontSize: 13.5 }}>{current.displayName}</strong>
        <span className="faint" style={{ fontSize: 12 }}>
          {role}
        </span>
      </span>
    </>
  );
  if (personas.length === 0) return <div className="row">{identity}</div>;

  return (
    <details className="persona" ref={menu}>
      <summary aria-label="Switch person">
        {identity}
        <span className="faint" aria-hidden>
          ▾
        </span>
      </summary>
      <div className="persona-menu">
        <p className="muted">See Aegis from another seat. Switching people only works in a sandbox.</p>
        {personas.map((p) => (
          <form action={switchPersona} key={p.userId}>
            <input type="hidden" name="userId" value={p.userId} />
            <input type="hidden" name="returnTo" value={path} />
            <button className="persona-option" type="submit" aria-current={p.userId === current.userId}>
              <span className="avatar" aria-hidden>
                {initials(p.displayName)}
              </span>
              <span>
                {p.displayName} · {ROLE[p.roles[0] ?? ""]?.label}
                <small>{p.title}</small>
              </span>
            </button>
          </form>
        ))}
      </div>
    </details>
  );
}
