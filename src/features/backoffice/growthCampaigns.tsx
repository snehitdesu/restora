"use client";

/**
 * Campaigns: one message to the guests who agreed to offers on a channel. The audience is a rule set evaluated when the
 * campaign is sent (consent, spend, visits, last visit, birthday month, tier); every message carries a one-click
 * unsubscribe link; quiet hours and the weekly cap per guest are enforced by the server.
 */
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { api } from "@/lib/api/client";
import { useAction, useQuery } from "@/lib/hooks/useApi";
import { useShell } from "@/lib/shellContext";
import { formatDateTime, humanize } from "@/lib/format";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { Badge } from "@/components/ui/Badge";
import { Dialog } from "@/components/ui/Dialog";
import { Field, FormDialog, Input, Select, Textarea, opt, optNum } from "@/components/ui/Form";
import { DataTable } from "@/components/ui/Table";
import { Card, Details, PageHeader, Stat } from "@/components/ui/Page";
import { ErrorState, LoadingState } from "@/components/ui/States";
import { FilterBar, SelectFilter } from "@/components/ui/Filters";
import type { CouponRow, TierRow } from "@/features/backoffice/growthCoupons";

export const CHANNELS = [{ value: "WHATSAPP", label: "WhatsApp" }, { value: "SMS", label: "SMS" }, { value: "EMAIL", label: "E-mail" }] as const;
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const STATUS_TONE: Record<string, "neutral" | "info" | "ok" | "warn" | "bad" | "brand"> = { DRAFT: "neutral", SCHEDULED: "info", SENDING: "warn", SENT: "ok", CANCELLED: "bad" };

type Audience = { segment?: string; minOrders?: number; minSpend?: number; lastOrderBeforeDays?: number; lastOrderWithinDays?: number; birthdayMonth?: number; anniversaryMonth?: number; tier?: string };
export type CampaignRow = {
  id: string; name: string; channel: "SMS" | "WHATSAPP" | "EMAIL"; kind: string; audience: Audience; body: string; couponId: string | null; status: string;
  scheduledAt: string | null; startedAt: string | null; completedAt: string | null; recipientCount: number; createdAt: string;
};
type Detail = { campaign: CampaignRow; recipients: Record<string, number>; skippedBecause: Array<{ reason: string; count: number }>; deliveries: Record<string, number> };
type Preview = { matching: number; optedInOnChannel: number; sample: string[] };

const channelLabel = (c: string) => CHANNELS.find((x) => x.value === c)?.label ?? humanize(c);

