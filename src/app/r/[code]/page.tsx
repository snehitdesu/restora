import { ReferralLandingScreen } from "@/features/guest/components/GuestLinks";
import "@/features/guest/storefront.css";

// A friend's invite link. It only keeps the code on the visitor's phone; the server checks it when an order is placed.
export const dynamic = "force-dynamic";
export const metadata = { title: "You're invited", robots: { index: false, follow: false }, referrer: "no-referrer" };
export const viewport = { width: "device-width", initialScale: 1, viewportFit: "cover" };

export default async function Page({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  return <ReferralLandingScreen code={code} />;
}
