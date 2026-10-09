"use client";

import { useState } from "react";
import Link from "next/link";
import { api, describeError } from "@/lib/api/client";
import { Button } from "@/components/ui/Button";
import { FormAlert, inputClass, readFields, focusFirstEmpty, useHydrated } from "@/components/auth/PasswordFields";

export function ForgotPasswordForm() {
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const hydrated = useHydrated();

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    const entered = readFields(e.currentTarget, "email");
    const email = entered.email.trim();
    // An empty field is explained, not silently refused: the button is enabled as soon as the page is interactive.
    if (!email) {
      setError("Enter the email address of your account");
      focusFirstEmpty(entered);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ message: string }>("/api/auth/password/reset", { method: "POST", body: { email } });
      setMessage(res.message);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      {message ? (
        <FormAlert tone="success">{message}</FormAlert>
      ) : (
        <form method="post" onSubmit={submit} className="space-y-4" noValidate>
          <div>
            <label htmlFor="email" className="block text-sm font-medium text-ink-700">Email</label>
            <input id="email" name="email" type="email" autoComplete="username" required className={inputClass} />
          </div>
          {error && <FormAlert>{error}</FormAlert>}
          <Button type="submit" variant="primary" size="lg" className="w-full" loading={busy} disabled={!hydrated}>
            Request reset link
          </Button>
        </form>
      )}
      <Link href="/login" className="block text-center text-sm font-medium text-brand-700 hover:underline">Back to sign in</Link>
    </div>
  );
}
