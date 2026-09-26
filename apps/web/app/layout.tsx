import "@fontsource/geist-sans/400.css";
import "@fontsource/geist-sans/500.css";
import "@fontsource/geist-sans/600.css";
import "@fontsource/geist-sans/700.css";
import "@fontsource/geist-mono/400.css";
import "@fontsource/geist-mono/500.css";
import "@fontsource/instrument-serif/400.css";
import "@fontsource/instrument-serif/400-italic.css";
import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { readTheme } from "@/lib/theme";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Aegis", template: "%s · Aegis" },
  description: "AI governance for health plans. Agents draft, people decide, and every decision can be proved.",
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: dark)", color: "#0b0e13" },
    { media: "(prefers-color-scheme: light)", color: "#eeece6" },
  ],
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  const theme = await readTheme();
  return (
    <html lang="en" data-theme={theme === "auto" ? undefined : theme}>
      <body>{children}</body>
    </html>
  );
}
