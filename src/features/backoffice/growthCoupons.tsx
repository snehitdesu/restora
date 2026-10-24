"use client";

/**
 * Coupons: the codes guests and cashiers enter. The server prices every one of them (percent / fixed, cap, minimum,
 * validity, limits, first order, tier, channels, outlets); this screen only edits the rules and shows what they cost.
 */
import { useState } from "react";
import { api } from "@/lib/api/client";
import { useQuery } from "@/lib/hooks/useApi";
import { useShell } from "@/lib/shellContext";
import { formatDate, formatDateTime, formatMoney, humanize } from "@/lib/format";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { Badge } from "@/components/ui/Badge";
import { Checkbox, Field, FormDialog, Input, Select, Textarea, opt, optNum } from "@/components/ui/Form";
import { Dialog } from "@/components/ui/Dialog";
import { DataTable } from "@/components/ui/Table";
import { PageHeader, Stat } from "@/components/ui/Page";
import { FilterBar, SearchInput, SelectFilter } from "@/components/ui/Filters";

export type CouponRow = {
  id: string; code: string; name: string; description: string | null; kind: "PERCENT" | "FIXED"; value: number; maxDiscount: number | null; minOrderValue: number | null;
  validFrom: string | null; validTo: string | null; usageLimit: number | null; perCustomerLimit: number | null; firstOrderOnly: boolean; minTier: string | null;
  channels: string[]; outletIds: string[]; stackable: boolean; active: boolean; createdAt: string; redeemed?: number; discountGiven?: number;
};
export type TierRow = { id: string; code: string; name: string; minSpend: number; earnMultiplierPct: number; perks: string | null; sortOrder: number; active: boolean };
type Redemption = { id: string; orderId: string; customerId: string | null; amount: number; status: string; reverseReason: string | null; createdAt: string };

export const COUPON_CHANNELS = ["DINE_IN", "TAKEAWAY", "DELIVERY", "QR", "ONLINE"] as const;

export const describeOffer = (c: Pick<CouponRow, "kind" | "value" | "maxDiscount">) =>
  c.kind === "PERCENT" ? `${c.value}% off${c.maxDiscount ? `, up to ${formatMoney(c.maxDiscount)}` : ""}` : `${formatMoney(c.value)} off`;

/** A date input's day, as the start or the very end of that local day. */
const startOfDay = (d: string) => (d ? new Date(`${d}T00:00:00`).toISOString() : undefined);
const endOfDay = (d: string) => (d ? new Date(`${d}T23:59:59`).toISOString() : undefined);
const dayOf = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("en-CA") : "");

