"use client";

/**
 * "Suggest" strip for whoever is taking an order (audit ME-04): up to three dishes guests at this outlet really pair with
 * what is on the order, or that are worth recommending. The server picks them and gives the reason in words; a tap hands the
 * dish back to the caller, which adds it the same way a tap on the menu would (so sizes and add-ons are still asked for).
 * Quiet by design: while loading, on any error and when there is nothing to say, it renders nothing.
 */
import { useEffect, useState } from "react";
import { api } from "@/lib/api/client";
import { BACKGROUND_HEADER } from "@/constants/auth";
import { formatMoney } from "@/lib/format";
import { Icon } from "@/components/ui/Icon";

export type UpsellHint = { menuItemId: string; name: string; price: number; reason: "PAIRS_WITH" | "FEATURED" | "POPULAR"; with?: string; text: string };

export function UpsellStrip({ outletId, menuItemIds, onAdd, disabled = false }: { outletId: string; menuItemIds: string[]; onAdd: (hint: UpsellHint) => void; disabled?: boolean }) {
  const [hints, setHints] = useState<UpsellHint[]>([]);
  const key = [...new Set(menuItemIds)].sort().join(",");
  useEffect(() => {
    if (!key || disabled) {
      setHints([]);
      return;
    }
    const ctrl = new AbortController();
    const t = setTimeout(() => {
      api<UpsellHint[]>("/api/menu/upsell", { query: { outletId, items: key, limit: 3 }, signal: ctrl.signal, headers: { [BACKGROUND_HEADER]: "1" } })
        .then((h) => { if (!ctrl.signal.aborted) setHints(h); })
        .catch(() => { if (!ctrl.signal.aborted) setHints([]); });
    }, 400);
    return () => { clearTimeout(t); ctrl.abort(); };
  }, [outletId, key, disabled]);
  if (!hints.length) return null;
  return (
    <section aria-label="Suggestions" className="border-t border-ink-200 bg-vanilla-50 px-3 py-2">
      <p className="mb-1 flex items-center gap-1 text-[11px] font-semibold uppercase tracking-eyebrow text-ink-600"><Icon name="star" className="h-3 w-3" /> Suggest</p>
      <ul className="flex flex-wrap gap-2">
        {hints.map((h) => (
          <li key={h.menuItemId}>
            <button type="button" onClick={() => onAdd(h)} title={h.text}
              className="rounded-full border border-vanilla-300 bg-paper px-3 py-1.5 text-left text-sm font-medium text-ink-900 shadow-xs hover:bg-vanilla-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-500">
              <span className="sr-only">Add </span>{h.name} <span className="tabular-nums text-ink-600">{formatMoney(h.price)}</span>
              <span className="block text-[11px] font-normal text-ink-500">{h.text}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
