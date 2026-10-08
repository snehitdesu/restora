import { gated } from "@/lib/auth/gate";
import { ReorderScreen } from "@/features/backoffice/reorder";

export const dynamic = "force-dynamic";
export const metadata = { title: "Reorder — RESTORA" };

export default function Page() {
  return gated("/procurement/reorder", () => <ReorderScreen />);
}