function CouponDialog({ coupon, tiers, onClose, onDone }: { coupon?: CouponRow; tiers: TierRow[]; onClose: () => void; onDone: () => void }) {
  const [code, setCode] = useState(coupon?.code ?? "");
  const [name, setName] = useState(coupon?.name ?? "");
  const [description, setDescription] = useState(coupon?.description ?? "");
  const [kind, setKind] = useState<"PERCENT" | "FIXED">(coupon?.kind ?? "PERCENT");
  const [value, setValue] = useState(coupon ? String(coupon.value) : "");
  const [maxDiscount, setMaxDiscount] = useState(coupon?.maxDiscount != null ? String(coupon.maxDiscount) : "");
  const [minOrder, setMinOrder] = useState(coupon?.minOrderValue != null ? String(coupon.minOrderValue) : "");
  const [from, setFrom] = useState(dayOf(coupon?.validFrom ?? null));
  const [to, setTo] = useState(dayOf(coupon?.validTo ?? null));
  const [usageLimit, setUsageLimit] = useState(coupon?.usageLimit != null ? String(coupon.usageLimit) : "");
  const [perCustomer, setPerCustomer] = useState(coupon?.perCustomerLimit != null ? String(coupon.perCustomerLimit) : "");
  const [firstOrderOnly, setFirstOrderOnly] = useState(coupon?.firstOrderOnly ?? false);
  const [minTier, setMinTier] = useState(coupon?.minTier ?? "");
  const [channels, setChannels] = useState<string[]>(coupon?.channels ?? []);
  const [stackable, setStackable] = useState(coupon?.stackable ?? false);
  const [active, setActive] = useState(coupon?.active ?? true);
  const used = (coupon?.redeemed ?? 0) > 0;
  const body = {
    code: code.trim().toUpperCase(), name: name.trim(), description: opt(description), kind, value: Number(value),
    maxDiscount: kind === "PERCENT" ? optNum(maxDiscount) ?? null : null, minOrderValue: optNum(minOrder) ?? null,
    validFrom: startOfDay(from) ?? null, validTo: endOfDay(to) ?? null, usageLimit: optNum(usageLimit) ?? null, perCustomerLimit: optNum(perCustomer) ?? null,
    firstOrderOnly, minTier: minTier || null, channels, stackable, active,
  };
  return (
    <FormDialog open onClose={onClose} size="lg" title={coupon ? `Edit ${coupon.code}` : "New coupon"} submitLabel={coupon ? "Save" : "Create coupon"}
      description="The server works out the discount on every order; guests and cashiers only type the code."
      onSubmit={() => (coupon ? api(`/api/growth/coupons/${coupon.id}`, { method: "PATCH", body }) : api("/api/growth/coupons", { method: "POST", body }))} onDone={onDone}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Code" name="code" required hint={used ? "Already used: deactivate it and create a new code instead." : "3-20 letters or digits, e.g. WELCOME10"}>
          <Input value={code} onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))} required minLength={3} maxLength={20} disabled={used} className="font-mono uppercase" />
        </Field>
        <Field label="Name" name="name" required hint="Shown to staff"><Input value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} /></Field>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Type" name="kind" required>
          <Select value={kind} onChange={(e) => setKind(e.target.value as "PERCENT" | "FIXED")}><option value="PERCENT">Percent off</option><option value="FIXED">Fixed amount off</option></Select>
        </Field>
        <Field label={kind === "PERCENT" ? "Percent" : "Amount (₹)"} name="value" required><Input type="number" inputMode="decimal" min={0.01} max={kind === "PERCENT" ? 100 : undefined} step="any" required value={value} onChange={(e) => setValue(e.target.value)} /></Field>
        {kind === "PERCENT" && <Field label="Cap (₹)" name="maxDiscount" hint="Most it can take off"><Input type="number" inputMode="decimal" min={0} step="any" value={maxDiscount} onChange={(e) => setMaxDiscount(e.target.value)} /></Field>}
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Minimum order (₹)" name="minOrderValue"><Input type="number" inputMode="decimal" min={0} step="any" value={minOrder} onChange={(e) => setMinOrder(e.target.value)} /></Field>
        <Field label="Valid from" name="validFrom"><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
        <Field label="Valid until (inclusive)" name="validTo"><Input type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} /></Field>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Total uses" name="usageLimit" hint="Blank: unlimited"><Input type="number" inputMode="numeric" min={1} step={1} value={usageLimit} onChange={(e) => setUsageLimit(e.target.value)} /></Field>
        <Field label="Uses per guest" name="perCustomerLimit"><Input type="number" inputMode="numeric" min={1} step={1} value={perCustomer} onChange={(e) => setPerCustomer(e.target.value)} /></Field>
        <Field label="Only for tier" name="minTier" hint={tiers.length ? "This tier and above" : "Set up loyalty tiers first"}>
          <Select value={minTier} onChange={(e) => setMinTier(e.target.value)} disabled={!tiers.length}><option value="">Any guest</option>{tiers.filter((t) => t.active).map((t) => <option key={t.code} value={t.code}>{t.name}</option>)}</Select>
        </Field>
      </div>
      <fieldset className="rounded-md border border-ink-200 p-3">
        <legend className="px-1 text-sm font-medium text-ink-700">Works on</legend>
        <div className="flex flex-wrap gap-x-5 gap-y-2">
          {COUPON_CHANNELS.map((c) => <Checkbox key={c} label={humanize(c)} checked={channels.includes(c)} onChange={(on) => setChannels((s) => (on ? [...s, c] : s.filter((x) => x !== c)))} />)}
        </div>
        <p className="mt-2 text-xs text-ink-500">{channels.length ? "Only on the ticked order types." : "Nothing ticked: every order type."}</p>
      </fieldset>
      <Field label="Description" name="description"><Textarea value={description} onChange={(e) => setDescription(e.target.value)} maxLength={300} /></Field>
      <div className="flex flex-wrap gap-x-6 gap-y-2">
        <Checkbox label="First order only" checked={firstOrderOnly} onChange={setFirstOrderOnly} />
        <Checkbox label="Can be combined with a manual discount" checked={stackable} onChange={setStackable} />
        {coupon && <Checkbox label="Active" checked={active} onChange={setActive} />}
      </div>
    </FormDialog>
  );
}

