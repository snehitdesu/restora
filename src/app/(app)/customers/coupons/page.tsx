import { gated } from "@/lib/auth/gate";
import { CouponsScreen } from "@/features/backoffice/growthCoupons";

export const dynamic = "force-dynamic";
export const metadata = { title: "Coupons — RESTORA" };

export default function Page() {
  return gated("/customers/coupons", () => <CouponsScreen />);
}
