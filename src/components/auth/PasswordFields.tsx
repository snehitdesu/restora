"use client";

import { ApiError, describeError } from "@/lib/api/client";
import { PASSWORD_MIN_LENGTH } from "@/constants/password";

export const inputClass =
  "mt-1 h-10 w-full rounded-md border border-ink-300 px-3 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-500";

export const PASSWORD_HINT = `At least ${PASSWORD_MIN_LENGTH} characters, with a letter and a number or symbol. Avoid your name or email.`;

/**
 * Uncontrolled on purpose: the form reads the fields when it is submitted, so text typed before the page finished
 * hydrating (a slow phone) is not lost and never leaves the button disabled (same approach as the sign-in form).
 */
export function PasswordInput({ id, label, autoComplete, hint }: { id: string; label: string; autoComplete: string; hint?: string }) {
  return (
    <div>
      <label htmlFor={id} className="block text-sm font-medium text-ink-700">{label}</label>
      <input id={id} name={id} type="password" autoComplete={autoComplete} required aria-describedby={hint ? `${id}-hint` : undefined} className={inputClass} />
      {hint && <p id={`${id}-hint`} className="mt-1 text-xs text-ink-500">{hint}</p>}
    </div>
  );
}

/** What is in the form's fields right now, by field name. */
export function readFields(form: HTMLFormElement, ...names: string[]): Record<string, string> {
  const entered = new FormData(form);
  return Object.fromEntries(names.map((n) => [n, String(entered.get(n) ?? "")]));
}

/** Focus the first named field that is empty. */
export function focusFirstEmpty(values: Record<string, string>) {
  const first = Object.keys(values).find((k) => !values[k].trim());
  if (first) document.getElementById(first)?.focus();
}

export function FormAlert({ tone = "error", children }: { tone?: "error" | "success"; children: React.ReactNode }) {
  const cls = tone === "error" ? "border-bad-100 bg-bad-50 text-bad-700" : "border-ok-100 bg-ok-50 text-ok-700";
  return (
    <p role={tone === "error" ? "alert" : "status"} className={`rounded-md border px-3 py-2 text-sm ${cls}`}>
      {children}
    </p>
  );
}

/** Policy problems come back as details.fieldErrors; show all of them, not just the first. */
export function passwordErrorMessage(err: unknown): string {
  if (err instanceof ApiError && err.kind === "validation") {
    const fe = (err.details as { fieldErrors?: Record<string, string[] | undefined> } | undefined)?.fieldErrors;
    const all = Object.values(fe ?? {}).flatMap((v) => v ?? []);
    if (all.length) return [...new Set(all)].join(". ");
  }
  return describeError(err);
}
