import { gated } from "@/lib/auth/gate";
import { StockLabelsScreen } from "@/features/backoffice/costing";

export const dynamic = "force-dynamic";
export const metadata = { title: "Stock labels — RESTORA" };

export default function Page() {
  return gated("/inventory/labels", () => <StockLabelsScreen />);
}
