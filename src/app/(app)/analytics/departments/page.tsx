import { gated } from "@/lib/auth/gate";
import { DepartmentCostingScreen } from "@/features/backoffice/costing";

export const dynamic = "force-dynamic";
export const metadata = { title: "Department costing — RESTORA" };

export default function Page() {
  return gated("/analytics/departments", () => <DepartmentCostingScreen />);
}
