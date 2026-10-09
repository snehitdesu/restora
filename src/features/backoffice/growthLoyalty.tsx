"use client";

/**
 * Loyalty and referrals. A guest's tier follows what they spent in the last 365 days (so it can also go down); a tier
 * sets the multiplier on the points they earn. Referral rewards are paid once, on the friend's first paid order.
 * Both are computed by the server; this screen sets the rules and shows the results.
 */
import Link from "next/link";
import { useState } from "react";
import { api } from "@/lib/api/client";
import { useQuery } from "@/lib/hooks/useApi";
import { useShell } from "@/lib/shellContext";
import { formatDateTime, formatMoney, humanize } from "@/lib/format";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { Badge } from "@/components/ui/Badge";
import { Checkbox, Field, FormDialog, Input, opt } from "@/components/ui/Form";
import { DataTable } from "@/components/ui/Table";
import { Card, PageHeader, Stat, Tabs } from "@/components/ui/Page";
import { EmptyState } from "@/components/ui/States";
import { FilterBar, SelectFilter } from "@/components/ui/Filters";
import type { TierRow } from "@/features/backoffice/growthCoupons";

type ReferralRow = {
  id: string; referrer: { id: string; name: string }; referred: { id: string; name: string }; status: string; rejectReason: string | null;
  referrerPoints: number | null; refereePoints: number | null; createdAt: string; rewardedAt: string | null;
};
type ReferralSummary = { pending: number; rewarded: number; rejected: number; pointsGiven: number };
type Settings = { referralEnabled: boolean; referrerPoints: number; refereePoints: number; referralMinOrderValue: number; referralMonthlyCap: number };

const REF_TONE: Record<string, "neutral" | "ok" | "bad" | "info"> = { PENDING: "info", REWARDED: "ok", REJECTED: "bad" };

function TierDialog({ tier, onClose, onDone }: { tier?: TierRow; onClose: () => void; onDone: () => void }) {
  const [code, setCode] = useState(tier?.code ?? "");
  const [name, setName] = useState(tier?.name ?? "");
  const [minSpend, setMinSpend] = useState(tier ? String(tier.minSpend) : "");
  const [mult, setMult] = useState(tier ? String(tier.earnMultiplierPct) : "100");
  const [perks, setPerks] = useState(tier?.perks ?? "");
  const [active, setActive] = useState(tier?.active ?? true);
  return (
    <FormDialog open onClose={onClose} title={tier ? `Edit ${tier.name}` : "New tier"} submitLabel={tier ? "Save" : "Add tier"}
      description="Exactly one active tier must start at ₹0 spend, and every tier needs its own spend threshold."
      onSubmit={() => api("/api/growth/tiers", { method: "POST", body: { id: tier?.id, code: code.trim(), name: name.trim(), minSpend: Number(minSpend), earnMultiplierPct: Number(mult), perks: opt(perks) ?? null, active } })} onDone={onDone}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Code" name="code" required hint="Short and stable, e.g. GOLD"><Input value={code} onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, ""))} required minLength={2} maxLength={20} disabled={Boolean(tier)} className="font-mono" /></Field>
        <Field label="Name" name="name" required hint="What the guest sees"><Input value={name} onChange={(e) => setName(e.target.value)} required minLength={2} maxLength={40} /></Field>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Spend in the last 365 days (₹)" name="minSpend" required><Input type="number" inputMode="decimal" min={0} step="any" required value={minSpend} onChange={(e) => setMinSpend(e.target.value)} /></Field>
        <Field label="Points earned (%)" name="earnMultiplierPct" required hint="100 = normal, 150 = one and a half times"><Input type="number" inputMode="decimal" min={50} max={500} step="any" required value={mult} onChange={(e) => setMult(e.target.value)} /></Field>
      </div>
      <Field label="Perks" name="perks" hint="Shown to staff, e.g. free dessert on birthdays"><Input value={perks} onChange={(e) => setPerks(e.target.value)} maxLength={300} /></Field>
      {tier && <Checkbox label="Active" checked={active} onChange={setActive} />}
    </FormDialog>
  );
}

