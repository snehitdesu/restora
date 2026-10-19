"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { api, describeError } from "@/lib/api/client";
import { Button } from "@/components/ui/Button";
import { FormAlert } from "@/components/auth/PasswordFields";

type Status = {
  email: string;
  emailVerifiedAt: string | null;
  emailDelivery: { configured: boolean; problems: string[] };
  recovery: { eligible: boolean; remaining: number; total: number; generatedAt: string | null; activeOwners: number };
};
type Generated = { codes: string[]; generatedAt: string; notice: "sent" | "not_verified" | "not_configured" };

const fmt = (iso: string) => new Date(iso).toLocaleString();

function codesText(email: string, g: Generated): string {
  return [
    "RESTORA owner recovery codes",
    `Account: ${email}`,
    `Generated: ${g.generatedAt}`,
    "",
    "Each code works once, at /recover on this RESTORA address, to set a new password.",
    "Generating a new set makes every code below stop working.",
    "Keep this offline (printed, or on a drive you control). Do not email or message it.",
    "",
    ...g.codes.map((c, i) => `${String(i + 1).padStart(2, " ")}. ${c}`),
    "",
  ].join("\n");
}

export function SecurityPanel() {
  const [status, setStatus] = useState<Status | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [emailMsg, setEmailMsg] = useState<{ tone: "error" | "success" | "info"; text: string } | null>(null);
  const [codesError, setCodesError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"email" | "codes" | null>(null);
  const [generated, setGenerated] = useState<Generated | null>(null);
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    try {
      setStatus(await api<Status>("/api/auth/security"));
      setLoadError(null);
    } catch (err) {
      setLoadError(describeError(err));
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  // Leaving the page while unsaved codes are on screen loses them for good.
  useEffect(() => {
    if (!generated || saved) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [generated, saved]);

  async function sendVerification() {
    setBusy("email");
    setEmailMsg(null);
    try {
      const res = await api<{ status: "sent" | "already_verified"; email: string }>("/api/auth/email/verify-request", { method: "POST", body: {} });
      setEmailMsg(res.status === "sent"
        ? { tone: "success", text: `A confirmation link was sent to ${res.email}. It works once and expires in 24 hours.` }
        : { tone: "info", text: "This address is already confirmed." });
      if (res.status === "already_verified") void load();
    } catch (err) {
      setEmailMsg({ tone: "error", text: describeError(err) });
    } finally {
      setBusy(null);
    }
  }

  async function generate() {
    if (status?.recovery.total && !window.confirm("Generate a new set? Every recovery code you have now will stop working.")) return;
    setBusy("codes");
    setCodesError(null);
    try {
      const g = await api<Generated>("/api/auth/recovery-codes", { method: "POST", body: {} });
      setGenerated(g);
      setSaved(false);
      setCopied(false);
    } catch (err) {
      setCodesError(describeError(err));
    } finally {
      setBusy(null);
    }
  }

  function download() {
    if (!generated || !status) return;
    const url = URL.createObjectURL(new Blob([codesText(status.email, generated)], { type: "text/plain;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `restora-recovery-codes-${generated.generatedAt.slice(0, 10)}.txt`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  async function copy() {
    if (!generated || !status) return;
    try {
      await navigator.clipboard.writeText(codesText(status.email, generated));
      setCopied(true);
    } catch {
      setCodesError("Copying is blocked in this browser. Download or print the codes instead.");
    }
  }

  function finish() {
    setGenerated(null);
    setSaved(false);
    // Show "Loading…" until the new set is counted, not the stale "You have no recovery codes".
    setStatus(null);
    void load();
  }

  if (loadError) return <FormAlert>{loadError}</FormAlert>;
  if (!status) return <p className="text-sm text-ink-500">Loading…</p>;
  const { recovery, emailDelivery } = status;

  if (generated) {
    return (
      <div className="space-y-4">
        {/* Only the code sheet is printed. */}
        <style>{`@media print { body * { visibility: hidden !important; } #recovery-sheet, #recovery-sheet * { visibility: visible !important; } #recovery-sheet { position: absolute; inset: 0 auto auto 0; width: 100%; padding: 24px; } }`}</style>
        <FormAlert tone="info">Save these codes now. They are shown only once and cannot be displayed again.</FormAlert>
        <div id="recovery-sheet" className="rounded-lg border border-ink-200 bg-ink-50 p-4">
          <p className="text-sm font-semibold text-ink-900">RESTORA owner recovery codes</p>
          <p className="mt-0.5 text-xs text-ink-500">{status.email} · generated {fmt(generated.generatedAt)}</p>
          <ol className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5 font-mono text-[13px] text-ink-900" aria-label="Recovery codes">
            {generated.codes.map((c) => <li key={c} className="whitespace-nowrap">{c}</li>)}
          </ol>
          <p className="mt-3 text-xs text-ink-500">Each code works once at /recover. Keep this offline; never email or message it.</p>
        </div>
        <div className="grid grid-cols-3 gap-2">
          <Button type="button" variant="secondary" onClick={download}>Download</Button>
          <Button type="button" variant="secondary" onClick={() => window.print()}>Print</Button>
          <Button type="button" variant="secondary" onClick={copy}>{copied ? "Copied" : "Copy"}</Button>
        </div>
        {codesError && <FormAlert>{codesError}</FormAlert>}
        {generated.notice !== "sent" && (
          <p className="text-xs text-ink-500">{generated.notice === "not_verified" ? "No notice email was sent because your address is not confirmed." : "No notice email was sent because email delivery is not configured."}</p>
        )}
        <label className="flex items-start gap-2 text-sm text-ink-700">
          <input type="checkbox" className="mt-0.5 h-4 w-4" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
          I have saved these codes somewhere safe
        </label>
        <Button type="button" variant="primary" size="lg" className="w-full" disabled={!saved} onClick={finish}>Done</Button>
      </div>
    );
  }

  return (
    <div className="space-y-7">
      <section aria-labelledby="sec-email" className="space-y-2.5">
        <h2 id="sec-email" className="text-sm font-semibold text-ink-900">Email address</h2>
        {status.emailVerifiedAt ? (
          <p className="text-sm text-ink-600">Confirmed {fmt(status.emailVerifiedAt)}. Reset links and security notices go to {status.email}.</p>
        ) : (
          <>
            <p className="text-sm text-ink-600">Not confirmed. Until it is, no reset link or security notice is emailed to {status.email}.</p>
            {emailDelivery.configured ? (
              <Button type="button" variant="secondary" loading={busy === "email"} onClick={sendVerification}>Send confirmation email</Button>
            ) : (
              <FormAlert tone="error">
                Email delivery is not configured on this server, so a confirmation email cannot be sent. An administrator must set RESEND_API_KEY, RESEND_FROM and PUBLIC_BASE_URL. {emailDelivery.problems.join(". ")}
              </FormAlert>
            )}
          </>
        )}
        {emailMsg && <FormAlert tone={emailMsg.tone}>{emailMsg.text}</FormAlert>}
      </section>

      <section aria-labelledby="sec-codes" className="space-y-2.5">
        <h2 id="sec-codes" className="text-sm font-semibold text-ink-900">Recovery codes</h2>
        {recovery.eligible ? (
          <>
            <p className="text-sm text-ink-600">
              {recovery.total === 0
                ? "You have no recovery codes. They let you set a new password without email, including on an offline desktop."
                : `${recovery.remaining} of ${recovery.total} codes unused · generated ${fmt(recovery.generatedAt!)}.`}
            </p>
            {recovery.total > 0 && recovery.remaining <= 2 && <FormAlert tone="error">You are running out of recovery codes. Generate a new set.</FormAlert>}
            <Button type="button" variant={recovery.total === 0 ? "primary" : "secondary"} loading={busy === "codes"} onClick={generate}>
              {recovery.total === 0 ? "Generate recovery codes" : "Generate a new set"}
            </Button>
            <p className="text-xs text-ink-500">You will be asked for your password first.</p>
            {codesError && <FormAlert>{codesError}</FormAlert>}
          </>
        ) : (
          <p className="text-sm text-ink-600">Recovery codes are for organization owners. If you lose your password, an owner or manager can issue you a one-time password link from Staff.</p>
        )}
      </section>

      {recovery.eligible && (
        <section aria-labelledby="sec-owners" className="space-y-2.5">
          <h2 id="sec-owners" className="text-sm font-semibold text-ink-900">Business continuity</h2>
          {recovery.activeOwners < 2 ? (
            <FormAlert tone="info">
              You are the only active owner. Add a second trusted owner so the business is never locked out if one owner loses access.{" "}
              <Link href="/staff" className="font-medium underline">Open Staff</Link>
            </FormAlert>
          ) : (
            <p className="text-sm text-ink-600">{recovery.activeOwners} active owners. Another owner can issue you a password link if you are locked out.</p>
          )}
        </section>
      )}
    </div>
  );
}
