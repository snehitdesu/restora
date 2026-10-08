import { gated } from "@/lib/auth/gate";
import { AggregatorsScreen } from "@/features/backoffice/aggregators";

export const dynamic = "force-dynamic";
export const metadata = { title: "Aggregators — RESTORA" };

export default function Page() {
  return gated("/finance/aggregators", () => <AggregatorsScreen />);
}
