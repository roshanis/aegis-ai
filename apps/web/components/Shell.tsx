"use client";

import type { Persona } from "@aegis/core";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { setTheme, signOut, switchPersona } from "@/app/actions";
import { ROLE } from "@/lib/labels";
import { ActorMark, Icon } from "./ds";

/* --------------------------------------------------------------------- rail */

type RailItem = { href: string; label: string; icon: Parameters<typeof Icon>[0]["name"] };

export function Rail({ reviews, canRegister }: { reviews: number; canRegister: boolean }) {
  const path = usePathname();
  const items: RailItem[] = [
    { href: "/today", label: "Today", icon: "today" },
    { href: "/registry", label: "Registry", icon: "registry" },
    ...(canRegister ? [{ href: "/registry/new", label: "Intake", icon: "intake" } as RailItem] : []),
    { href: "/reviews", label: reviews > 0 ? `Reviews · ${reviews}` : "Reviews", icon: "reviews" },
    { href: "/audit", label: "Audit", icon: "audit" },
    { href: "/packs", label: "Packs", icon: "packs" },
    { href: "/agents", label: "Agents", icon: "agents" },
  ];
  const current = (href: string) =>
    href === "/registry" ? path === "/registry" || /^\/registry\/[0-9a-f-]{36}/.test(path) : path === href || path.startsWith(`${href}/`);
  return (
    <nav className="rail" aria-label="Primary">
      {items.map((item) => (
        <Link key={item.href} href={item.href} aria-current={current(item.href) ? "page" : undefined}>
          <Icon name={item.icon} />
          {item.label}
        </Link>
      ))}
    </nav>
  );
}

/* -------------------------------------------------------------- person menu */

/** A native <details> stays open until its summary is clicked again; close it the way menus close. */
function useDismiss(ref: React.RefObject<HTMLDetailsElement | null>) {
  useEffect(() => {
    const close = (event: Event) => {
      const details = ref.current;
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
  }, [ref]);
}

export function PersonMenu({
  current,
  personas,
  theme,
}: {
  current: Persona;
  personas: readonly Persona[];
  theme: "auto" | "dark" | "light";
}) {
  const path = usePathname();
  const menu = useRef<HTMLDetailsElement>(null);
  useDismiss(menu);
  const role = ROLE[current.roles[0] ?? ""]?.label ?? "";
  return (
    <details className="menu" ref={menu}>
      <summary aria-label={`${current.displayName}, ${role}. Open the person menu`}>
        <ActorMark kind="human" name={current.displayName} size={32} />
        <span className="actor-name">
          <strong>{current.displayName}</strong>
          <span>{role}</span>
        </span>
      </summary>
      <div className="menu-panel">
        {personas.length > 0 ? (
          <div className="stack" style={{ gap: 6 }}>
            <span className="eyebrow">Act as someone else</span>
            <p className="hint">See Aegis from another seat. Switching people only works in a sandbox.</p>
            {personas.map((p) => (
              <form action={switchPersona} key={p.userId}>
                <input type="hidden" name="userId" value={p.userId} />
                <input type="hidden" name="returnTo" value={path} />
                <button className="persona-option" type="submit" aria-current={p.userId === current.userId}>
                  <ActorMark kind="human" name={p.displayName} size={32} />
                  <span>
                    {p.displayName} · {ROLE[p.roles[0] ?? ""]?.label}
                    <small>{p.title}</small>
                  </span>
                </button>
              </form>
            ))}
          </div>
        ) : null}
        <div className="stack" style={{ gap: 6 }}>
          <span className="eyebrow">Theme</span>
          <div className="seg seg-sm" role="group" aria-label="Theme">
            {(["auto", "dark", "light"] as const).map((t) => (
              <form action={setTheme} key={t} style={{ display: "contents" }}>
                <input type="hidden" name="theme" value={t} />
                <button type="submit" aria-pressed={theme === t}>
                  {t === "auto" ? "System" : t === "dark" ? "Dark" : "Light"}
                </button>
              </form>
            ))}
          </div>
        </div>
        <form action={signOut}>
          <button className="btn btn-sm btn-block" type="submit">
            Sign out
          </button>
        </form>
      </div>
    </details>
  );
}

/* ---------------------------------------------------------- command palette */

export interface PaletteItem {
  readonly href: string;
  readonly label: string;
  readonly meta?: string;
  readonly group: "Pages" | "Systems";
}

/** ⌘K from anywhere: jump to a page or a system, or search the audit log. */
export function CommandPalette({ items }: { items: readonly PaletteItem[] }) {
  const router = useRouter();
  const dialog = useRef<HTMLDialogElement>(null);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matched = q
      ? items.filter((i) => i.label.toLowerCase().includes(q) || i.meta?.toLowerCase().includes(q))
      : items;
    const search: PaletteItem[] = q
      ? [{ href: `/audit?q=${encodeURIComponent(query.trim())}`, label: `Search the audit log for “${query.trim()}”`, group: "Pages" }]
      : [];
    return [...matched.slice(0, 12), ...search];
  }, [items, query]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        open();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

  function open() {
    setQuery("");
    setActive(0);
    if (!dialog.current?.open) dialog.current?.showModal();
  }
  function go(item: PaletteItem | undefined) {
    if (!item) return;
    dialog.current?.close();
    router.push(item.href);
  }

  return (
    <>
      <button type="button" className="search-trigger" onClick={open} aria-label="Search cases, systems and pages" aria-keyshortcuts="Meta+K Control+K">
        <Icon name="search" size={16} />
        <span>Search cases, systems and policies</span>
        <kbd>⌘K</kbd>
      </button>
      <dialog
        ref={dialog}
        className="palette"
        aria-label="Search"
        onClick={(event) => {
          if (event.target === dialog.current) dialog.current?.close();
        }}
      >
        <input
          type="text"
          aria-label="Search cases, systems and pages"
          placeholder="Type a system, a case number or a page"
          value={query}
          role="combobox"
          aria-expanded="true"
          aria-controls="palette-results"
          aria-activedescendant={results[active] ? `palette-${active}` : undefined}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setActive((i) => Math.min(i + 1, results.length - 1));
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              setActive((i) => Math.max(i - 1, 0));
            } else if (event.key === "Enter") {
              event.preventDefault();
              go(results[active]);
            } else if (event.key === "Escape") {
              event.preventDefault();
              dialog.current?.close();
            }
          }}
        />
        <ul id="palette-results" role="listbox" aria-label="Results">
          {results.length === 0 ? (
            <li className="hint" style={{ padding: 12 }}>
              Nothing matches. Try a case number such as CASE-0001.
            </li>
          ) : null}
          {results.map((item, i) => (
            <li key={`${item.href}-${i}`} role="presentation">
              {i === 0 || results[i - 1]!.group !== item.group ? <div className="eyebrow group">{item.group}</div> : null}
              <a
                id={`palette-${i}`}
                role="option"
                aria-selected={i === active}
                href={item.href}
                onMouseEnter={() => setActive(i)}
                onClick={(event) => {
                  event.preventDefault();
                  go(item);
                }}
              >
                <span>{item.label}</span>
                {item.meta ? <span className="mono-s">{item.meta}</span> : null}
              </a>
            </li>
          ))}
        </ul>
      </dialog>
    </>
  );
}
