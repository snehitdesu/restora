import { gated } from "@/lib/auth/gate";
import { TableQrScannerScreen } from "@/features/backoffice/tableQrScanner";

export const dynamic = "force-dynamic";
export const metadata = { title: "Scan table QR — RESTORA" };

// Gated by the Floors & tables nav rule (same audience as server/qr/scan.ts QR_SCAN_PERMISSIONS).
export default function Page() {
  return gated("/tables/scan", () => <TableQrScannerScreen />);
}
