import { gated } from "@/lib/auth/gate";
import { PrepTimesScreen } from "@/features/backoffice/prepTimes";

export const dynamic = "force-dynamic";
export const metadata = { title: "Dish prep times — RESTORA" };

export default function Page() {
  return gated("/analytics/prep-times", () => <PrepTimesScreen />);
}
