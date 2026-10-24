"use client";

import { useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api/client";
import { Button } from "@/components/ui/Button";
import { PasswordInput, FormAlert, PASSWORD_HINT, passwordErrorMessage, readFields, focusFirstEmpty, inputClass, useHydrated } from "@/components/auth/PasswordFields";

type Result = { email: string; remaining: number; sessionsRevoked: number; notice: "sent" | "not_verified" | "not_configured" };

export function RecoverForm() {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<Result | null>(null);
  const hydrated = useHydrated();

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    const entered = readFields(e.currentTarget, "email", "recovery-code", "new-password", "confirm-password");
    if (Object.values(entered).some((v) => !v.trim())) {
      setError("Fill in your email, one recovery code and the new password twice");
      focusFirstEmpty(entered);
      return;
    }
    if (entered["new-password"] !== entered["confirm-password"]) return setError("The new passwords do not match");
    setBusy(true);
    setError(null);
    try {
      setDone(await api<Result>("/api/auth/recovery", { method: "POST", body: { email: entered.email.trim(), code: entered["recovery-code"], newPassword: entered["new-password"] } }));
    } catch (err) {
      setError(passwordErrorMessage(err));
      setBusy(false);
    }
  }

  if (done) {
    return (
      <div className="space-y-4">
        <FormAlert tone="success">
          Password changed for {done.email}. That recovery code no longer works, and every session was signed out.
        </FormAlert>
        <p className="text-sm text-ink-600">
          {done.remaining === 0
            ? "You have no unused recovery codes left. Sign in and generate a new set from Account security now."
            : `${done.remaining} unused recovery code${done.remaining === 1 ? "" : "s"} left. Cross this one off your saved copy.`}
        </p>
        {done.notice !== "sent" && (
          <p className="text-sm text-ink-600">
            {done.notice === "not_verified" ? "No notification email was sent: this account's email address is not confirmed." : "No notification email was sent: email delivery is not configured on this server."}
          </p>
        )}
        <Link href="/login" className="block text-center text-sm font-medium text-brand-700 hover:underline">Go to sign in</Link>
      </div>
    );
  }

  return (
    <form method="post" onSubmit={submit} className="space-y-4" noValidate>
      <div>
        <label htmlFor="email" className="block text-sm font-medium text-ink-700">Owner email</label>
        <input id="email" name="email" type="email" autoComplete="username" required className={inputClass} />
      </div>
      <div>
        <label htmlFor="recovery-code" className="block text-sm font-medium text-ink-700">Recovery code</label>
        <input id="recovery-code" name="recovery-code" type="text" autoComplete="one-time-code" autoCapitalize="characters" spellCheck={false}
          placeholder="XXXX-XXXX-XXXX-XXXX" required className={`${inputClass} font-mono tracking-wider`} />
        <p className="mt-1 text-xs text-ink-500">Each code works once. Dashes and spaces are optional.</p>
      </div>
      <PasswordInput id="new-password" label="New password" autoComplete="new-password" hint={PASSWORD_HINT} />
      <PasswordInput id="confirm-password" label="Repeat new password" autoComplete="new-password" />
      {error && <FormAlert>{error}</FormAlert>}
      <Button type="submit" variant="primary" size="lg" className="w-full" loading={busy} disabled={!hydrated}>
        Recover account
      </Button>
      <p className="text-xs text-ink-500">Not an owner, or no codes? Ask an owner or manager to issue you a password link from Staff.</p>
    </form>
  );
}
