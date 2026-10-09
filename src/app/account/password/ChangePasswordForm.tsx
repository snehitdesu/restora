"use client";

import { useState } from "react";
import { api } from "@/lib/api/client";
import { Button } from "@/components/ui/Button";
import { PasswordInput, FormAlert, PASSWORD_HINT, passwordErrorMessage, readFields, focusFirstEmpty } from "@/components/auth/PasswordFields";

export function ChangePasswordForm({ email }: { email: string }) {
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    const form = e.currentTarget;
    const entered = readFields(form, "current-password", "new-password", "confirm-password");
    if (Object.values(entered).some((v) => !v)) {
      setError("Fill in your current password, the new password and the new password again");
      setDone(null);
      focusFirstEmpty(entered);
      return;
    }
    if (entered["new-password"] !== entered["confirm-password"]) return setError("The new passwords do not match");
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ sessionsRevoked: number }>("/api/auth/password/change", { method: "POST", body: { currentPassword: entered["current-password"], newPassword: entered["new-password"] } });
      setDone(`Password changed.${res.sessionsRevoked ? ` Signed out ${res.sessionsRevoked} other session${res.sessionsRevoked === 1 ? "" : "s"}.` : ""}`);
      form.reset();
    } catch (err) {
      setError(passwordErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form method="post" onSubmit={submit} className="space-y-4" noValidate>
      <input type="hidden" name="username" autoComplete="username" value={email} readOnly />
      <PasswordInput id="current-password" label="Current password" autoComplete="current-password" />
      <PasswordInput id="new-password" label="New password" autoComplete="new-password" hint={PASSWORD_HINT} />
      <PasswordInput id="confirm-password" label="Repeat new password" autoComplete="new-password" />
      {error && <FormAlert>{error}</FormAlert>}
      {done && <FormAlert tone="success">{done}</FormAlert>}
      <Button type="submit" variant="primary" size="lg" className="w-full" loading={busy}>
        Change password
      </Button>
    </form>
  );
}
