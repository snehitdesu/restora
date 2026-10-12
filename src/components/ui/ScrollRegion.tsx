"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * A box that scrolls (a wide table on a phone, a long list). Keyboard users cannot reach content that only scrolls, so when
 * the content really overflows the box becomes a focusable, named region (arrow keys then scroll it); when everything fits it
 * adds no tab stop.
 */
export function ScrollRegion({ label, axis = "x", className = "", children }: { label: string; axis?: "x" | "y"; className?: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [scrolls, setScrolls] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setScrolls(axis === "x" ? el.scrollWidth > el.clientWidth + 1 : el.scrollHeight > el.clientHeight + 1);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    for (const child of Array.from(el.children)) ro.observe(child);
    return () => ro.disconnect();
  }, [axis]);
  return (
    <div
      ref={ref}
      className={`${axis === "x" ? "overflow-x-auto" : "overflow-y-auto"} ${scrolls ? "focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand-500" : ""} ${className}`}
      {...(scrolls ? { tabIndex: 0, role: "region", "aria-label": label } : {})}
    >
      {children}
    </div>
  );
}
