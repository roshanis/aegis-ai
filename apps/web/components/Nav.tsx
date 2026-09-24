"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export function Nav({ assets, needsYou, canRegister }: { assets: number; needsYou: number; canRegister: boolean }) {
  const path = usePathname();
  const current = (href: string) => (path === href ? "page" : undefined);
  return (
    <nav className="nav" aria-label="Main">
      <Link href="/registry" aria-current={current("/registry")}>
        Registry
        {needsYou > 0 ? (
          <span className="count" title={`${needsYou} need you`}>
            {needsYou}
          </span>
        ) : (
          <span className="faint">{assets}</span>
        )}
      </Link>
      {canRegister ? (
        <Link href="/registry/new" aria-current={current("/registry/new")}>
          Register AI
        </Link>
      ) : null}
    </nav>
  );
}