export function audienceSummary(a: Audience): string {
  const parts = [
    a.segment ? `${humanize(a.segment)} guests` : null,
    a.minOrders ? `${a.minOrders}+ orders` : null,
    a.minSpend ? `₹${a.minSpend}+ spent` : null,
    a.lastOrderBeforeDays ? `last visit over ${a.lastOrderBeforeDays} days ago` : null,
    a.lastOrderWithinDays ? `visited in the last ${a.lastOrderWithinDays} days` : null,
    a.birthdayMonth ? `birthday in ${MONTHS[a.birthdayMonth - 1]}` : null,
    a.anniversaryMonth ? `anniversary in ${MONTHS[a.anniversaryMonth - 1]}` : null,
    a.tier ? `${a.tier} tier` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(", ") : "Everyone who agreed to offers";
}

const PLACEHOLDER_HELP = "{name} · {restaurant} · {code} (needs a coupon)";

function CampaignDialog({ campaign, onClose, onDone }: { campaign?: CampaignRow; onClose: () => void; onDone: (c: CampaignRow) => void }) {
  const tiers = useQuery<TierRow[]>("/api/growth/tiers");
  const coupons = useQuery<CouponRow[]>("/api/growth/coupons", { active: "true" });
  const a = campaign?.audience ?? {};
  const [name, setName] = useState(campaign?.name ?? "");
  const [channel, setChannel] = useState<CampaignRow["channel"]>(campaign?.channel ?? "WHATSAPP");
  const [body, setBody] = useState(campaign?.body ?? "");
  const [couponId, setCouponId] = useState(campaign?.couponId ?? "");
  const [segment, setSegment] = useState(a.segment ?? "");
  const [minOrders, setMinOrders] = useState(a.minOrders != null ? String(a.minOrders) : "");
  const [minSpend, setMinSpend] = useState(a.minSpend != null ? String(a.minSpend) : "");
  const [before, setBefore] = useState(a.lastOrderBeforeDays != null ? String(a.lastOrderBeforeDays) : "");
  const [within, setWithin] = useState(a.lastOrderWithinDays != null ? String(a.lastOrderWithinDays) : "");
  const [bMonth, setBMonth] = useState(a.birthdayMonth != null ? String(a.birthdayMonth) : "");
  const [aMonth, setAMonth] = useState(a.anniversaryMonth != null ? String(a.anniversaryMonth) : "");
  const [tier, setTier] = useState(a.tier ?? "");
  const audience: Audience = {
    ...(segment ? { segment } : {}), ...(optNum(minOrders) !== undefined ? { minOrders: optNum(minOrders) } : {}), ...(optNum(minSpend) !== undefined ? { minSpend: optNum(minSpend) } : {}),
    ...(optNum(before) !== undefined ? { lastOrderBeforeDays: optNum(before) } : {}), ...(optNum(within) !== undefined ? { lastOrderWithinDays: optNum(within) } : {}),
    ...(bMonth ? { birthdayMonth: Number(bMonth) } : {}), ...(aMonth ? { anniversaryMonth: Number(aMonth) } : {}), ...(tier ? { tier } : {}),
  };
  // Live audience size: asked of the server (the rules run on real consent and order data), debounced.
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const key = JSON.stringify([channel, audience]);
  useEffect(() => {
    const ctrl = new AbortController();
    const t = setTimeout(() => {
      api<Preview>("/api/growth/campaigns/preview", { method: "POST", body: { channel, audience }, signal: ctrl.signal })
        .then((p) => { if (!ctrl.signal.aborted) { setPreview(p); setPreviewError(null); } })
        .catch((e) => { if (!ctrl.signal.aborted && (e as { name?: string })?.name !== "AbortError") { setPreview(null); setPreviewError("Check the audience rules"); } });
    }, 350);
    return () => { clearTimeout(t); ctrl.abort(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const payload = { name: name.trim(), channel, audience, body: body.trim(), couponId: couponId || null };
  return (
    <FormDialog open onClose={onClose} size="lg" title={campaign ? "Edit campaign" : "New campaign"} submitLabel={campaign ? "Save draft" : "Save as draft"}
      description="You review and send it from the next screen. Only guests who agreed to offers on this channel are ever written to."
      onSubmit={() => (campaign ? api<CampaignRow>(`/api/growth/campaigns/${campaign.id}`, { method: "PATCH", body: payload }) : api<CampaignRow>("/api/growth/campaigns", { method: "POST", body: payload }))} onDone={onDone}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name" name="name" required hint="Only staff see this"><Input value={name} onChange={(e) => setName(e.target.value)} required minLength={2} maxLength={80} /></Field>
        <Field label="Channel" name="channel" required>
          <Select value={channel} onChange={(e) => setChannel(e.target.value as CampaignRow["channel"])}>{CHANNELS.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}</Select>
        </Field>
      </div>
      <fieldset className="rounded-md border border-ink-200 p-3">
        <legend className="px-1 text-sm font-medium text-ink-700">Who</legend>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Segment" name="segment"><Select value={segment} onChange={(e) => setSegment(e.target.value)}><option value="">Anyone</option>{["NEW", "RETURNING", "VIP", "INACTIVE"].map((s) => <option key={s} value={s}>{humanize(s)}</option>)}</Select></Field>
          <Field label="At least this many orders" name="minOrders"><Input type="number" inputMode="numeric" min={0} step={1} value={minOrders} onChange={(e) => setMinOrders(e.target.value)} /></Field>
          <Field label="Spent at least (₹)" name="minSpend"><Input type="number" inputMode="decimal" min={0} step="any" value={minSpend} onChange={(e) => setMinSpend(e.target.value)} /></Field>
          <Field label="Last visit over … days ago" name="lastOrderBeforeDays"><Input type="number" inputMode="numeric" min={1} step={1} value={before} onChange={(e) => setBefore(e.target.value)} /></Field>
          <Field label="Visited in the last … days" name="lastOrderWithinDays"><Input type="number" inputMode="numeric" min={1} step={1} value={within} onChange={(e) => setWithin(e.target.value)} /></Field>
          <Field label="Tier" name="audience"><Select value={tier} onChange={(e) => setTier(e.target.value)} disabled={!tiers.data?.length}><option value="">Any tier</option>{(tiers.data ?? []).map((t) => <option key={t.code} value={t.code}>{t.name}</option>)}</Select></Field>
          <Field label="Birthday month" name="birthdayMonth"><Select value={bMonth} onChange={(e) => setBMonth(e.target.value)}><option value="">Any</option>{MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}</Select></Field>
          <Field label="Anniversary month" name="anniversaryMonth"><Select value={aMonth} onChange={(e) => setAMonth(e.target.value)}><option value="">Any</option>{MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}</Select></Field>
        </div>
        <p className="mt-3 text-sm" role="status" aria-live="polite">
          {previewError ? <span className="text-bad-600">{previewError}</span> : preview ? (
            <>
              <strong className="text-ink-900">{preview.matching}</strong> {preview.matching === 1 ? "guest matches" : "guests match"}
              <span className="text-ink-500"> · {preview.optedInOnChannel} agreed to {channelLabel(channel)} offers{preview.sample.length ? ` · e.g. ${preview.sample.slice(0, 3).join(", ")}` : ""}</span>
            </>
          ) : <span className="text-ink-500">Counting…</span>}
        </p>
      </fieldset>
      <Field label="Message" name="body" required hint={`Placeholders: ${PLACEHOLDER_HELP}. An unsubscribe link is added to every message.`}>
        <Textarea value={body} onChange={(e) => setBody(e.target.value)} required minLength={5} maxLength={600} rows={4} />
      </Field>
      <Field label="Coupon to include" name="couponId" hint="Fills {code} in the message">
        <Select value={couponId} onChange={(e) => setCouponId(e.target.value)}><option value="">None</option>{(coupons.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.code} — {c.name}</option>)}</Select>
      </Field>
    </FormDialog>
  );
}

export function CampaignsScreen() {
  const router = useRouter();
  const { can } = useShell();
  const [status, setStatus] = useState("");
  const list = useQuery<CampaignRow[]>("/api/growth/campaigns", { status: status || undefined });
  const [creating, setCreating] = useState(false);
  return (
    <>
      <PageHeader title="Campaigns" subtitle="Offers to guests who agreed to hear from you" actions={can("growth.manage") && <Button variant="primary" onClick={() => setCreating(true)}><Icon name="plus" /> New campaign</Button>} />
      <FilterBar><SelectFilter label="Status" value={status} onChange={setStatus} options={["DRAFT", "SCHEDULED", "SENDING", "SENT", "CANCELLED"].map((s) => ({ value: s, label: humanize(s) }))} /></FilterBar>
      <DataTable label="Campaigns" rows={list.data ?? []} rowKey={(r) => r.id} loading={list.loading} error={list.error} onRetry={list.reload} onRowClick={(r) => router.push(`/customers/campaigns/${r.id}`)}
        empty={status ? "No campaigns with this status" : "No campaigns yet"} emptyHint={can("growth.manage") ? "Start with a weekend special for guests who agreed to WhatsApp offers." : undefined}
        columns={[
          { key: "n", header: "Name", cell: (r) => <span className="font-medium text-ink-900">{r.name}</span> },
          { key: "c", header: "Channel", cell: (r) => channelLabel(r.channel) },
          { key: "a", header: "Audience", cell: (r) => <span className="text-ink-500">{audienceSummary(r.audience)}</span> },
          { key: "s", header: "Status", cell: (r) => <Badge tone={STATUS_TONE[r.status] ?? "neutral"}>{humanize(r.status)}</Badge> },
          { key: "w", header: "When", cell: (r) => formatDateTime(r.completedAt ?? r.scheduledAt ?? r.createdAt) },
          { key: "r", header: "Guests", numeric: true, cell: (r) => (r.recipientCount || "—") },
        ]} />
      {creating && <CampaignDialog onClose={() => setCreating(false)} onDone={(c) => router.push(`/customers/campaigns/${c.id}`)} />}
    </>
  );
}

function ScheduleDialog({ campaign, onClose, onDone }: { campaign: CampaignRow; onClose: () => void; onDone: () => void }) {
  const [mode, setMode] = useState<"now" | "later">("now");
  const [at, setAt] = useState("");
  return (
    <FormDialog open onClose={onClose} title="Send campaign" submitLabel={mode === "now" ? "Send now" : "Schedule"}
      description="Guests are checked again at send time: anyone who has since unsubscribed, or who has reached this week's limit, is skipped. Messages wait for the morning during quiet hours."
      onSubmit={() => api(`/api/growth/campaigns/${campaign.id}/schedule`, { method: "POST", body: mode === "later" && at ? { at: new Date(at).toISOString() } : {} })} onDone={onDone}>
      <Field label="When" name="at">
        <Select value={mode} onChange={(e) => setMode(e.target.value as "now" | "later")}><option value="now">As soon as possible</option><option value="later">At a set time</option></Select>
      </Field>
      {mode === "later" && <Field label="Send at" name="at" required><Input type="datetime-local" required value={at} onChange={(e) => setAt(e.target.value)} /></Field>}
    </FormDialog>
  );
}

export function CampaignDetailScreen({ id }: { id: string }) {
  const { can } = useShell();
  const detail = useQuery<Detail>(`/api/growth/campaigns/${id}`);
  const coupons = useQuery<CouponRow[]>("/api/growth/coupons");
  const act = useAction();
  const [dialog, setDialog] = useState<"edit" | "schedule" | "cancel" | null>(null);
  const status = detail.data?.campaign.status;
  useEffect(() => {
    if (status !== "SCHEDULED" && status !== "SENDING") return;
    const t = setInterval(() => detail.reload(), 8000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);
  if (detail.loading && !detail.data) return <LoadingState />;
  if (detail.error && !detail.data) return <ErrorState error={detail.error} onRetry={detail.reload} />;
  if (!detail.data) return null;
  const { campaign: c, recipients, skippedBecause, deliveries } = detail.data;
  const coupon = coupons.data?.find((x) => x.id === c.couponId);
  const sum = (o: Record<string, number>) => Object.values(o).reduce((a, b) => a + b, 0);
  return (
    <>
      <PageHeader title={c.name} back={{ href: "/customers/campaigns", label: "Campaigns" }} badge={<Badge tone={STATUS_TONE[c.status] ?? "neutral"}>{humanize(c.status)}</Badge>}
        subtitle={`${channelLabel(c.channel)} · ${audienceSummary(c.audience)}`}
        actions={can("growth.manage") && (
          <>
            {c.status === "DRAFT" && <Button onClick={() => setDialog("edit")}><Icon name="edit" /> Edit</Button>}
            {c.status === "DRAFT" && <Button variant="primary" onClick={() => setDialog("schedule")}><Icon name="send" /> Send…</Button>}
            {["DRAFT", "SCHEDULED", "SENDING"].includes(c.status) && <Button variant="danger" onClick={() => setDialog("cancel")}>Cancel campaign</Button>}
          </>
        )} />
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Guests" value={c.recipientCount || "—"} hint={c.recipientCount ? undefined : "Counted when sending starts"} />
        <Stat label="Sent" value={recipients.SENT ?? 0} tone={recipients.SENT ? "ok" : undefined} />
        <Stat label="Waiting" value={recipients.QUEUED ?? 0} hint={c.status === "SENDING" ? "Sent in batches; quiet hours wait for the morning" : undefined} />
        <Stat label="Skipped" value={recipients.SKIPPED ?? 0} tone={recipients.SKIPPED ? "bad" : undefined} />
      </div>
      <div className="grid gap-4 lg:grid-cols-[1fr_22rem]">
        <Card title="Message">
          <p className="whitespace-pre-wrap rounded-md bg-paper-warm p-3 text-sm text-ink-900">{c.body}</p>
          <p className="mt-2 text-xs text-ink-500">An unsubscribe link is added to every message when it is sent.</p>
          <div className="mt-4"><Details cols={2} items={[["Coupon", coupon ? `${coupon.code} — ${coupon.name}` : c.couponId ? "Removed" : "None"], ["Scheduled for", formatDateTime(c.scheduledAt)], ["Started", formatDateTime(c.startedAt)], ["Finished", formatDateTime(c.completedAt)]]} /></div>
        </Card>
        <Card title="Outcome">
          {skippedBecause.length ? (
            <>
              <p className="eyebrow mb-1">Why guests were skipped</p>
              <ul className="mb-3 space-y-1 text-sm">{skippedBecause.map((s) => <li key={s.reason} className="flex justify-between gap-3"><span>{s.reason || "No reason recorded"}</span><span className="tabular-nums text-ink-500">{s.count}</span></li>)}</ul>
            </>
          ) : null}
          <p className="eyebrow mb-1">Delivery to the provider</p>
          {sum(deliveries) ? <ul className="space-y-1 text-sm">{Object.entries(deliveries).map(([k, v]) => <li key={k} className="flex justify-between gap-3"><span>{humanize(k)}</span><span className="tabular-nums text-ink-500">{v}</span></li>)}</ul> : <p className="text-sm text-ink-500">Nothing handed over yet.</p>}
        </Card>
      </div>
      {dialog === "edit" && <CampaignDialog campaign={c} onClose={() => setDialog(null)} onDone={() => detail.reload()} />}
      {dialog === "schedule" && <ScheduleDialog campaign={c} onClose={() => setDialog(null)} onDone={() => detail.reload()} />}
      {dialog === "cancel" && (
        <Dialog open onClose={() => setDialog(null)} title="Cancel this campaign?" size="sm"
          footer={<><Button onClick={() => setDialog(null)}>Keep it</Button><Button variant="danger" loading={act.busy} onClick={() => void act.run(async () => { await api(`/api/growth/campaigns/${c.id}/cancel`, { method: "POST", body: {} }); setDialog(null); detail.reload(); }, { success: "Campaign cancelled" })}>Cancel campaign</Button></>}>
          <p className="text-sm text-ink-700">Guests who have not been written to yet are dropped. Messages already sent stay sent.</p>
        </Dialog>
      )}
      <p className="mt-4 text-sm text-ink-500">Guests&apos; own preferences are on <Link className="text-brand-600 underline underline-offset-2 hover:no-underline" href="/customers">their profiles</Link>.</p>
    </>
  );
}
