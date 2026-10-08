import { gated } from "@/lib/auth/gate";
import { VarianceScreen } from "@/features/backoffice/kitchen";

export const dynamic = "force-dynamic";
export const metadata = { title: "Consumption variance — RESTORA" };

export default function Page() {
  return gated("/inventory/variance", () => <VarianceScreen />);
}
