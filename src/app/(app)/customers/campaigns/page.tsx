import { gated } from "@/lib/auth/gate";
import { CampaignsScreen } from "@/features/backoffice/growthCampaigns";

export const dynamic = "force-dynamic";
export const metadata = { title: "Campaigns — RESTORA" };

export default function Page() {
  return gated("/customers/campaigns", () => <CampaignsScreen />);
}