function ReferralRulesDialog({ settings, onClose, onDone }: { settings: Settings; onClose: () => void; onDone: () => void }) {
  const [enabled, setEnabled] = useState(settings.referralEnabled);
  const [referrer, setReferrer] = useState(String(settings.referrerPoints));
  const [referee, setReferee] = useState(String(settings.refereePoints));
  const [min, setMin] = useState(String(settings.referralMinOrderValue));
  const [cap, setCap] = useState(String(settings.referralMonthlyCap));
  return (
    <FormDialog open onClose={onClose} title="Referral rewards" submitLabel="Save"
      description="Points are paid once, when the friend's first order is paid. They are taken back if that order is refunded."
      onSubmit={() => api("/api/growth/settings", { method: "PATCH", body: { referralEnabled: enabled, referrerPoints: Number(referrer), refereePoints: Number(referee), referralMinOrderValue: Number(min), referralMonthlyCap: Number(cap) } })} onDone={onDone}>
      <Checkbox label="Referral program is on" checked={enabled} onChange={setEnabled} />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Points for the guest who refers" name="referrerPoints"><Input type="number" inputMode="numeric" min={0} step={1} value={referrer} onChange={(e) => setReferrer(e.target.value)} /></Field>
        <Field label="Points for the friend" name="refereePoints"><Input type="number" inputMode="numeric" min={0} step={1} value={referee} onChange={(e) => setReferee(e.target.value)} /></Field>
        <Field label="Friend's first order at least (₹)" name="referralMinOrderValue"><Input type="number" inputMode="decimal" min={0} step="any" value={min} onChange={(e) => setMin(e.target.value)} /></Field>
        <Field label="Rewards per guest per month" name="referralMonthlyCap" hint="Stops abuse"><Input type="number" inputMode="numeric" min={1} step={1} value={cap} onChange={(e) => setCap(e.target.value)} /></Field>
      </div>
    </FormDialog>
  );
}