function RedemptionsDialog({ coupon, onClose }: { coupon: CouponRow; onClose: () => void }) {
  const list = useQuery<Redemption[]>(`/api/growth/coupons/${coupon.id}/redemptions`);
  return (
    <Dialog open onClose={onClose} title={`${coupon.code} — uses`} size="lg" footer={<Button onClick={onClose}>Close</Button>}>
      <DataTable label="Coupon uses" rows={list.data ?? []} rowKey={(r) => r.id} loading={list.loading} error={list.error} onRetry={list.reload} empty="Not used yet"
        columns={[
          { key: "d", header: "When", cell: (r) => formatDateTime(r.createdAt) },
          { key: "o", header: "Order", cell: (r) => `#${r.orderId.slice(-6).toUpperCase()}` },
          { key: "a", header: "Discount", numeric: true, cell: (r) => formatMoney(r.amount) },
          { key: "s", header: "Status", cell: (r) => <Badge tone={r.status === "APPLIED" ? "ok" : "neutral"}>{humanize(r.status)}</Badge> },
          { key: "n", header: "Note", cell: (r) => r.reverseReason ?? "—" },
        ]} />
    </Dialog>
  );
}

export function CouponsScreen() {
  const { can } = useShell();
  const [search, setSearch] = useState("");
  const [state, setState] = useState("");
  const list = useQuery<CouponRow[]>("/api/growth/coupons", { search: search || undefined, active: state === "Active" ? "true" : state === "Inactive" ? "false" : undefined });
  const tiers = useQuery<TierRow[]>("/api/growth/tiers");
  const [editing, setEditing] = useState<CouponRow | "new" | null>(null);
  const [usage, setUsage] = useState<CouponRow | null>(null);
  const rows = list.data ?? [];
  const live = rows.filter((c) => c.active);
  return (
    <>
      <PageHeader title="Coupons" subtitle="Codes for guests and the counter. The server prices every order." actions={can("growth.manage") && <Button variant="primary" onClick={() => setEditing("new")}><Icon name="plus" /> New coupon</Button>} />
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Active codes" value={list.loading && !list.data ? "…" : live.length} />
        <Stat label="Times used" value={list.loading && !list.data ? "…" : rows.reduce((a, c) => a + (c.redeemed ?? 0), 0)} />
        <Stat label="Discount given" value={list.loading && !list.data ? "…" : formatMoney(rows.reduce((a, c) => a + (c.discountGiven ?? 0), 0))} />
      </div>
      <FilterBar>
        <SearchInput value={search} onChange={setSearch} placeholder="Code or name…" />
        <SelectFilter label="Status" value={state} onChange={setState} options={["Active", "Inactive"]} />
      </FilterBar>
      <DataTable label="Coupons" rows={rows} rowKey={(r) => r.id} loading={list.loading} error={list.error} onRetry={list.reload}
        empty={search || state ? "No coupons match" : "No coupons yet"} emptyHint={can("growth.manage") ? "Create WELCOME10 or a festival code to start." : undefined}
        columns={[
          { key: "c", header: "Code", cell: (r) => <span className="font-mono font-semibold text-ink-900">{r.code}</span> },
          { key: "n", header: "Name", cell: (r) => r.name },
          { key: "o", header: "Offer", cell: (r) => describeOffer(r) },
          { key: "r", header: "Rules", cell: (r) => <span className="text-ink-500">{[r.minOrderValue ? `min ${formatMoney(r.minOrderValue)}` : null, r.firstOrderOnly ? "first order" : null, r.minTier ? `${r.minTier}+` : null, r.perCustomerLimit ? `${r.perCustomerLimit} per guest` : null, r.channels.length ? r.channels.map(humanize).join(", ") : null].filter(Boolean).join(" · ") || "—"}</span> },
          { key: "v", header: "Valid", cell: (r) => (r.validFrom || r.validTo ? `${r.validFrom ? formatDate(r.validFrom) : "…"} – ${r.validTo ? formatDate(r.validTo) : "…"}` : "Always") },
          { key: "u", header: "Used", numeric: true, cell: (r) => `${r.redeemed ?? 0}${r.usageLimit ? ` / ${r.usageLimit}` : ""}` },
          { key: "g", header: "Given", numeric: true, cell: (r) => formatMoney(r.discountGiven ?? 0) },
          { key: "s", header: "Status", cell: (r) => <Badge tone={r.active ? "ok" : "neutral"}>{r.active ? "Active" : "Inactive"}</Badge> },
          { key: "a", header: "", cell: (r) => (
            <div className="flex justify-end gap-1">
              <Button size="sm" variant="ghost" onClick={() => setUsage(r)}>Uses</Button>
              {can("growth.manage") && <Button size="sm" variant="ghost" onClick={() => setEditing(r)} aria-label={`Edit ${r.code}`}><Icon name="edit" /></Button>}
            </div>
          ) },
        ]} />
      {editing && <CouponDialog coupon={editing === "new" ? undefined : editing} tiers={tiers.data ?? []} onClose={() => setEditing(null)} onDone={list.reload} />}
      {usage && <RedemptionsDialog coupon={usage} onClose={() => setUsage(null)} />}
    </>
  );
}
