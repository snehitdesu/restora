"use client";

/**
 * A guest's growth profile (customer page, "Offers & referrals"): what they agreed to hear about on each channel,
 * their loyalty tier, and their referral code. Consent changes are recorded with who made them.
 */
import { useState } from "react";
import { api } from "@/lib/api/client";
import { useAction, useQuery } from "@/lib/hooks/useApi";
import { useShell } from "@/lib/shellContext";
import { formatDateTime, formatMoney, humanize } from "@/lib/format";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Checkbox, Field, Input } from "@/components/ui/Form";
import { Card } from "@/components/ui/Page";
import { ErrorState } from "@/components/ui/States";
import { ScrollRegion } from "@/components/ui/ScrollRegion";

type Consent = { channel: "SMS" | "WHATSAPP" | "EMAIL"; marketing: boolean; transactional: boolean; source: string | null; updatedAt: string | null };
type Loyalty = { tier: { code: string; name: string; perks: string | null; earnMultiplierPct: number } | null; spend: number; next: { code: string; name: string; remaining: number } | null; configured: boolean };
type Referrals = { code: string | null; brought: Array<{ id: string; referredCustomerId: string; status: string; rewardedAt: string | null }>; cameWith: { status: string; referrerCustomerId: string } | null };

const LABEL = { SMS: "SMS", WHATSAPP: "WhatsApp", EMAIL: "E-mail" } as const;
const SOURCE: Record<string, string> = { STAFF: "by staff", GUEST_QR: "by the guest when ordering", IMPORT: "from an import", GUEST_REPLY: "by the guest (unsubscribe link or reply)" };
const REF_TONE: Record<string, "info" | "ok" | "bad"> = { PENDING: "info", REWARDED: "ok", REJECTED: "bad" };

