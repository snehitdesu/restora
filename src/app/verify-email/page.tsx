import { AuthShell } from "@/components/layout/AuthShell";
import { VerifyEmailForm } from "./VerifyEmailForm";

export const metadata = { title: "Confirm your email — RESTORA" };

/**
 * Landing page for emailed verification links: /verify-email#token=…
 * The token is in the URL fragment (never sent to the server, logs or Referer);
 * the page posts it to /api/auth/email/verify after a click, so a mail
 * scanner that prefetches the link does not consume it.
 */
export default function VerifyEmailPage() {
  return (
    <AuthShell title="Confirm your email" subtitle="Reset links and security notices only go to a confirmed address">
      <VerifyEmailForm />
    </AuthShell>
  );
}
