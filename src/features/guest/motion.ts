"use client";

import { useCallback, useEffect, useLayoutEffect, type RefObject } from "react";

/**
 * Storefront scroll motion that needs a little JS: one-shot reveals as blocks
 * enter the viewport, and whether the landing hero is still under the header.
 * IntersectionObserver only — no scroll listeners and no React state per
 * scroll. (The hero parallax itself is CSS scroll-driven; see storefront.css.)
 *
 * Nothing is ever hidden unless this runs: the stylesheet only applies the
 * "before" state under [data-motion] (set here) and prefers-reduced-motion:
 * no-preference, and a block already on screen when it mounts is shown as is.
 */

const useIsoLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

let shared: IntersectionObserver | null = null;

function revealObserver() {
  shared ??= new IntersectionObserver(
    (entries, io) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        e.target.setAttribute("data-revealed", "");
        io.unobserve(e.target);
      }
    },
    // once a block is ~8% up the screen: visible enough to notice, short enough to settle before a tap
    { rootMargin: "0px 0px -8% 0px" }
  );
  return shared;
}

/**
 * Blocks mounted in one React commit, sorted in one pass after it (a microtask,
 * so still before the first paint): every position is read first, then the
 * attributes are written. Reading and writing per element made the browser
 * redo style and layout for each block (measured: 17 forced layouts when the
 * menu page is shown again).
 */
const pending = new Set<HTMLElement>();

function sortPending() {
  const els = [...pending];
  pending.clear();
  const vh = window.innerHeight;
  const shown = els.map((el) => {
    const r = el.getBoundingClientRect();
    return r.bottom > 0 && r.top < vh;
  });
  els.forEach((el, i) => {
    if (shown[i]) {
      el.setAttribute("data-revealed", "");
      return;
    }
    el.setAttribute("data-reveal", "");
    revealObserver().observe(el);
  });
}

/**
 * A ref callback that reveals its element the first time it scrolls into view.
 * One callback can serve many elements (React 19 ref cleanups), and elements
 * that mount later — a filtered category, the category bar — are handled too.
 */
export function useReveal(enabled: boolean) {
  return useCallback(
    (el: HTMLElement | null) => {
      if (!el || !enabled || el.hasAttribute("data-revealed")) return;
      if (typeof IntersectionObserver === "undefined") {
        el.setAttribute("data-revealed", "");
        return;
      }
      if (!pending.size) queueMicrotask(sortPending);
      pending.add(el);
      return () => {
        pending.delete(el);
        shared?.unobserve(el);
      };
    },
    [enabled]
  );
}

/**
 * Turns reveal styling on for a page root, and marks the root `data-past-hero`
 * once the hero has scrolled fully under the sticky header (the header then
 * changes from the café fascia to the plain menu bar).
 */
export function useLandingMotion(root: RefObject<HTMLElement | null>, hero: RefObject<HTMLElement | null>, enabled: boolean) {
  useIsoLayoutEffect(() => {
    const el = root.current;
    if (!el || !enabled || typeof IntersectionObserver === "undefined") return;
    el.setAttribute("data-motion", "");
    const heroEl = hero.current;
    let io: IntersectionObserver | undefined;
    if (heroEl) {
      const top = parseFloat(getComputedStyle(el).getPropertyValue("--sf-top-h")) || 60;
      io = new IntersectionObserver(([e]) => el.toggleAttribute("data-past-hero", !e.isIntersecting), { rootMargin: `-${top}px 0px 0px 0px` });
      io.observe(heroEl);
    }
    return () => {
      io?.disconnect();
      el.removeAttribute("data-motion");
      el.removeAttribute("data-past-hero");
    };
  }, [enabled]);
}
