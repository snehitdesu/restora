import { gated } from "@/lib/auth/gate";
import { ProcurementQueueScreen } from "@/features/backoffice/procurementQueue";

export const dynamic = "force-dynamic";
export const metadata = { title: "Procurement queue — RESTORA" };

export default function Page() {
  return gated("/procurement/queue", () => <ProcurementQueueScreen />);
}
