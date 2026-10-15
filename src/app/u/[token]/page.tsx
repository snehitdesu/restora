import { UnsubscribeScreen } from "@/features/guest/components/GuestLinks";
import "@/features/guest/storefront.css";

// One-click unsubscribe from marketing messages. Opening the link changes nothing; the button does.
export const dynamic = "force-dynamic";
export const metadata = { title: "Unsubscribe", robots: { index: false, follow: false }, referrer: "no-referrer" };
export const viewport = { width: "device-width", initialScale: 1, viewportFit: "cover" };

export default async function Page({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <UnsubscribeScreen token={token} />;
}
