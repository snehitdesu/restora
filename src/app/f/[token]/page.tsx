import { FeedbackLinkScreen } from "@/features/guest/components/GuestLinks";
import "@/features/guest/storefront.css";

// Public feedback page: the link we send after a meal. The token is the credential; nothing is cached or indexed.
export const dynamic = "force-dynamic";
export const metadata = { title: "How was your visit?", robots: { index: false, follow: false }, referrer: "no-referrer" };
export const viewport = { width: "device-width", initialScale: 1, viewportFit: "cover" };

export default async function Page({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <FeedbackLinkScreen token={token} />;
}
