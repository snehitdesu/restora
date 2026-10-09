import { gated } from "@/lib/auth/gate";
import { RosterScreen } from "@/features/backoffice/staffOps";

export const dynamic = "force-dynamic";
export const metadata = { title: "Roster — RESTORA" };

export default function Page() {
  return gated("/staff/roster", () => <RosterScreen />);
}
