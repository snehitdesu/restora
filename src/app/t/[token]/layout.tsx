import type { Metadata, Viewport } from "next";
import { cache, type ReactNode } from "react";
import { guestMenuFor, resolveTable, type GuestTable } from "@/server/services/guestOrdering";
import { NotFoundError } from "@/server/db/scope";
import { StorefrontProvider, type GuestMenuData } from "@/features/guest/storefront";
import { StorefrontOverlays } from "@/features/guest/components/Chrome";
import { SfIcon } from "@/features/guest/components/SfIcon";
import { brandFor } from "@/features/guest/brand";
import "@/features/guest/storefront.css";

// Public guest website for one table (its QR code). No session: the table token
// is the only input, resolved server-side to restaurant → outlet → table.
export const dynamic = "force-dynamic";

/** The table behind the token, resolved once per request (metadata, viewport and layout share it). */
const table = cache(async (token: string): Promise<GuestTable | null> => {
  try {
    return await resolveTable(token);
  } catch (e) {
    if (e instanceof NotFoundError) return null;
    throw e;
  }
});

/**
 * The menu is loaded by the layout render only. A client navigation between
 * this table's pages (menu ↔ cart ↔ checkout) re-runs the metadata but not the
 * layout, so it costs the table lookup, never the menu or a gateway health check.
 */
const load = cache(async (token: string): Promise<GuestMenuData | null> => {
  const t = await table(token);
  return t ? ((await guestMenuFor(t)) as GuestMenuData) : null;
});

type Props = { params: Promise<{ token: string }>; children: ReactNode };

export async function generateMetadata({ params }: Omit<Props, "children">): Promise<Metadata> {
  const t = await table((await params).token);
  return {
    title: t ? `${t.restaurantName} · Table ${t.table.code}` : "Table QR",
    description: t ? `Order from Table ${t.table.code} at ${t.restaurantName}.` : undefined,
    robots: { index: false, follow: false },
    referrer: "no-referrer",
  };
}

export async function generateViewport({ params }: Omit<Props, "children">): Promise<Viewport> {
  const t = await table((await params).token);
  return { themeColor: brandFor(t?.restaurantName).themeColor, width: "device-width", initialScale: 1, viewportFit: "cover" };
}

export default async function GuestTableLayout({ params, children }: Props) {
  const { token } = await params;
  const data = await load(token);
  if (!data) return <InvalidQr />;
  const brand = brandFor(data.restaurant.name);
  return (
    <div className="sf" data-theme={brand.theme}>
      <StorefrontProvider token={token} initial={data}>
        {children}
        <StorefrontOverlays />
      </StorefrontProvider>
    </div>
  );
}

/** Unknown, rotated or disabled QR, or a restaurant that is not active: one message (no hint about which). */
function InvalidQr() {
  return (
    <div className="sf" data-theme="classic">
      <main className="sf-notice">
        <div className="sf-notice-card">
          <div className="sf-notice-ico">
            <SfIcon name="qr" />
          </div>
          <h1>This QR code isn&apos;t working</h1>
          <p>It may have been replaced or switched off. Please ask a member of staff — they can help you order.</p>
          <span className="sf-mono">QR code not recognised</span>
        </div>
      </main>
    </div>
  );
}
