import { gated } from "@/lib/auth/gate";
import { SupplierPricesScreen } from "@/features/backoffice/costing";

export const dynamic = "force-dynamic";
export const metadata = { title: "Supplier prices — RESTORA" };

export default function Page() {
  return gated("/procurement/prices", () => <SupplierPricesScreen />);
}
