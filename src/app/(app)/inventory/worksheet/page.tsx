import { gated } from "@/lib/auth/gate";
import { WorksheetScreen } from "@/features/backoffice/kitchen";

export const dynamic = "force-dynamic";
export const metadata = { title: "Dish production — RESTORA" };

export default function Page() {
  return gated("/inventory/worksheet", () => <WorksheetScreen />);
}
