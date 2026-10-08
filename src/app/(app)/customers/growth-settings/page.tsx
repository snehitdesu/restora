import { gated } from "@/lib/auth/gate";
import { GrowthSettingsScreen } from "@/features/backoffice/growthSettings";

export const dynamic = "force-dynamic";
export const metadata = { title: "Growth settings — RESTORA" };

export default function Page() {
  return gated("/customers/growth-settings", () => <GrowthSettingsScreen />);
}
