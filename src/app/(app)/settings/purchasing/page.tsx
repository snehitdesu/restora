import { gated } from "@/lib/auth/gate";
import { PurchasingRulesScreen } from "@/features/backoffice/procurementRules";

export const dynamic = "force-dynamic";
export const metadata = { title: "Purchasing rules — RESTORA" };

export default function Page() {
  return gated("/settings/purchasing", () => <PurchasingRulesScreen />);
}
