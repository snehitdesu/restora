"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api/client";
import { Button } from "@/components/ui/Button";
import { PasswordInput, FormAlert, PASSWORD_HINT, passwordErrorMessage, readFields, focusFirstEmpty } from "@/components/auth/PasswordFields";

export function SetPasswordForm() {
  const [token, setToken] = useState<string | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [doneEmail, setDoneEmail] = useState<string | null>(null);

  useEffect(() => {
    const t = new URLSearchParams(window.location.hash.slice(1)).get("token");
    setToken(t || null);
    // Drop the token from the address bar / history once it is held in memory.
    if (t) window.history.replaceState(null, "", window.location.pathname);
  }, []);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy || !token) return;
    const entered = readFields(e.currentTarget, "new-password", "confirm-password");
    if (Object.values(entered).some((v) => !v)) {
      setError("Choose a password and repeat it");
      focusFirstEmpty(entered);
      return;
    }
    if (entered["new-password"] !== entered["confirm-password"]) return setError("The passwords do not match");
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ email: string }>("/api/auth/password/complete", { method: "POST", body: { token, password: entered["new-password"] } });
      setDoneEmail(res.email);
    } catch (err) {
      setError(passwordErrorMessage(err));
      setBusy(false);
    }
  }

  if (token === undefined) return null;
  if (doneEmail) {
    return (
      <div className="space-y-4">
        <FormAlert tone="success">Password set for {doneEmail}. You can now sign in.</FormAlert>
        <Link href="/login" className="block text-center text-sm font-medium text-brand-700 hover:underline">Go to sign in</Link>
      </div>
    );
  }
  if (!token) {
    return (
      <div className="space-y-4">
        <FormAlert>This link is incomplete. Open the full link you were given, or ask your manager for a new one.</FormAlert>
        <Link href="/login" className="block text-center text-sm font-medium text-brand-700 hover:underline">Back to sign in</Link>
      </div>
    );
  }
  return (
    <form method="post" onSubmit={submit} className="space-y-4" noValidate>
      <PasswordInput id="new-password" label="New password" autoComplete="new-password" hint={PASSWORD_HINT} />
      <PasswordInput id="confirm-password" label="Repeat new password" autoComplete="new-password" />
      {error && <FormAlert>{error}</FormAlert>}
      <Button type="submit" variant="primary" size="lg" className="w-full" loading={busy}>
        Set password
      </Button>
    </form>
  );
}
