"use client";

/**
 * Universal search (audit PA-05): one box for the whole back office, opened from the top bar or with Ctrl/⌘ + K (or "/"
 * when no field has focus). Results come from the server grouped by kind and already limited to what this login may open;
 * arrow keys move, Enter opens, Esc closes.
 */
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { api, describeError } from "@/lib/api/client";
import { Dialog } from "@/components/ui/Dialog";
import { Icon } from "@/components/ui/Icon";

type Item = { id: string; title: string; subtitle: string | null; href: string };
type Group = { type: string; label: string; items: Item[] };
const MIN = 2;

export function SearchPalette() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [groups, setGroups] = useState<Group[]>([]);
  const [status, setStatus] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const listId = useId();
  const input = useRef<HTMLInputElement>(null);
  const flat = groups.flatMap((g) => g.items.map((i) => ({ ...i, key: `${g.type}:${i.id}` })));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLElement && (e.target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(e.target.tagName));
      if ((e.key === "k" || e.key === "K") && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        setOpen(true);
      } else if (e.key === "/" && !typing && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        setOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    const term = q.trim();
    if (!open || term.length < MIN) {
      setGroups([]);
      setStatus("idle");
      return;
    }
    const ctrl = new AbortController();
    setStatus("loading");
    const t = setTimeout(() => {
      api<{ groups: Group[] }>("/api/search", { query: { q: term }, signal: ctrl.signal })
        .then((r) => {
          if (ctrl.signal.aborted) return;
          setGroups(r.groups);
          setActive(0);
          setError(null);
          setStatus("done");
        })
        .catch((e) => {
          if (ctrl.signal.aborted || (e as { name?: string })?.name === "AbortError") return;
          setError(describeError(e));
          setStatus("error");
        });
    }, 250);
    return () => { clearTimeout(t); ctrl.abort(); };
  }, [q, open]);

  const close = useCallback(() => { setOpen(false); setQ(""); setGroups([]); setStatus("idle"); }, []);
  const go = (href: string) => { close(); router.push(href); };

  return (
    <>
      <button type="button" onClick={() => setOpen(true)} aria-label="Search (Ctrl+K)" aria-haspopup="dialog"
        className="inline-flex h-9 items-center gap-2 rounded-md border border-ink-300 bg-paper px-2.5 text-sm text-ink-500 transition-colors hover:border-ink-400 hover:text-ink-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-500">
        <Icon name="search" className="h-4 w-4" />
        <span className="hidden md:inline">Search</span>
        <kbd className="hidden rounded border border-ink-200 bg-ink-50 px-1 font-mono text-[10px] text-ink-500 md:inline">Ctrl K</kbd>
      </button>
      <Dialog open={open} onClose={close} title="Search" size="lg">
        <div className="-mt-1">
          <input
            ref={input} data-autofocus type="search" role="combobox" aria-expanded={flat.length > 0} aria-controls={listId} aria-autocomplete="list"
            aria-activedescendant={flat[active] ? `${listId}-${flat[active].key}` : undefined} aria-label="Search customers, orders, menu, materials, vendors, recipes and more"
            autoComplete="off" spellCheck={false} placeholder="Search customers, orders, dishes, materials, vendors…" value={q} onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown" && flat.length) { e.preventDefault(); setActive((a) => (a + 1) % flat.length); }
              else if (e.key === "ArrowUp" && flat.length) { e.preventDefault(); setActive((a) => (a - 1 + flat.length) % flat.length); }
              else if (e.key === "Enter" && flat[active]) { e.preventDefault(); go(flat[active].href); }
            }}
            className="h-11 w-full rounded-md border border-ink-300 bg-paper px-3 text-base text-ink-900 placeholder:text-ink-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-500"
          />
          <div className="mt-3 max-h-[50vh] overflow-y-auto" aria-live="polite">
            {q.trim().length < MIN ? (
              <p className="px-1 py-6 text-center text-sm text-ink-500">Type at least {MIN} characters. Try a customer&apos;s name or phone, an invoice number, a dish, a material or a vendor.</p>
            ) : status === "error" ? (
              <p role="alert" className="px-1 py-6 text-center text-sm text-bad-700">{error}</p>
            ) : status === "loading" && !groups.length ? (
              <p className="px-1 py-6 text-center text-sm text-ink-500">Searching…</p>
            ) : status === "done" && !groups.length ? (
              <p className="px-1 py-6 text-center text-sm text-ink-500">Nothing matches “{q.trim()}”.</p>
            ) : (
              <ul id={listId} role="listbox" aria-label="Results" className="space-y-3">
                {groups.map((g) => (
                  <li key={g.type} role="presentation">
                    <p className="px-1 pb-1 text-[11px] font-semibold uppercase tracking-eyebrow text-ink-500" aria-hidden>{g.label}</p>
                    <ul role="group" aria-label={g.label} className="space-y-0.5">
                      {g.items.map((i) => {
                        const key = `${g.type}:${i.id}`;
                        const isActive = flat[active]?.key === key;
                        return (
                          <li key={key} id={`${listId}-${key}`} role="option" aria-selected={isActive}>
                            <button type="button" tabIndex={-1} onClick={() => go(i.href)} onMouseMove={() => setActive(flat.findIndex((f) => f.key === key))}
                              className={`flex w-full items-baseline justify-between gap-3 rounded-md px-3 py-2 text-left text-sm ${isActive ? "bg-brand-50 text-ink-900" : "text-ink-800 hover:bg-ink-50"}`}>
                              <span className="min-w-0 truncate font-medium">{i.title}</span>
                              {i.subtitle && <span className="shrink-0 truncate text-xs text-ink-500">{i.subtitle}</span>}
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </Dialog>
    </>
  );
}
