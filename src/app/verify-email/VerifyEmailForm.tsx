"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { api, describeError } from "@/lib/api/client";
import { Button } from "@/components/ui/Button";
import { FormAlert } from "@/components/auth/PasswordFields";

export function VerifyEmailForm() {
  const [token, setToken] = useState<string | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [doneEmail, setDoneEmail] = useState<string | null>(null);

  useEffect(() => {
    const t = new URLSearchParams(window.location.hash.slice(1)).get("token");
    setToken(t || null);
    if (t) window.history.replaceState(null, "", window.location.pathname);
  }, []);

  async function confirm() {
    if (busy || !token) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ email: string }>("/api/auth/email/verify", { method: "POST", body: { token } });
      setDoneEmail(res.email);
    } catch (err) {
      setError(describeError(err));
      setBusy(false);
    }
  }

  if (token === undefined) return null;
  if (doneEmail) {
    return (
      <div className="space-y-4">
        <FormAlert tone="success">{doneEmail} is confirmed. Password reset links and security notices will be sent there.</FormAlert>
        <Link href="/account/security" className="block text-center text-sm font-medium text-brand-700 hover:underline">Go to account security</Link>
      </div>
    );
  }
  if (!token) {
    return (
      <div className="space-y-4">
        <FormAlert>This link is incomplete. Open the full link from the email, or send a new one from Account security.</FormAlert>
        <Link href="/login" className="block text-center text-sm font-medium text-brand-700 hover:underline">Back to sign in</Link>
      </div>
    );
  }
  return (
    <div className="space-y-4">
      {error && <FormAlert>{error}</FormAlert>}
      <Button type="button" variant="primary" size="lg" className="w-full" loading={busy} onClick={confirm}>
        Confirm my email address
      </Button>
    </div>
  );
}
