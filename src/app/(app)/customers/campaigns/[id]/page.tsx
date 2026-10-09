import { gated } from "@/lib/auth/gate";
import { CampaignDetailScreen } from "@/features/backoffice/growthCampaigns";

export const dynamic = "force-dynamic";
export const metadata = { title: "Campaign — RESTORA" };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return gated(`/customers/campaigns/${id}`, () => <CampaignDetailScreen id={id} />);
}
