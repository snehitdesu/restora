"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef } from "react";

/** How long a client-side navigation may take before the browser loads the page itself. */
export const NAVIGATION_WATCHDOG_MS = 4_000;

/**
 * `router.push` with a watchdog, for the back-office list → detail moves (a
 * row click, or a create dialog opening the record it just saved).
 *
 * Next 15 / React 19 sometimes fetch the next page and never commit the
 * transition: the URL stays put and the page stops responding (seen in the
 * E2E suite since 2026-10-06; matches vercel/next.js#83386, closed upstream
 * without a fix). The record IS saved, so a person who sees nothing happen may
 * save it again. If the address has not changed after NAVIGATION_WATCHDOG_MS,
 * the browser navigates there itself. A navigation that completes unmounts
 * the page, which cancels the timer.
 */
const loadPage = (url: string) => window.location.assign(url);

export function useRouterWithWatchdog(hardNavigate: (url: string) => void = loadPage): { push: (href: string) => void } {
  const router = useRouter();
  const timer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    []
  );
  return useMemo(
    () => ({
      push(href: string) {
        router.push(href);
        if (timer.current !== null) window.clearTimeout(timer.current);
        const target = new URL(href, window.location.href);
        timer.current = window.setTimeout(() => {
          timer.current = null;
          if (window.location.pathname === target.pathname && window.location.search === target.search) return;
          console.warn("[restora] client navigation did not complete; loading the page directly", { path: target.pathname });
          hardNavigate(target.href);
        }, NAVIGATION_WATCHDOG_MS);
      },
    }),
    [router, hardNavigate]
  );
}
