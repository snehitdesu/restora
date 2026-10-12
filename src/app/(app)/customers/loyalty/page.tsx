import { gated } from "@/lib/auth/gate";
import { LoyaltyScreen } from "@/features/backoffice/growthLoyalty";

export const dynamic = "force-dynamic";
export const metadata = { title: "Loyalty & referrals — RESTORA" };

export default function Page() {
  return gated("/customers/loyalty", () => <LoyaltyScreen />);
}
