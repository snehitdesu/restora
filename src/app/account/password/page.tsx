import Link from "next/link";
import { requireShell } from "@/lib/auth/shell";
import { AuthShell } from "@/components/layout/AuthShell";
import { ChangePasswordForm } from "./ChangePasswordForm";

export const dynamic = "force-dynamic";
export const metadata = { title: "Change password — RESTORA" };

export default async function ChangePasswordPage() {
  const { shell } = await requireShell("/account/password");
  return (
    <AuthShell
      title="Change password"
      subtitle={shell.user.email}
      footer={
        <div className="mt-4 flex justify-center gap-5 text-sm font-medium">
          <Link href="/account/security" className="text-brand-700 hover:text-brand-800 hover:underline">Security &amp; recovery</Link>
          <Link href="/dashboard" className="text-brand-700 hover:text-brand-800 hover:underline">Back to dashboard</Link>
        </div>
      }
    >
      <ChangePasswordForm email={shell.user.email} />
    </AuthShell>
  );
}
