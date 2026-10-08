import { gated } from "@/lib/auth/gate";
import { MoneyDeskScreen } from "@/features/backoffice/moneyDesk";

export const dynamic = "force-dynamic";
export const metadata = { title: "Money desk — RESTORA" };

export default function Page() {
  return gated("/finance/money-desk", () => <MoneyDeskScreen />);
}
