import Link from "next/link";
import { requireShell } from "@/lib/auth/shell";
import { AuthShell } from "@/components/layout/AuthShell";
import { ReauthProvider } from "@/components/auth/ReauthProvider";
import { SecurityPanel } from "./SecurityPanel";

export const dynamic = "force-dynamic";
export const metadata = { title: "Account security — RESTORA" };

export default async function AccountSecurityPage() {
  const { shell } = await requireShell("/account/security");
  return (
    <AuthShell
      title="Account security"
      subtitle={shell.user.email}
      footer={
        <div className="mt-4 flex justify-center gap-5 text-sm font-medium">
          <Link href="/account/password" className="text-brand-700 hover:text-brand-800 hover:underline">Change password</Link>
          <Link href="/dashboard" className="text-brand-700 hover:text-brand-800 hover:underline">Back to dashboard</Link>
        </div>
      }
    >
      <ReauthProvider>
        <SecurityPanel />
      </ReauthProvider>
    </AuthShell>
  );
}