function ConsentCard({ customerId, phone, email }: { customerId: string; phone: boolean; email: boolean }) {
  const { can } = useShell();
  const consent = useQuery<Consent[]>(`/api/growth/customers/${customerId}/consent`);
  const act = useAction();
  const manage = can("customer.manage");
  const change = (channel: Consent["channel"], patch: { marketing?: boolean; transactional?: boolean }) =>
    act.run(async () => {
      await api(`/api/growth/customers/${customerId}/consent`, { method: "POST", body: { channels: [{ channel, ...patch }] } });
      consent.reload();
    }, { success: "Preference saved" });
  return (
    <Card title="Offers and messages" bodyClassName="p-0">
      {consent.error ? <ErrorState error={consent.error} onRetry={consent.reload} compact /> : (
        <ScrollRegion label="Message preferences (scrolls sideways)">
          <table className="w-full text-sm" aria-label="Message preferences">
            <thead><tr className="border-b border-ink-200 text-left text-[11px] font-semibold uppercase tracking-eyebrow text-ink-600"><th scope="col" className="px-4 py-2.5">Channel</th><th scope="col" className="px-4 py-2.5">Offers and promotions</th><th scope="col" className="px-4 py-2.5">Order and booking messages</th><th scope="col" className="px-4 py-2.5">Last changed</th></tr></thead>
            <tbody>
              {(consent.data ?? []).map((c) => {
                const reachable = c.channel === "EMAIL" ? email : phone;
                return (
                  <tr key={c.channel} className="border-b border-ink-100 last:border-0">
                    <th scope="row" className="px-4 py-3 text-left font-medium text-ink-900">{LABEL[c.channel]}{!reachable && <span className="ml-2 text-xs font-normal text-warn-700">no {c.channel === "EMAIL" ? "e-mail address" : "mobile number"}</span>}</th>
                    <td className="px-4 py-3"><Checkbox label={c.marketing ? "Agreed" : "Not agreed"} checked={c.marketing} onChange={(v) => void change(c.channel, { marketing: v })} disabled={!manage || act.busy} name={`m-${c.channel}`} /></td>
                    <td className="px-4 py-3"><Checkbox label={c.transactional ? "Allowed" : "Opted out"} checked={c.transactional} onChange={(v) => void change(c.channel, { transactional: v })} disabled={!manage || act.busy} name={`t-${c.channel}`} /></td>
                    <td className="px-4 py-3 text-xs text-ink-500">{c.updatedAt ? `${formatDateTime(c.updatedAt)} ${c.source ? SOURCE[c.source] ?? "" : ""}` : "Never set"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="border-t border-ink-100 px-4 py-2.5 text-xs text-ink-500">Offers are only sent to guests who agreed, on the channel they agreed to, and carry an unsubscribe link. Never tick “Agreed” on a guest&apos;s behalf unless they told you so.</p>
        </ScrollRegion>
      )}
    </Card>
  );
}

function TierCard({ customerId }: { customerId: string }) {
  const loyalty = useQuery<Loyalty>(`/api/growth/customers/${customerId}/loyalty`);
  const l = loyalty.data;
  return (
    <Card title="Loyalty tier">
      {loyalty.error ? <ErrorState error={loyalty.error} onRetry={loyalty.reload} compact /> : !l ? <p className="text-sm text-ink-500">Loading…</p> : !l.configured ? (
        <p className="text-sm text-ink-500">No tiers are set up, so this guest earns points at the standard rate.</p>
      ) : (
        <div className="space-y-1 text-sm">
          <p><Badge tone="brand">{l.tier?.name ?? "No tier"}</Badge> <span className="text-ink-500">earns {l.tier?.earnMultiplierPct ?? 100}% points</span></p>
          {l.tier?.perks && <p className="text-ink-700">{l.tier.perks}</p>}
          <p className="text-ink-500">{formatMoney(l.spend)} spent in the last 365 days.{l.next ? ` ${formatMoney(l.next.remaining)} more to reach ${l.next.name}.` : " Top tier reached."}</p>
        </div>
      )}
    </Card>
  );
}

function ReferralCard({ customerId }: { customerId: string }) {
  const { can } = useShell();
  const refs = useQuery<Referrals>(`/api/growth/customers/${customerId}/referrals`);
  const act = useAction();
  const [code, setCode] = useState("");
  const [copied, setCopied] = useState(false);
  const manage = can("customer.manage");
  const r = refs.data;
  const link = r?.code && typeof window !== "undefined" ? `${window.location.origin}/r/${r.code}` : null;
  return (
    <Card title="Referrals">
      {refs.error ? <ErrorState error={refs.error} onRetry={refs.reload} compact /> : !r ? <p className="text-sm text-ink-500">Loading…</p> : (
        <div className="space-y-4 text-sm">
          <div>
            <p className="eyebrow mb-1">Their code</p>
            {r.code ? (
              <div className="flex flex-wrap items-center gap-2">
                <span className="rounded-md bg-paper-warm px-2.5 py-1 font-mono text-base font-semibold tracking-wider text-ink-900">{r.code}</span>
                {link && <Button size="sm" onClick={() => { void navigator.clipboard?.writeText(link).then(() => setCopied(true)).catch(() => undefined); }}>{copied ? "Link copied" : "Copy invite link"}</Button>}
              </div>
            ) : manage ? (
              <Button size="sm" loading={act.busy} onClick={() => void act.run(async () => { await api(`/api/growth/customers/${customerId}/referral-code`, { method: "POST", body: {} }); refs.reload(); }, { success: "Code created" })}>Create a referral code</Button>
            ) : <p className="text-ink-500">No code yet.</p>}
          </div>
          <div>
            <p className="eyebrow mb-1">Friends they brought ({r.brought.length})</p>
            {r.brought.length ? <ul className="space-y-1">{r.brought.map((b) => <li key={b.id} className="flex items-center gap-2"><Badge tone={REF_TONE[b.status] ?? "neutral"}>{humanize(b.status)}</Badge><span className="text-ink-500">{b.rewardedAt ? `rewarded ${formatDateTime(b.rewardedAt)}` : "waiting for the friend's first paid order"}</span></li>)}</ul> : <p className="text-ink-500">None yet.</p>}
          </div>
          <div>
            <p className="eyebrow mb-1">Came with a code?</p>
            {r.cameWith ? <p className="text-ink-700">Yes — <Badge tone={REF_TONE[r.cameWith.status] ?? "neutral"}>{humanize(r.cameWith.status)}</Badge></p> : manage ? (
              <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); void act.run(async () => { await api(`/api/growth/customers/${customerId}/referral`, { method: "POST", body: { code: code.trim().toUpperCase() } }); setCode(""); refs.reload(); }, { success: "Referral recorded" }); }}>
                <Field label="Friend's code" name="referralCode" hint="Only before this guest's first paid order"><Input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} maxLength={20} className="font-mono" required minLength={4} /></Field>
                <Button type="submit" size="md" loading={act.busy} disabled={code.trim().length < 4}>Record</Button>
              </form>
            ) : <p className="text-ink-500">No.</p>}
          </div>
        </div>
      )}
    </Card>
  );
}

export function CustomerGrowth({ customerId, hasPhone, hasEmail }: { customerId: string; hasPhone: boolean; hasEmail: boolean }) {
  return (
    <div className="space-y-4">
      <ConsentCard customerId={customerId} phone={hasPhone} email={hasEmail} />
      <div className="grid gap-4 lg:grid-cols-2">
        <TierCard customerId={customerId} />
        <ReferralCard customerId={customerId} />
      </div>
    </div>
  );
}
