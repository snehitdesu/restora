import { gated } from "@/lib/auth/gate";
import { ChecklistsScreen } from "@/features/backoffice/staffOps";

export const dynamic = "force-dynamic";
export const metadata = { title: "Checklists — RESTORA" };

export default function Page() {
  return gated("/staff/checklists", () => <ChecklistsScreen />);
}
