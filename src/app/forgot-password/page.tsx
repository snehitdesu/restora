import Link from "next/link";
import { AuthShell } from "@/components/layout/AuthShell";
import { FormAlert } from "@/components/auth/PasswordFields";
import { resetRequestOutcome } from "@/server/auth/account";
import { ForgotPasswordForm } from "./ForgotPasswordForm";

// Whether reset email is set up is read from the server's environment on each request.
export const dynamic = "force-dynamic";
export const metadata = { title: "Reset password — RESTORA" };

export default function ForgotPasswordPage() {
  const outcome = resetRequestOutcome();
  if (outcome.delivery === "manager") {
    return (
      <AuthShell title="Reset your password" subtitle="Your manager can help you back in">
        <div className="space-y-4">
          <FormAlert tone="info">{outcome.message}</FormAlert>
          <p className="text-sm text-ink-600">The link they issue works once and lets you choose a new password. Your current password keeps working until then.</p>
          <Link href="/login" className="block text-center text-sm font-medium text-brand-700 hover:underline">Back to sign in</Link>
        </div>
      </AuthShell>
    );
  }
  return (
    <AuthShell title="Reset your password" subtitle="Enter the email you sign in with">
      <ForgotPasswordForm />
    </AuthShell>
  );
}