export function LoyaltyScreen() {
  const { can } = useShell();
  const [tab, setTab] = useState<"tiers" | "referrals">("tiers");
  const tiers = useQuery<TierRow[]>("/api/growth/tiers");
  const [tierDialog, setTierDialog] = useState<TierRow | "new" | null>(null);
  const [status, setStatus] = useState("");
  const canView = can("growth.view");
  const referrals = useQuery<ReferralRow[]>(tab === "referrals" && canView ? "/api/growth/referrals" : null, { status: status || undefined });
  const summary = useQuery<ReferralSummary>(tab === "referrals" && canView ? "/api/growth/referrals/summary" : null);
  const settings = useQuery<Settings>(tab === "referrals" && canView ? "/api/growth/settings" : null);
  const [rules, setRules] = useState(false);
  const manage = can("growth.manage");
  const rows = tiers.data ?? [];
  return (
    <>
      <PageHeader title="Loyalty & referrals" subtitle="Tiers follow the last 365 days of spend. Referral rewards are paid on a friend's first paid order." />
      <Tabs label="Loyalty sections" value={tab} onChange={setTab} options={[{ value: "tiers", label: "Tiers" }, { value: "referrals", label: "Referrals", hidden: !canView }]} />
      {tab === "tiers" ? (
        <>
          {manage && <div className="mb-3 flex justify-end"><Button variant="primary" onClick={() => setTierDialog("new")}><Icon name="plus" /> Add tier</Button></div>}
          {!tiers.loading && !tiers.error && rows.length === 0 ? (
            <EmptyState icon="star" title="No tiers yet" hint="Without tiers every guest earns points at the standard rate. Add a base tier at ₹0 and one or two above it." action={manage ? <Button variant="primary" onClick={() => setTierDialog("new")}>Add the first tier</Button> : undefined} />
          ) : (
            <DataTable label="Loyalty tiers" rows={rows} rowKey={(r) => r.id} loading={tiers.loading} error={tiers.error} onRetry={tiers.reload}
              columns={[
                { key: "n", header: "Tier", cell: (r) => <span className="font-medium text-ink-900">{r.name} <span className="ml-1 font-mono text-xs text-ink-500">{r.code}</span></span> },
                { key: "s", header: "Spend in 365 days", numeric: true, cell: (r) => (r.minSpend === 0 ? "Everyone" : `${formatMoney(r.minSpend)}+`) },
                { key: "m", header: "Points earned", numeric: true, cell: (r) => `${r.earnMultiplierPct}%` },
                { key: "p", header: "Perks", cell: (r) => r.perks ?? "—" },
                { key: "a", header: "Status", cell: (r) => <Badge tone={r.active ? "ok" : "neutral"}>{r.active ? "Active" : "Inactive"}</Badge> },
                { key: "e", header: "", cell: (r) => (manage ? <div className="flex justify-end"><Button size="sm" variant="ghost" onClick={() => setTierDialog(r)} aria-label={`Edit ${r.name}`}><Icon name="edit" /></Button></div> : null) },
              ]} />
          )}
        </>
      ) : (
        <>
          <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Waiting for a first order" value={summary.data ? summary.data.pending : "…"} />
            <Stat label="Rewarded" value={summary.data ? summary.data.rewarded : "…"} tone={summary.data?.rewarded ? "ok" : undefined} />
            <Stat label="Not rewarded" value={summary.data ? summary.data.rejected : "…"} />
            <Stat label="Points given" value={summary.data ? summary.data.pointsGiven : "…"} />
          </div>
          <Card className="mb-4" title="Rules" actions={manage && settings.data ? <Button size="sm" onClick={() => setRules(true)}>Change</Button> : undefined}>
            {settings.data ? (
              <p className="text-sm text-ink-700">
                {settings.data.referralEnabled ? <Badge tone="ok">On</Badge> : <Badge tone="neutral">Off</Badge>}{" "}
                The guest who refers gets <strong>{settings.data.referrerPoints}</strong> points, the friend gets <strong>{settings.data.refereePoints}</strong>, once the friend&apos;s first order of at least {formatMoney(settings.data.referralMinOrderValue)} is paid. At most {settings.data.referralMonthlyCap} rewards per guest each month.
                Each guest&apos;s code is on their <Link className="text-brand-600 underline underline-offset-2 hover:no-underline" href="/customers">profile</Link>.
              </p>
            ) : <p className="text-sm text-ink-500">Loading…</p>}
          </Card>
          <FilterBar><SelectFilter label="Status" value={status} onChange={setStatus} options={["PENDING", "REWARDED", "REJECTED"].map((s) => ({ value: s, label: humanize(s) }))} /></FilterBar>
          <DataTable label="Referrals" rows={referrals.data ?? []} rowKey={(r) => r.id} loading={referrals.loading} error={referrals.error} onRetry={referrals.reload} empty="No referrals yet"
            columns={[
              { key: "d", header: "Date", cell: (r) => formatDateTime(r.createdAt) },
              { key: "a", header: "Referred by", cell: (r) => <Link className="text-brand-600 hover:underline" href={`/customers/${r.referrer.id}`}>{r.referrer.name || "Guest"}</Link> },
              { key: "b", header: "Friend", cell: (r) => <Link className="text-brand-600 hover:underline" href={`/customers/${r.referred.id}`}>{r.referred.name || "Guest"}</Link> },
              { key: "s", header: "Status", cell: (r) => <Badge tone={REF_TONE[r.status] ?? "neutral"}>{humanize(r.status)}</Badge> },
              { key: "p", header: "Points", numeric: true, cell: (r) => (r.status === "REWARDED" ? `${r.referrerPoints ?? 0} + ${r.refereePoints ?? 0}` : "—") },
              { key: "n", header: "Note", cell: (r) => r.rejectReason ?? "—" },
            ]} />
        </>
      )}
      {tierDialog && <TierDialog tier={tierDialog === "new" ? undefined : tierDialog} onClose={() => setTierDialog(null)} onDone={tiers.reload} />}
      {rules && settings.data && <ReferralRulesDialog settings={settings.data} onClose={() => setRules(false)} onDone={() => { settings.reload(); summary.reload(); }} />}
    </>
  );
}
