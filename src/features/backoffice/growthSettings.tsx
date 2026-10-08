"use client";

/**
 * Growth settings: which automations run and the rules every guest message obeys. Everything defaults to off; a
 * switch here changes what the worker does from its next pass. Referral rewards are set on the Loyalty screen.
 */
import Link from "next/link";
import { useState } from "react";
import { api } from "@/lib/api/client";
import { useAction, useQuery } from "@/lib/hooks/useApi";
import { useShell } from "@/lib/shellContext";
import { Button } from "@/components/ui/Button";
import { Checkbox, Field, FormAlert, Input, Select, opt, useSubmit, FormErrors } from "@/components/ui/Form";
import { Card, PageHeader } from "@/components/ui/Page";
import { ErrorState, LoadingState } from "@/components/ui/States";
import { formatMoney } from "@/lib/format";
import type { CouponRow } from "@/features/backoffice/growthCoupons";

type Settings = {
  referralEnabled: boolean; birthdayCouponId: string | null; anniversaryCouponId: string | null; winbackCouponId: string | null; winbackAfterDays: number; winbackCooldownDays: number;
  feedbackEnabled: boolean; feedbackDelayMinutes: number; googleReviewUrl: string | null; lowRatingMax: number;
  quietHoursStart: number; quietHoursEnd: number; marketingWeeklyCap: number; bookingMessagesEnabled: boolean; bookingReminderHours: number;
  digestEnabled: boolean; digestHour: number; digestPhone: string | null;
};
type Digest = { date: string; restaurant: string; text: string; outlets: Array<{ outletId: string; name: string; orders: number; revenue: number }> };

const HOURS = Array.from({ length: 24 }, (_, h) => ({ value: h, label: `${String(h).padStart(2, "0")}:00` }));

