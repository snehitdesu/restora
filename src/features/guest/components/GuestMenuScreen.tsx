"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { needsConfiguration } from "@/features/pos/modifiers";
import type { MenuItemDTO } from "@/features/pos/types";
import { toNumber } from "@/lib/format";
import { GUEST_MAX_QTY, useStorefront, type GuestMenuData } from "@/features/guest/storefront";
import { CartBar, MyOrdersSheet, OfflineBanner, TopBar } from "@/features/guest/components/Chrome";
import { Alert, ItemThumb, Stepper, VegMark, formatMenuPrice } from "@/features/guest/components/Bits";
import { SfIcon } from "@/features/guest/components/SfIcon";
import { CafeScene } from "@/features/guest/components/CafeScene";
import { useLandingMotion, useReveal } from "@/features/guest/motion";

export type { GuestMenuData };

type Category = { id: string; name: string; sortOrder: number };
type RevealRef = (el: HTMLElement | null) => void | (() => void);

/** Inputs that mean the guest is scrolling by hand (ends a category jump). */
const TAKEOVER = ["touchstart", "wheel", "keydown"] as const;

/** Programmatic scrolling is instant for guests who asked the system for reduced motion. */
const scrollBehavior = (): ScrollBehavior => (typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth");

/**
 * The storefront home for one table: a short branded landing (what the café
 * is, where, when — only what the restaurant entered in RESTORA), then the
 * whole menu by category with a sticky category bar, and the cart bar.
 *
 * With the illustrated café (Coders' Cafe) the landing is immersive: a
 * full-bleed scene under a fascia-coloured header, scroll parallax in CSS,
 * and the menu blocks rising into place once as they reach the viewport.
 */
export function GuestMenuScreen() {
  const { data, brand } = useStorefront();
  const [myOrders, setMyOrders] = useState(false);
  const immersive = brand.codeAccents;
  const rootRef = useRef<HTMLDivElement>(null);
  const heroRef = useRef<HTMLElement>(null);
  const menuRef = useRef<HTMLElement | null>(null);
  const goToMenu = () => menuRef.current?.scrollIntoView({ behavior: scrollBehavior(), block: "start" });
  useLandingMotion(rootRef, heroRef, immersive);
  const reveal = useReveal(immersive);
  // the menu section is both the scroll target and a reveal block (React 19 ref cleanup clears it)
  const menuSection = useCallback(
    (el: HTMLElement | null) => {
      menuRef.current = el;
      const stop = reveal(el);
      return () => {
        stop?.();
        menuRef.current = null;
      };
    },
    [reveal]
  );

  return (
    <div className="sf-page-pad" ref={rootRef} data-landing={immersive ? "immersive" : undefined}>
      <TopBar onMyOrders={() => setMyOrders(true)} />
      <OfflineBanner />
      <Hero data={data} onOrder={goToMenu} heroRef={heroRef} immersive={immersive} />
      <main className="sf-wrap sf-home">
        {data.ordering && !data.ordering.open && (
          <div style={{ marginTop: 14 }}>
            <Alert tone="warn" role="status">{data.ordering.message}</Alert>
          </div>
        )}
        <ol className="sf-ribbon" aria-label="How it works" ref={reveal}>
          <li>
            <span aria-hidden="true">01</span> Scan{brand.codeAccents ? " ✓" : ""}
          </li>
          <li>
            <span aria-hidden="true">02</span> Order
          </li>
          <li>
            <span aria-hidden="true">03</span> Track live
          </li>
        </ol>
        <section ref={menuSection} id="menu" aria-labelledby="menu-title" style={{ scrollMarginTop: 64 }}>
          <Menu reveal={reveal} />
        </section>
        <About data={data} reveal={reveal} />
        <footer className="sf-footer">
          <span className="sf-footer-sign" aria-hidden="true">
            {data.restaurant.name}
          </span>
          {brand.strap && <span className="sf-footer-strap">{brand.strap}</span>}
          <p className="sf-foot">
            Menu prices are before GST; GST is added in your cart. Ordering for Table {data.table.code}.
          </p>
        </footer>
      </main>
      <CartBar />
      {myOrders && <MyOrdersSheet onClose={() => setMyOrders(false)} />}
    </div>
  );
}

function Hero({ data, onOrder, heroRef, immersive }: { data: GuestMenuData; onOrder: () => void; heroRef: RefObject<HTMLElement | null>; immersive: boolean }) {
  const { brand } = useStorefront();
  const hours = data.restaurant.hours?.label ?? null;
  const closed = data.ordering?.open === false;
  const card = (
    <div className="sf-hero-card">
      <span className="sf-hero-kicker">
        {brand.codeAccents ? "</> " : ""}
        {data.restaurant.name} · Table {data.table.code}
      </span>
      <h1 id="hero-title" className="sf-hero-title">
        {brand.tagline.map((l) => (
          <span key={l}>{l}</span>
        ))}
      </h1>
      <p className="sf-hero-strap">Order from your table, pay by cash or online, and follow your order live.</p>
      <div className="sf-hero-ctas">
        <button type="button" className="sf-btn sf-btn-accent sf-btn-lg" onClick={onOrder}>
          Order now
        </button>
        <a className="sf-btn sf-btn-outline-light sf-btn-lg" href="#menu" onClick={(e) => { e.preventDefault(); onOrder(); }}>
          View menu
        </a>
      </div>
      {(hours || data.restaurant.address) && (
        <div className="sf-hero-facts">
          {hours && (
            <span className={`sf-fact ${closed ? "sf-fact-closed" : "sf-fact-open"}`}>
              <SfIcon name="clock" />
              {closed ? "Closed now" : "Open"} · {hours}
            </span>
          )}
          {data.restaurant.address && (
            <span className="sf-fact">
              <SfIcon name="pin" />
              {data.restaurant.address.length > 42 ? `${data.restaurant.address.slice(0, 40)}…` : data.restaurant.address}
            </span>
          )}
        </div>
      )}
    </div>
  );
  return (
    <section className={immersive ? "sf-hero sf-hero-immersive" : "sf-hero"} aria-labelledby="hero-title" ref={heroRef}>
      <div className="sf-hero-stage">
        {brand.codeAccents ? <CafeScene /> : <div className="sf-scene sf-scene-plain" aria-hidden="true" />}
        {/* immersive: the headline hangs from the awning on wide screens (the rods are drawn by CSS) */}
        {immersive ? <div className="sf-hero-hang">{card}</div> : card}
      </div>
    </section>
  );
}

function Menu({ reveal }: { reveal: RevealRef }) {
  const { data, cart, dispatch, quickAdd, openItem } = useStorefront();
  const [query, setQuery] = useState("");
  const [vegOnly, setVegOnly] = useState(false);
  const [active, setActive] = useState<string | null>(null);
  const tabsRef = useRef<HTMLDivElement>(null);

  const categories = useMemo(() => {
    const seen = new Map<string, Category>();
    for (const i of data.menu) if (i.category) seen.set(i.category.id, i.category);
    const list = [...seen.values()].sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
    if (data.menu.some((i) => !i.category)) list.push({ id: "_other", name: "More", sortOrder: 1e9 });
    return list;
  }, [data.menu]);

  const q = query.trim().toLowerCase();
  const visible = useMemo(() => data.menu.filter((i) => (!vegOnly || i.isVeg) && (!q || i.name.toLowerCase().includes(q) || (i.description ?? "").toLowerCase().includes(q))), [data.menu, q, vegOnly]);
  const groups = categories.map((c) => ({ ...c, items: visible.filter((i) => (i.categoryId ?? "_other") === c.id) })).filter((g) => g.items.length > 0);

  // While a tapped category scrolls into place, the sections it passes must not take the
  // highlight (measured: it cycled through every category in between for up to a second).
  const jumping = useRef(false);

  // Highlight the category being read; keep its tab in view.
  useEffect(() => {
    const sections = groups.map((g) => document.getElementById(`cat-${g.id}`)).filter(Boolean) as HTMLElement[];
    if (!sections.length || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(
      (entries) => {
        if (jumping.current) return;
        const top = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        if (top) setActive(top.target.id.slice(4));
      },
      { rootMargin: "-130px 0px -60% 0px", threshold: 0 }
    );
    sections.forEach((s) => io.observe(s));
    return () => io.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groups.map((g) => g.id).join("|")]);
  useEffect(() => {
    if (!active) return;
    const tab = tabsRef.current?.querySelector<HTMLElement>(`[data-cat="${active}"]`);
    tab?.scrollIntoView({ block: "nearest", inline: "center", behavior: scrollBehavior() });
  }, [active]);

  const releaseJump = useRef<(() => void) | null>(null);
  useEffect(() => () => releaseJump.current?.(), []);

  function jump(id: string) {
    setActive(id);
    const section = document.getElementById(`cat-${id}`);
    if (!section) return;
    releaseJump.current?.();
    jumping.current = true;
    // Released once the page stops scrolling (no scroll event for 150 ms), when the guest
    // takes over (touch / wheel / key), or after 2 s at most.
    let quiet = 0;
    let cap = 0;
    const release = () => {
      jumping.current = false;
      window.clearTimeout(quiet);
      window.clearTimeout(cap);
      window.removeEventListener("scroll", onScroll);
      for (const t of TAKEOVER) window.removeEventListener(t, release);
      releaseJump.current = null;
    };
    const onScroll = () => {
      window.clearTimeout(quiet);
      quiet = window.setTimeout(release, 150);
    };
    cap = window.setTimeout(release, 2000);
    window.addEventListener("scroll", onScroll, { passive: true });
    for (const t of TAKEOVER) window.addEventListener(t, release, { passive: true });
    releaseJump.current = release;
    onScroll(); // already in place: nothing scrolls, release after the quiet period
    section.scrollIntoView({ behavior: scrollBehavior(), block: "start" });
  }

  // Stable row handlers: a cart change re-renders only the rows whose quantity changed.
  const add = useCallback((item: MenuItemDTO) => (needsConfiguration(item) ? openItem(item) : quickAdd(item)), [openItem, quickAdd]);
  const dec = useCallback((key: string) => dispatch({ type: "dec", key }), [dispatch]);
  const inc = useCallback((key: string) => dispatch({ type: "inc", key }), [dispatch]);

  return (
    <>
      <div className="sf-board">
        <div className="sf-menu-head">
          <h2 id="menu-title" className="sf-h1">
            The <em>menu</em>
          </h2>
          <span className="sf-count">
            {data.menu.length} dishes · {categories.length} categories
          </span>
        </div>
        <label className="sf-search">
          <SfIcon name="search" />
          <span className="sf-sr">Search the menu</span>
          <input id="guest-search" name="search" type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search pizza, pasta, wings…" autoComplete="off" enterKeyHint="search" />
          {query && (
            <button type="button" className="sf-link" onClick={() => setQuery("")} aria-label="Clear search">
              <SfIcon name="x" />
            </button>
          )}
        </label>
        <div className="sf-filters">
          <button type="button" className="sf-toggle" aria-pressed={vegOnly} onClick={() => setVegOnly((v) => !v)}>
            <VegMark veg labelled={false} /> Veg only
          </button>
        </div>
      </div>

      {groups.length > 0 && (
        <nav className="sf-tabs" aria-label="Menu categories" ref={reveal}>
          <div className="sf-tabs-scroll" ref={tabsRef}>
            {groups.map((g) => (
              <button key={g.id} type="button" className="sf-tab" data-cat={g.id} aria-current={active === g.id ? "true" : undefined} onClick={() => jump(g.id)}>
                {g.name}
              </button>
            ))}
          </div>
        </nav>
      )}

      {groups.length === 0 ? (
        <div className="sf-empty" role="status">
          <SfIcon name="search" />
          <h3>Nothing matches</h3>
          <p>Try another word{vegOnly ? ", or turn off Veg only" : ""}.</p>
        </div>
      ) : (
        groups.map((g) => (
          <section key={g.id} id={`cat-${g.id}`} className="sf-cat" aria-labelledby={`cat-h-${g.id}`} ref={reveal}>
            <div className="sf-cat-head">
              <h2 id={`cat-h-${g.id}`}>{g.name}</h2>
              <span className="sf-count">{g.items.length}</span>
            </div>
            <ul className="sf-items" aria-label={g.name}>
              {g.items.map((item) => (
                <ItemRow key={item.id} item={item} cartQty={cart.lines.filter((l) => l.menuItemId === item.id).reduce((n, l) => n + l.qty, 0)} simpleLine={cart.lines.find((l) => l.menuItemId === item.id && !l.variantId && !l.modifierOptionIds.length && !l.notes)} onAdd={add} onOpen={openItem} onDec={dec} onInc={inc} closed={data.ordering?.open === false} />
              ))}
            </ul>
          </section>
        ))
      )}
    </>
  );
}

const ItemRow = memo(function ItemRow({
  item,
  cartQty,
  simpleLine,
  onAdd,
  onOpen,
  onDec,
  onInc,
  closed,
}: {
  item: MenuItemDTO;
  cartQty: number;
  simpleLine?: { key: string; qty: number };
  onAdd: (item: MenuItemDTO) => void;
  onOpen: (item: MenuItemDTO) => void;
  onDec: (key: string) => void;
  onInc: (key: string) => void;
  closed: boolean;
}) {
  const configurable = needsConfiguration(item);
  const sizes = item.variants.filter((v) => v.active).length;
  const maxPrice = sizes ? Math.max(...item.variants.filter((v) => v.active).map((v) => item.effectivePrice + toNumber(v.priceDelta))) : null;
  const soldOut = item.effectiveSoldOut;
  return (
    <li className="sf-item" data-soldout={soldOut}>
      <ItemThumb name={item.name} seed={item.name} />
      <div className="sf-item-main">
        <h3 className="sf-item-title">
          <VegMark veg={item.isVeg} />
          <button type="button" onClick={() => onOpen(item)} aria-label={`${item.name} — details`}>
            {item.name}
          </button>
        </h3>
        {item.description && <p className="sf-item-desc">{item.description}</p>}
        <div className="sf-item-foot">
          <span className="sf-price">
            {formatMenuPrice(item.effectivePrice)}
            {sizes > 0 && maxPrice !== null && maxPrice !== item.effectivePrice ? <span> – {formatMenuPrice(maxPrice)}</span> : null}
            {configurable && <small>{sizes ? `${sizes + 1} sizes` : "+ add-ons"}</small>}
          </span>
          {soldOut ? (
            <span className="sf-soldout">Sold out</span>
          ) : !configurable && simpleLine ? (
            <Stepper value={simpleLine.qty} max={GUEST_MAX_QTY} onDec={() => onDec(simpleLine.key)} onInc={() => onInc(simpleLine.key)} label={item.name} />
          ) : (
            <button type="button" className="sf-add" onClick={() => onAdd(item)} aria-label={`Add ${item.name}`} data-in-cart={cartQty > 0} disabled={closed}>
              <SfIcon name="plus" strokeWidth={2.5} />
              {cartQty > 0 ? `Add · ${cartQty}` : "Add"}
            </button>
          )}
        </div>
      </div>
    </li>
  );
});

function About({ data, reveal }: { data: GuestMenuData; reveal: RevealRef }) {
  const { brand } = useStorefront();
  const r = data.restaurant;
  const hours = r.hours?.label ?? null;
  const directions = r.address ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${data.restaurant.name}, ${r.address}`)}` : null;
  const hasFacts = Boolean(r.address || hours || r.phone);
  if (!brand.about && !hasFacts) return null;
  return (
    <section className="sf-about" aria-labelledby="about-title" id="about" ref={reveal}>
      <div className="sf-about-awning" aria-hidden="true" />
      <h2 id="about-title">
        About <em>{r.name}</em>
      </h2>
      {brand.strap && <p className="sf-mono">{brand.strap}</p>}
      {brand.about && <p>{brand.about}</p>}
      {hasFacts && (
        <dl>
          {r.address && (
            <div>
              <SfIcon name="pin" />
              <dt>Location</dt>
              <dd>{r.address}</dd>
            </div>
          )}
          {hours && (
            <div>
              <SfIcon name="clock" />
              <dt>Opening hours</dt>
              <dd>{hours}</dd>
            </div>
          )}
          {r.phone && (
            <div>
              <SfIcon name="phone" />
              <dt>Contact</dt>
              <dd>
                <a href={`tel:${r.phone.replace(/[^\d+]/g, "")}`}>{r.phone}</a>
              </dd>
            </div>
          )}
        </dl>
      )}
      {directions && (
        <a className="sf-btn sf-btn-accent sf-btn-block" href={directions} target="_blank" rel="noopener noreferrer">
          <SfIcon name="pin" /> Get directions
        </a>
      )}
    </section>
  );
}
