import "server-only";
import { cookies } from "next/headers";

export const THEMES = ["auto", "dark", "light"] as const;
export type Theme = (typeof THEMES)[number];

const COOKIE = "aegis_theme";

/** The theme this person picked; "auto" follows their system setting. */
export async function readTheme(): Promise<Theme> {
  const value = (await cookies()).get(COOKIE)?.value;
  return THEMES.includes(value as Theme) ? (value as Theme) : "auto";
}

export async function writeTheme(theme: Theme): Promise<void> {
  (await cookies()).set(COOKIE, theme, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
  });
}
