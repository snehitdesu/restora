# React hydration error #418 — investigation record

Status: **UNRESOLVED.** Not reproduced on demand; no root cause; no fix claimed.
The browser assertion that catches it (QUALITY-001: no page error / console
error) is kept unchanged and no warning is suppressed.

## What has been observed (historical, from earlier runs)

| When | Run | Where | Detail |
| --- | --- | --- | --- |
| 2026-10-14 → 10-21 | Full main E2E, several runs | `/inventory/issues`, `/procurement/grns`, `/customers`, `/master/vendors/<id>` | Only at phone widths (320–414), only in the QUALITY-001 sweep, ~0.5 s after the page's `goto`. Message: "Minified React error #418; args: HTML" — in this React build that means an **element-structure** mismatch (not text). |
| 2026-10-21 (full4 trace) | 134 / 135 | 3 erroring pages | All three were in the slow-HTML tail (wait + receive 620–770 ms vs. mean receive 81 ms); not every slow page errored. |
| 2026-10-21 / 22 | Full E2E full5, final | — | 135 / 135, no #418. |
| DOM after the error | trace snapshot | — | Loading state, then the full page: React re-rendered on the client and recovered; nothing wrong was visible. |

## What has been checked and ruled out

- **Shared shell** (`src/app/(app)/layout.tsx`, `AppShell`, `SideNav`,
  `OutletSwitcher`, `SearchPalette`, `ToastProvider`, `ReauthProvider`): no
  render-time reads of `window`, storage, `matchMedia`, the clock, random values
  or locale formatting. The only render-time `window` read
  (`ReauthProvider` sign-in link) renders inside a closed dialog, never at
  hydration. `useId` (SearchPalette) is hydration-safe.
- **Viewport-dependent rendering**: `matchMedia` / `innerWidth` are used only by
  the guest storefront and public site, not by staff pages; staff layouts are
  CSS-only responsive.
- **useQuery** caching (an earlier hypothesis): it has no cache, so first
  client render = loading state on both sides.
- **Dev-server reproduction** (2026-10-22, 72 loads × 3 viewports × document
  delay 0 / 1500 ms): 0 hydration errors (dev React would print the diff).

## Experiment added on 2026-10-22 (production build)

`next start` (the real production build, built after the last code change) on
a disposable database copy, Playwright Chromium at 390×844 and 320×568 with
`isMobile` / `hasTouch` like QUALITY-001, the four affected pages + dashboard,
four conditions × 4 rounds × 5 pages × 2 viewports = 160 loads:

1. CPU throttled 4× (slow hydration on the client);
2. CPU 4× + slow network (300 ms latency, 750 kbit/s down: HTML streams slowly,
   JS chunks arrive late);
3. CPU 6× + document held back 700 ms (the slow-HTML tail seen in the trace);
4. CPU 4× + a busy server (three other signed-in pages loading continuously,
   like a parallel E2E run).

Script: session scratchpad `h418/repro-prod.cjs` (outside the repository).

**Result: REPRODUCED locally for the first time.**

| Condition (production build) | Loads | #418 |
| --- | --- | --- |
| CPU 4× only | 40 | 0 |
| CPU 4× + slow network | 40 | 0 |
| CPU 6× + document held 700 ms | 40 | 0 |
| **CPU 4× + busy server** | 40 | **9** (`/customers`, `/dashboard`, `/inventory/issues`, `/master/vendors`; 390 and 320 px) |

Follow-up runs on the same production build, busy server, CPU 4× unless noted:

| Run | Loads | #418 | What it shows |
| --- | --- | --- | --- |
| 390 px, server HTML of every load saved | 40 | 6 (incl. `/procurement/grns`) | **The server HTML of failing loads is byte-identical to the clean loads of the same page** (same size, same body structure signature on all 8 rounds). The server renders the same document; the divergence is on the client, timing-dependent. |
| **1440 px desktop** | 30 | **6** | Not phone-specific (the history only looked phone-only). |
| 390 px, **no CPU throttling** | 30 | 0 | Needs a slow client *and* a busy server; neither alone. |
| `next dev` (non-minified React), CPU 2× + busy server | 40 | 0 | Not reproduced in development, so no React diff could be captured. |
| 1440 px, Next's bootstrap instrumented | 40 | 5 | Next starts its bootstrap while the document is still parsing (`readyState = loading`, ~400 elements) on **every** load, failing or not — by design (Next hydrates while streaming). Element counts at bootstrap do not separate failing from clean loads. |

Harness: session scratchpad `h418/repro-prod.cjs`, `repro-capture*.cjs`
(outside the repository), against `next start` on a disposable database copy.

What this rules out: different server output under load (cross-request state
leaking into the HTML — checked byte-for-byte), viewport-dependent rendering,
slow HTML alone, slow client alone.

## Remaining uncertainty and follow-up plan

There is now a local reproduction (about 10–20 % of loads under "CPU 4× +
busy server"), so the next steps no longer depend on luck:

1. **Get the React diff in a production build.** Next drops React's
   `componentStack` in production (`on-recoverable-error.js` reports only the
   error). In a throw-away copy (never committed), alias `react-dom/client` to
   React's development build in `next.config.mjs` (`webpack.resolve.alias`) and
   rerun `repro-prod.cjs`: the development build prints the mismatching
   element. Alternatively pass a custom `onRecoverableError` that logs
   `errorInfo.componentStack` by patching Next's `app-index.js` in the copy.
2. **Bisect with the harness** in that copy: a staff page with the shell only
   (no page content), then the shell without `SearchPalette` / `ToastProvider` /
   `ReauthProvider`, to find the smallest tree that still fails.
3. **Framework check:** rerun the harness on the newest Next 15.5.x / React 19
   patch release in the copy; the busy-server + slow-client dependence with
   identical HTML points at streaming hydration timing, possibly in the
   framework rather than in RESTORA's components.
4. If a component is found: fix it, add a regression test, and show the
   harness at 0 failing loads before closing.
4. Release decision until then: the error is intermittent, recovered by React,
   with no observed user-visible or data effect. Shipping with it is an
   **engineering-risk acceptance** the owner should make explicitly
   (blockers #11), not a "fixed".
