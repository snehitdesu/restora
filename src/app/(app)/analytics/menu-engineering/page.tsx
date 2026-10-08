import { gated } from "@/lib/auth/gate";
import { MenuEngineeringScreen } from "@/features/backoffice/costing";

export const dynamic = "force-dynamic";
export const metadata = { title: "Menu engineering — RESTORA" };

export default function Page() {
  return gated("/analytics/menu-engineering", () => <MenuEngineeringScreen />);
}
