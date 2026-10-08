import { gated } from "@/lib/auth/gate";
import { StockMatrixScreen } from "@/features/backoffice/costing";

export const dynamic = "force-dynamic";
export const metadata = { title: "Stock matrix — RESTORA" };

export default function Page() {
  return gated("/inventory/matrix", () => <StockMatrixScreen />);
}