function HourSelect({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return <Select value={value} onChange={(e) => onChange(Number(e.target.value))}>{HOURS.map((h) => <option key={h.value} value={h.value}>{h.label}</option>)}</Select>;
}

function SettingsForm({ initial, coupons, canManage, onSaved }: { initial: Settings; coupons: CouponRow[]; canManage: boolean; onSaved: (s: Settings) => void }) {
  const [s, setS] = useState(initial);
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setS((p) => ({ ...p, [k]: v }));
  const form = useSubmit();
  const quiet = s.quietHoursStart === s.quietHoursEnd ? "No quiet hours: offers can go out at any time." : `Offers are held between ${String(s.quietHoursStart).padStart(2, "0")}:00 and ${String(s.quietHoursEnd).padStart(2, "0")}:00 and sent in the morning.`;
  const couponSelect = (key: "birthdayCouponId" | "anniversaryCouponId" | "winbackCouponId", label: string, hint: string) => (
    <Field label={label} name={key} hint={hint}>
      <Select value={s[key] ?? ""} onChange={(e) => set(key, e.target.value || null)} disabled={!canManage}>
        <option value="">Off</option>
        {coupons.filter((c) => c.active || c.id === s[key]).map((c) => <option key={c.id} value={c.id}>{c.code} — {c.name}</option>)}
      </Select>
    </Field>
  );
  async function save(e: React.FormEvent) {
    e.preventDefault();
    const r = await form.submit(() => api<Settings>("/api/growth/settings", {
      method: "PATCH",
      body: {
        birthdayCouponId: s.birthdayCouponId, anniversaryCouponId: s.anniversaryCouponId, winbackCouponId: s.winbackCouponId, winbackAfterDays: s.winbackAfterDays, winbackCooldownDays: s.winbackCooldownDays,
        feedbackEnabled: s.feedbackEnabled, feedbackDelayMinutes: s.feedbackDelayMinutes, googleReviewUrl: opt(s.googleReviewUrl ?? "") ?? null, lowRatingMax: s.lowRatingMax,
        quietHoursStart: s.quietHoursStart, quietHoursEnd: s.quietHoursEnd, marketingWeeklyCap: s.marketingWeeklyCap,
        bookingMessagesEnabled: s.bookingMessagesEnabled, bookingReminderHours: s.bookingReminderHours,
        digestEnabled: s.digestEnabled, digestHour: s.digestHour, digestPhone: opt(s.digestPhone ?? "") ?? null,
      },
    }));
    if (r.ok) { onSaved(r.value); form.setMessage("Saved"); }
  }
  return (
    <form onSubmit={save} className="space-y-4" noValidate={false}>
      <FormErrors errors={form.errors}>
        {form.message && (form.message === "Saved" ? <p role="status" className="rounded-md border border-ok-100 bg-ok-50 px-3 py-2 text-sm text-ok-700">Saved. The worker uses these from its next pass.</p> : <FormAlert message={form.message} />)}
        <Card title="Rules for every offer">
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Quiet hours start" name="quietHoursStart"><HourSelect value={s.quietHoursStart} onChange={(v) => set("quietHoursStart", v)} /></Field>
            <Field label="Quiet hours end" name="quietHoursEnd"><HourSelect value={s.quietHoursEnd} onChange={(v) => set("quietHoursEnd", v)} /></Field>
            <Field label="Offers per guest per week" name="marketingWeeklyCap" hint="Campaigns and automations together"><Input type="number" inputMode="numeric" min={1} max={14} step={1} value={s.marketingWeeklyCap} onChange={(e) => set("marketingWeeklyCap", Number(e.target.value))} disabled={!canManage} /></Field>
          </div>
          <p className="mt-2 text-xs text-ink-500">{quiet} Order receipts and booking messages are not affected. Guests only receive offers on channels they agreed to, and every offer has an unsubscribe link.</p>
        </Card>
        <Card title="Automatic offers">
          <div className="grid gap-3 sm:grid-cols-3">
            {couponSelect("birthdayCouponId", "Birthday offer", "Sent on the day, once a year")}
            {couponSelect("anniversaryCouponId", "Anniversary offer", "Sent on the day, once a year")}
            {couponSelect("winbackCouponId", "Win-back offer", "For guests who stopped coming")}
          </div>
          <div className="mt-3 grid gap-3 sm:grid-cols-3">
            <Field label="Win-back after (days without a visit)" name="winbackAfterDays"><Input type="number" inputMode="numeric" min={7} max={730} step={1} value={s.winbackAfterDays} onChange={(e) => set("winbackAfterDays", Number(e.target.value))} disabled={!canManage || !s.winbackCouponId} /></Field>
            <Field label="Ask again no sooner than (days)" name="winbackCooldownDays"><Input type="number" inputMode="numeric" min={7} max={730} step={1} value={s.winbackCooldownDays} onChange={(e) => set("winbackCooldownDays", Number(e.target.value))} disabled={!canManage || !s.winbackCouponId} /></Field>
          </div>
          <p className="mt-2 text-xs text-ink-500">{coupons.length ? "Choose a coupon so the guest has a reason to come back." : <>Create a coupon first on the <Link className="text-brand-600 hover:underline" href="/customers/coupons">Coupons</Link> screen.</>}</p>
        </Card>
        <Card title="Feedback after the meal">
          <Checkbox label="Ask guests how it was" checked={s.feedbackEnabled} onChange={(v) => set("feedbackEnabled", v)} disabled={!canManage} />
          <div className="mt-3 grid gap-3 sm:grid-cols-3">
            <Field label="Ask after (minutes)" name="feedbackDelayMinutes" hint="From the payment"><Input type="number" inputMode="numeric" min={15} max={1440} step={5} value={s.feedbackDelayMinutes} onChange={(e) => set("feedbackDelayMinutes", Number(e.target.value))} disabled={!canManage || !s.feedbackEnabled} /></Field>
            <Field label="Treat as unhappy at or below" name="lowRatingMax" hint="Stars. Unhappy answers stay private and alert you."><Select value={s.lowRatingMax} onChange={(e) => set("lowRatingMax", Number(e.target.value))} disabled={!canManage}>{[1, 2, 3, 4].map((n) => <option key={n} value={n}>{n} {n === 1 ? "star" : "stars"}</option>)}</Select></Field>
            <Field label="Public review page" name="googleReviewUrl" hint="Only happy guests (4–5 stars) are sent here. Google, Zomato, Swiggy, TripAdvisor or Justdial."><Input type="url" inputMode="url" placeholder="https://g.page/r/…" value={s.googleReviewUrl ?? ""} onChange={(e) => set("googleReviewUrl", e.target.value)} disabled={!canManage} /></Field>
          </div>
        </Card>
        <Card title="Bookings">
          <Checkbox label="Confirm bookings and remind guests" checked={s.bookingMessagesEnabled} onChange={(v) => set("bookingMessagesEnabled", v)} disabled={!canManage} />
          <div className="mt-3 max-w-xs">
            <Field label="Remind (hours before)" name="bookingReminderHours"><Input type="number" inputMode="numeric" min={1} max={48} step={1} value={s.bookingReminderHours} onChange={(e) => set("bookingReminderHours", Number(e.target.value))} disabled={!canManage || !s.bookingMessagesEnabled} /></Field>
          </div>
        </Card>
        <Card title="Morning summary">
          <Checkbox label="Send yesterday's figures every morning" checked={s.digestEnabled} onChange={(v) => set("digestEnabled", v)} disabled={!canManage} />
          <div className="mt-3 grid gap-3 sm:grid-cols-3">
            <Field label="Send at" name="digestHour"><HourSelect value={s.digestHour} onChange={(v) => set("digestHour", v)} /></Field>
            <Field label="Owner's mobile number" name="digestPhone" hint="Optional. Without a number the summary appears as a notification in the app."><Input type="tel" inputMode="tel" value={s.digestPhone ?? ""} onChange={(e) => set("digestPhone", e.target.value)} maxLength={20} disabled={!canManage || !s.digestEnabled} /></Field>
          </div>
        </Card>
      </FormErrors>
      {canManage ? <div className="flex justify-end"><Button type="submit" variant="primary" loading={form.busy}>Save settings</Button></div> : <p className="text-sm text-ink-500">You can view these settings; changing them needs the Growth manager permission.</p>}
    </form>
  );
}

function DigestPreview() {
  const toast = useAction();
  const [digest, setDigest] = useState<Digest | null>(null);
  return (
    <Card title="Preview yesterday's summary" actions={<Button size="sm" loading={toast.busy} onClick={() => void toast.run(async () => setDigest(await api<Digest>("/api/growth/digest")))}>Show</Button>}>
      {digest ? (
        <>
          <p className="eyebrow mb-1">{digest.date}</p>
          <pre className="whitespace-pre-wrap rounded-md bg-paper-warm p-3 text-sm text-ink-900">{digest.text}</pre>
          <p className="mt-2 text-xs text-ink-500">Revenue is paid orders net of refunds. {digest.outlets.length ? `Total ${formatMoney(digest.outlets.reduce((a, o) => a + o.revenue, 0))} across ${digest.outlets.length} ${digest.outlets.length === 1 ? "outlet" : "outlets"}.` : ""}</p>
        </>
      ) : <p className="text-sm text-ink-500">See what the morning message will say, using the previous business day&apos;s real figures.</p>}
    </Card>
  );
}

export function GrowthSettingsScreen() {
  const { can } = useShell();
  const settings = useQuery<Settings>("/api/growth/settings");
  const coupons = useQuery<CouponRow[]>("/api/growth/coupons");
  return (
    <>
      <PageHeader title="Growth settings" subtitle="What runs automatically, and the rules every guest message follows" />
      {settings.loading && !settings.data ? <LoadingState /> : settings.error ? <ErrorState error={settings.error} onRetry={settings.reload} /> : settings.data ? (
        <div className="space-y-4">
          <SettingsForm initial={settings.data} coupons={coupons.data ?? []} canManage={can("growth.manage")} onSaved={(s) => settings.setData(() => s)} />
          <DigestPreview />
        </div>
      ) : null}
    </>
  );
}
