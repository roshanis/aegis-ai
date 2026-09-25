"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/** Re-render the page from the server every few seconds while background work (a draft, an evaluation) is running. */
export function AutoRefresh({ everyMs = 2500 }: { everyMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    const timer = setInterval(() => router.refresh(), everyMs);
    return () => clearInterval(timer);
  }, [router, everyMs]);
  return null;
}
