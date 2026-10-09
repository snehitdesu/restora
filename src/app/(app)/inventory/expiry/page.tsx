import { gated } from "@/lib/auth/gate";
import { ExpiryScreen } from "@/features/backoffice/expiry";

export const dynamic = "force-dynamic";
export const metadata = { title: "Expiry — RESTORA" };

export default function Page() {
  return gated("/inventory/expiry", () => <ExpiryScreen />);
}
