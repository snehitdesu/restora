import { gated } from "@/lib/auth/gate";
import { CloudSyncScreen } from "@/features/backoffice/cloudSync";

export const dynamic = "force-dynamic";
export const metadata = { title: "Cloud sync — RESTORA" };

export default function Page() {
  return gated("/settings/cloud-sync", () => <CloudSyncScreen />);
}
