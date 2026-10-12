"use client";

/**
 * Aggregator control room (proposal p. 9 and p. 17): what Zomato / Swiggy
 * actually paid against what RESTORA expected, penalties and ad spend as real
 * costs, and what each platform and each dish really earns. No partner API is
 * connected, so the payout statement is imported by a person (pasted CSV); the
 * server validates it again, never edits it, and the same statement sent twice
 * imports once. Figures come from the server (Decimal); nothing is estimated here.
 */
import { useState } from "react";
import { api } from "@/lib/api/client";
import { createKeyedSubmitter } from "@/lib/idempotency";
import { useQuery } from "@/lib/hooks/useApi";
import { useOutletId, useShell } from "@/lib/shellContext";
import { parseStatementCsv } from "@/lib/statementCsv";
import { formatDate, formatMoney, humanize, isoDay } from "@/lib/format";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { Card, PageHeader, Stat, Tabs } from "@/components/ui/Page";
import { DataTable } from "@/components/ui/Table";
import { ActionButton } from "@/components/ui/Confirm";
import { Field, FormAlert, FormDialog, Input, Select, Textarea, formError, opt } from "@/components/ui/Form";
import { ErrorState, LoadingState } from "@/components/ui/States";
import { useToast } from "@/components/ui/Toast";

type Platform = { id: string; name: string; commissionPct: number; active: boolean };
type StatementRow = { aggregatorId: string; aggregator: string; statementRef: string; lines: number; gross: number; commission: number; penalty: number; adSpend: number; otherDeductions: number; netPayout: number; lastSettledAt: string | null };
type CheckRow = { externalId: string; verdict: string; reasons: string[]; expectedNet: number | null; paidNet: number; difference: number | null; commissionDifference: number | null; penalty: number; adSpend: number; otherDeductions: number; paidInStatements: string[] };
type Check = { aggregator: string; statementRef: string; anomalyRaised?: boolean; summary: { lines: number; counts: Record<string, number>; expectedNet: number; paidNet: number; shortfall: number; shortfallFromCommission: number; overpaid: number; penalties: number; adSpend: number; paidForUnknownOrders: number }; rows: CheckRow[] };
type Outstanding = { aggregator: string; graceDays: number; count: number; owed: number; orders: Array<{ externalId: string; placedAt: string; expectedNet: number }> };
type Charge = { id: string; aggregatorId: string; kind: string; amount: number; chargedOn: string; reference: string | null; notes: string | null; voided: boolean; voidReason: string | null };
type Margin = {
  aggregators: Array<{ aggregatorId: string; aggregator: string; commissionPct: number; orders: number; cancelled: number; grossSales: number; discounts: number; commission: number; platformFees: number; effectiveCutPct: number | null; expectedNet: number; charges: { penalty: number; adSpend: number; fee: number; other: number; total: number }; netAfterCharges: number; foodCost: number | null; costCoveragePct: number | null; contribution: number | null; contributionPct: number | null }>;
  dishes: Array<{ aggregatorId: string; aggregator: string; name: string; qty: number; revenue: number; platformCut: number; foodCost: number | null; margin: number | null; marginPct: number | null }>;
  basis: string;
};

const VERDICT_TONE: Record<string, "ok" | "bad" | "warn" | "neutral"> = { MATCHED: "ok", SHORT_PAID: "bad", OVER_PAID: "warn", UNKNOWN_ORDER: "bad", DUPLICATE_PAYMENT: "bad", WRONG_OUTLET: "warn" };
const REASON_LABEL: Record<string, string> = { COMMISSION_DIFFERS: "Commission differs", PENALTY: "Penalty", AD_SPEND: "Ad spend", OTHER_DEDUCTION: "Other deduction", GROSS_DIFFERS: "Gross differs", ORDER_CANCELLED_HERE: "Cancelled here" };
const EXAMPLE = "order_id,settled_at,gross,commission,penalty,ad_spend,other_deductions,net_paid\nZ-1001,2026-10-07,500.00,115.00,0,0,0,385.00";

function PlatformSelect({ platforms, value, onChange, name }: { platforms: Platform[]; value: string; onChange: (v: string) => void; name: string }) {
  return <Select name={name} value={value} onChange={(e) => onChange(e.target.value)}><option value="">Choose…</option>{platforms.map((p) => <option key={p.id} value={p.id}>{humanize(p.name)}</option>)}</Select>;
}

function ImportDialog({ open, onClose, onDone, platforms, outletId }: { open: boolean; onClose: () => void; onDone: () => void; platforms: Platform[]; outletId: string }) {
  const [aggregatorId, setAggregatorId] = useState(platforms[0]?.id ?? "");
  const [statementRef, setStatementRef] = useState("");
  const [csv, setCsv] = useState("");
  const [problems, setProblems] = useState<string[]>([]);
  return (
    <FormDialog open={open} onClose={onClose} title="Import payout statement" size="lg" submitLabel="Import"
      description="Paste the platform's payout statement as CSV. Each line must add up (gross less deductions = net paid). A statement is never edited; the same lines sent twice import once."
      onSubmit={async () => {
        const parsed = parseStatementCsv(csv);
        setProblems(parsed.errors);
        if (parsed.errors.length) throw new Error(`${parsed.errors.length} problem(s) in the statement; fix them and import again.`);
        return api<{ imported: number; alreadyImported: number }>("/api/finance/aggregators/statements", { method: "POST", body: { outletId, aggregatorId, statementRef: statementRef.trim(), lines: parsed.lines } });
      }}
      onDone={onDone}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Platform" name="aggregatorId" required><PlatformSelect platforms={platforms} value={aggregatorId} onChange={setAggregatorId} name="aggregatorId" /></Field>
        <Field label="Statement reference" name="statementRef" required hint="The payout / statement number printed on it"><Input value={statementRef} onChange={(e) => setStatementRef(e.target.value)} maxLength={60} required /></Field>
      </div>
      <Field label="Statement lines (CSV)" name="csv" required hint="Header row, then one row per order. penalty, ad_spend and other_deductions may be left out."><Textarea rows={8} value={csv} onChange={(e) => setCsv(e.target.value)} placeholder={EXAMPLE} spellCheck={false} className="font-mono text-xs" /></Field>
      {problems.length > 0 && <ul className="max-h-32 overflow-auto rounded-md border border-bad-200 bg-bad-50 p-2 text-xs text-bad-700" role="alert">{problems.slice(0, 20).map((p) => <li key={p}>{p}</li>)}{problems.length > 20 && <li>…and {problems.length - 20} more</li>}</ul>}
    </FormDialog>
  );
}

function CheckPanel({ check, reload, canReview, outletId, aggregatorId }: { check: Check; reload: () => void; canReview: boolean; outletId: string; aggregatorId: string }) {
  const s = check.summary;
  return (
    <Card title={`${humanize(check.aggregator)} · statement ${check.statementRef}`} actions={canReview ? <ActionButton size="sm" action={() => api("/api/finance/aggregators/review", { method: "POST", body: { outletId, aggregatorId, statementRef: check.statementRef } })} success="Reviewed; a discrepancy was flagged if money is missing" onDone={reload}>Review and flag</ActionButton> : undefined}>
      <div className="mb-3 grid gap-3 sm:grid-cols-4" data-testid="statement-summary">
        <Stat label="Expected (known orders)" value={formatMoney(s.expectedNet)} />
        <Stat label="Paid" value={formatMoney(s.paidNet)} />
        <Stat label="Shortfall" value={formatMoney(s.shortfall)} tone={s.shortfall > 0 ? "bad" : "ok"} hint={s.shortfall > 0 ? `${formatMoney(s.shortfallFromCommission)} of it is commission` : undefined} />
        <Stat label="Paid more than expected" value={formatMoney(s.overpaid)} tone={s.overpaid > 0 ? "bad" : undefined} hint={s.paidForUnknownOrders > 0 ? `plus ${formatMoney(s.paidForUnknownOrders)} for orders we never received` : undefined} />
      </div>
      <p className="mb-2 flex flex-wrap gap-2 text-xs">{Object.entries(s.counts).filter(([, n]) => n > 0).map(([k, n]) => <Badge key={k} tone={VERDICT_TONE[k] ?? "neutral"}>{humanize(k)} {n}</Badge>)}</p>
      <DataTable label="Statement lines against orders" rows={check.rows} rowKey={(r) => r.externalId} empty="No lines"
        columns={[
          { key: "o", header: "Order", cell: (r) => r.externalId },
          { key: "v", header: "Verdict", cell: (r) => <Badge tone={VERDICT_TONE[r.verdict] ?? "neutral"}>{humanize(r.verdict)}</Badge> },
          { key: "e", header: "Expected", numeric: true, cell: (r) => (r.expectedNet === null ? "—" : formatMoney(r.expectedNet)) },
          { key: "p", header: "Paid", numeric: true, cell: (r) => formatMoney(r.paidNet) },
          { key: "d", header: "Difference", numeric: true, cell: (r) => (r.difference === null ? "—" : formatMoney(r.difference)) },
          { key: "w", header: "Why", cell: (r) => <span className="text-xs">{r.reasons.map((x) => REASON_LABEL[x] ?? humanize(x)).join(", ")}{r.paidInStatements.length ? ` · also paid in ${r.paidInStatements.join(", ")}` : ""}</span> },
        ]} />
      {check.anomalyRaised && <p className="mt-2 text-sm text-ink-600">A discrepancy was raised for this statement.</p>}
    </Card>
  );
}

function StatementsTab({ outletId, platforms, canWrite }: { outletId: string; platforms: Platform[]; canWrite: boolean }) {
  const toast = useToast();
  const list = useQuery<StatementRow[]>("/api/finance/aggregators/statements", { outletId });
  const [importing, setImporting] = useState(false);
  const [open, setOpen] = useState<{ aggregatorId: string; ref: string } | null>(null);
  const check = useQuery<Check>(open ? "/api/finance/aggregators/reconcile" : null, open ? { outletId, aggregatorId: open.aggregatorId, statementRef: open.ref } : undefined);
  return (
    <div className="space-y-4">
      <div className="flex justify-end">{canWrite && <Button variant="primary" disabled={!platforms.length} onClick={() => setImporting(true)}><Icon name="plus" /> Import statement</Button>}</div>
      <DataTable label="Payout statements" rows={list.data ?? []} rowKey={(r) => `${r.aggregatorId}:${r.statementRef}`} loading={list.loading} error={list.error} onRetry={list.reload} empty="No payout statement imported yet"
        columns={[
          { key: "a", header: "Platform", cell: (r) => humanize(r.aggregator) },
          { key: "r", header: "Statement", cell: (r) => r.statementRef },
          { key: "l", header: "Lines", numeric: true, cell: (r) => r.lines },
          { key: "g", header: "Gross", numeric: true, cell: (r) => formatMoney(r.gross) },
          { key: "c", header: "Commission", numeric: true, cell: (r) => formatMoney(r.commission) },
          { key: "x", header: "Penalty + ads + other", numeric: true, cell: (r) => formatMoney(r.penalty + r.adSpend + r.otherDeductions) },
          { key: "n", header: "Paid", numeric: true, cell: (r) => formatMoney(r.netPayout) },
          { key: "s", header: "Settled", cell: (r) => formatDate(r.lastSettledAt) },
          { key: "k", header: "", cell: (r) => <Button size="sm" onClick={() => setOpen({ aggregatorId: r.aggregatorId, ref: r.statementRef })}>Check</Button> },
        ]} />
      {open && (check.error ? <ErrorState error={check.error} onRetry={check.reload} /> : !check.data ? <LoadingState /> : <CheckPanel check={check.data} reload={check.reload} canReview={canWrite} outletId={outletId} aggregatorId={open.aggregatorId} />)}
      {importing && <ImportDialog open platforms={platforms} outletId={outletId} onClose={() => setImporting(false)} onDone={() => { setImporting(false); toast.show("Statement imported", "ok"); list.reload(); }} />}
    </div>
  );
}

function OutstandingTab({ outletId, platforms }: { outletId: string; platforms: Platform[] }) {
  const [aggregatorId, setAggregatorId] = useState("");
  const [graceDays, setGraceDays] = useState("7");
  const q = useQuery<Outstanding>(aggregatorId ? "/api/finance/aggregators/outstanding" : null, { outletId, aggregatorId, graceDays });
  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Platform" name="out-platform"><PlatformSelect platforms={platforms} value={aggregatorId} onChange={setAggregatorId} name="out-platform" /></Field>
        <Field label="Grace period (days)" name="grace" hint="Orders newer than this are not yet due"><Input type="number" min={0} max={60} value={graceDays} onChange={(e) => setGraceDays(e.target.value)} /></Field>
      </div>
      {!aggregatorId ? <p className="text-sm text-ink-500">Choose a platform to see the orders no statement has paid yet.</p> : q.error ? <ErrorState error={q.error} onRetry={q.reload} /> : !q.data ? <LoadingState /> : (
        <>
          <div className="grid gap-3 sm:grid-cols-2"><Stat label="Orders not yet paid" value={q.data.count} /><Stat label="Owed to you" value={formatMoney(q.data.owed)} tone={q.data.owed > 0 ? "bad" : "ok"} /></div>
          <DataTable label="Unpaid orders" rows={q.data.orders} rowKey={(o) => o.externalId} empty="Every order older than the grace period appears in a statement"
            columns={[{ key: "o", header: "Order", cell: (o) => o.externalId }, { key: "d", header: "Placed", cell: (o) => formatDate(o.placedAt) }, { key: "e", header: "Expected net", numeric: true, cell: (o) => formatMoney(o.expectedNet) }]} />
        </>
      )}
    </div>
  );
}

function ChargeDialog({ open, onClose, onDone, platforms, outletId }: { open: boolean; onClose: () => void; onDone: () => void; platforms: Platform[]; outletId: string }) {
  const { outlet } = useShell();
  const [submitKeyed] = useState(() => createKeyedSubmitter("agc"));
  const [aggregatorId, setAggregatorId] = useState(platforms[0]?.id ?? "");
  const [kind, setKind] = useState("AD_SPEND");
  const [amount, setAmount] = useState("");
  const [chargedOn, setChargedOn] = useState(isoDay(new Date(), outlet?.timezone));
  const [reference, setReference] = useState("");
  const [notes, setNotes] = useState("");
  return (
    <FormDialog open={open} onClose={onClose} title="Record a platform charge" submitLabel="Record"
      description="Penalties, ad campaigns and monthly fees are real costs outside any order. A wrong entry is voided with a reason, never deleted."
      onSubmit={() => {
        const body = { outletId, aggregatorId, kind, amount: Number(amount), chargedOn: `${chargedOn}T12:00:00.000Z`, reference: opt(reference), notes: opt(notes) };
        return submitKeyed(body, (key) => api("/api/finance/aggregators/charges", { method: "POST", body, idempotencyKey: key }));
      }}
      onDone={onDone}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Platform" name="aggregatorId" required><PlatformSelect platforms={platforms} value={aggregatorId} onChange={setAggregatorId} name="aggregatorId" /></Field>
        <Field label="Kind" name="kind"><Select value={kind} onChange={(e) => setKind(e.target.value)}><option value="AD_SPEND">Ad spend</option><option value="PENALTY">Penalty</option><option value="FEE">Fee</option><option value="OTHER">Other</option></Select></Field>
        <Field label="Amount (₹)" name="amount" required><Input type="number" inputMode="decimal" min="0.01" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} required /></Field>
        <Field label="Charged on" name="chargedOn" required><Input type="date" value={chargedOn} onChange={(e) => setChargedOn(e.target.value)} required /></Field>
        <Field label="Reference" name="reference"><Input value={reference} onChange={(e) => setReference(e.target.value)} maxLength={80} /></Field>
        <Field label="Notes" name="notes"><Input value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={300} /></Field>
      </div>
    </FormDialog>
  );
}

function VoidChargeDialog({ charge, onClose, onDone }: { charge: Charge; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState("");
  return (
    <FormDialog open onClose={onClose} title="Void this charge" submitLabel="Void charge" danger description="The charge stays on record, marked void with your reason. Voiding asks for your password."
      onSubmit={() => api(`/api/finance/aggregators/charges/${charge.id}/void`, { method: "POST", body: { reason: reason.trim() } })} onDone={onDone}>
      <Field label="Reason" name="reason" required><Input value={reason} onChange={(e) => setReason(e.target.value)} minLength={3} maxLength={300} required /></Field>
    </FormDialog>
  );
}

function ChargesTab({ outletId, platforms, canWrite }: { outletId: string; platforms: Platform[]; canWrite: boolean }) {
  const q = useQuery<Charge[]>("/api/finance/aggregators/charges", { outletId, includeVoided: "true" });
  const [adding, setAdding] = useState(false);
  const [voiding, setVoiding] = useState<Charge | null>(null);
  const name = (id: string) => humanize(platforms.find((p) => p.id === id)?.name ?? "Platform");
  return (
    <div className="space-y-3">
      <div className="flex justify-end">{canWrite && <Button variant="primary" disabled={!platforms.length} onClick={() => setAdding(true)}><Icon name="plus" /> Record charge</Button>}</div>
      <DataTable label="Platform charges" rows={q.data ?? []} rowKey={(c) => c.id} loading={q.loading} error={q.error} onRetry={q.reload} empty="No charges recorded"
        columns={[
          { key: "d", header: "Date", cell: (c) => formatDate(c.chargedOn) },
          { key: "p", header: "Platform", cell: (c) => name(c.aggregatorId) },
          { key: "k", header: "Kind", cell: (c) => humanize(c.kind) },
          { key: "a", header: "Amount", numeric: true, cell: (c) => <span className={c.voided ? "text-ink-500 line-through" : ""}>{formatMoney(c.amount)}</span> },
          { key: "r", header: "Reference", cell: (c) => <span className="text-xs">{c.reference ?? ""}{c.voided ? ` · void: ${c.voidReason ?? ""}` : ""}</span> },
          { key: "v", header: "", cell: (c) => (canWrite && !c.voided ? <Button size="sm" onClick={() => setVoiding(c)}>Void</Button> : c.voided ? <Badge tone="neutral">Void</Badge> : null) },
        ]} />
      {adding && <ChargeDialog open platforms={platforms} outletId={outletId} onClose={() => setAdding(false)} onDone={() => { setAdding(false); q.reload(); }} />}
      {voiding && <VoidChargeDialog charge={voiding} onClose={() => setVoiding(null)} onDone={() => { setVoiding(null); q.reload(); }} />}
    </div>
  );
}

function MarginTab({ outletId }: { outletId: string }) {
  const { outlet } = useShell();
  const today = isoDay(new Date(), outlet?.timezone);
  const [from, setFrom] = useState(today.slice(0, 8) + "01");
  const [to, setTo] = useState(today);
  const q = useQuery<Margin>(from && to && from <= to ? "/api/finance/aggregators/margin" : null, { outletId, from: `${from}T00:00:00.000Z`, to: `${to}T23:59:59.999Z` });
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-4"><Field label="From" name="m-from"><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field><Field label="To" name="m-to"><Input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field></div>
      {from > to ? <FormAlert message="The start date is after the end date." /> : q.error ? <ErrorState error={q.error} onRetry={q.reload} /> : !q.data ? <LoadingState /> : (
        <>
          <DataTable label="Margin per platform" rows={q.data.aggregators} rowKey={(a) => a.aggregatorId} empty="No platform orders in this period"
            columns={[
              { key: "a", header: "Platform", cell: (a) => humanize(a.aggregator) },
              { key: "o", header: "Orders", numeric: true, cell: (a) => <span>{a.orders}{a.cancelled ? <span className="block text-xs text-ink-500">{a.cancelled} cancelled</span> : null}</span> },
              { key: "g", header: "Gross", numeric: true, cell: (a) => formatMoney(a.grossSales) },
              { key: "c", header: "Commission + fees", numeric: true, cell: (a) => <span>{formatMoney(a.commission + a.platformFees)}{a.effectiveCutPct !== null && <span className="block text-xs text-ink-500">{a.effectiveCutPct}% of sales</span>}</span> },
              { key: "ch", header: "Charges", numeric: true, cell: (a) => formatMoney(a.charges.total) },
              { key: "f", header: "Food cost", numeric: true, cell: (a) => (a.foodCost === null ? <Badge tone="warn">{a.costCoveragePct === null ? "No cost" : `${a.costCoveragePct}% costed`}</Badge> : formatMoney(a.foodCost)) },
              { key: "m", header: "Contribution", numeric: true, cell: (a) => (a.contribution === null ? "—" : <span>{formatMoney(a.contribution)}<span className="block text-xs text-ink-500">{a.contributionPct}% of gross</span></span>) },
            ]} />
          <DataTable label="Margin per dish" rows={q.data.dishes} rowKey={(d) => `${d.aggregatorId}:${d.name}`} empty="No dishes sold through platforms in this period"
            columns={[
              { key: "n", header: "Dish", cell: (d) => d.name },
              { key: "a", header: "Platform", cell: (d) => humanize(d.aggregator) },
              { key: "q", header: "Sold", numeric: true, cell: (d) => d.qty },
              { key: "r", header: "Revenue", numeric: true, cell: (d) => formatMoney(d.revenue) },
              { key: "p", header: "Platform cut", numeric: true, cell: (d) => formatMoney(d.platformCut) },
              { key: "f", header: "Food cost", numeric: true, cell: (d) => (d.foodCost === null ? <Badge tone="warn">No cost</Badge> : formatMoney(d.foodCost)) },
              { key: "m", header: "Margin", numeric: true, cell: (d) => (d.margin === null ? "—" : <span>{formatMoney(d.margin)}<span className="block text-xs text-ink-500">{d.marginPct}%</span></span>) },
            ]} />
          <p className="text-xs text-ink-500">{q.data.basis}</p>
        </>
      )}
    </div>
  );
}

function PlatformDialog({ initial, onClose, onDone }: { initial?: Platform; onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState(initial?.name ?? "");
  const [pct, setPct] = useState(String(initial?.commissionPct ?? 22));
  const [active, setActive] = useState(initial?.active ?? true);
  return (
    <FormDialog open onClose={onClose} title={initial ? `Edit ${humanize(initial.name)}` : "Add a platform"} submitLabel="Save"
      description="A new commission % applies to orders received after the change; orders already stored keep theirs. Saving asks for your password."
      onSubmit={() => api("/api/finance/aggregators", { method: "POST", body: { name: name.trim(), commissionPct: Number(pct), active } })} onDone={onDone}>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Name" name="name" required><Input value={name} onChange={(e) => setName(e.target.value)} disabled={Boolean(initial)} placeholder="ZOMATO" required /></Field>
        <Field label="Commission %" name="commissionPct" required><Input type="number" inputMode="decimal" min="0" max="60" step="0.01" value={pct} onChange={(e) => setPct(e.target.value)} required /></Field>
        <Field label="Status" name="active"><Select value={active ? "1" : "0"} onChange={(e) => setActive(e.target.value === "1")}><option value="1">Active</option><option value="0">Inactive</option></Select></Field>
      </div>
    </FormDialog>
  );
}

function PlatformsTab({ platforms, reload, canManage }: { platforms: Platform[]; reload: () => void; canManage: boolean }) {
  const [editing, setEditing] = useState<Platform | "new" | null>(null);
  return (
    <div className="space-y-3">
      <div className="flex justify-end">{canManage && <Button variant="primary" onClick={() => setEditing("new")}><Icon name="plus" /> Add platform</Button>}</div>
      <DataTable label="Platforms" rows={platforms} rowKey={(p) => p.id} empty="No platform yet: add Zomato or Swiggy to start receiving their orders and statements"
        columns={[
          { key: "n", header: "Platform", cell: (p) => humanize(p.name) },
          { key: "c", header: "Commission", numeric: true, cell: (p) => `${p.commissionPct}%` },
          { key: "s", header: "Status", cell: (p) => <Badge tone={p.active ? "ok" : "neutral"}>{p.active ? "Active" : "Inactive"}</Badge> },
          { key: "e", header: "", cell: (p) => (canManage ? <Button size="sm" onClick={() => setEditing(p)}>Edit</Button> : null) },
        ]} />
      {editing && <PlatformDialog initial={editing === "new" ? undefined : editing} onClose={() => setEditing(null)} onDone={() => { setEditing(null); reload(); }} />}
    </div>
  );
}

export function AggregatorsScreen() {
  const outletId = useOutletId();
  const { can } = useShell();
  const [tab, setTab] = useState<"statements" | "outstanding" | "charges" | "margin" | "platforms">("statements");
  const platforms = useQuery<Platform[]>("/api/finance/aggregators");
  if (platforms.error) return <><PageHeader title="Aggregators" /><ErrorState error={platforms.error} onRetry={platforms.reload} /></>;
  if (!platforms.data) return <LoadingState />;
  const canWrite = can("finance.reconcile");
  return (
    <>
      <PageHeader title="Aggregators" subtitle="What Zomato and Swiggy paid against what they should have, their charges, and what each platform and dish really earns" />
      <Tabs label="Aggregator sections" value={tab} onChange={setTab} options={[{ value: "statements", label: "Payout statements" }, { value: "outstanding", label: "Not yet paid" }, { value: "charges", label: "Charges" }, { value: "margin", label: "Net margin", hidden: !can("reports.view") }, { value: "platforms", label: "Platforms" }]} />
      {tab === "statements" && <StatementsTab outletId={outletId} platforms={platforms.data} canWrite={canWrite} />}
      {tab === "outstanding" && <OutstandingTab outletId={outletId} platforms={platforms.data} />}
      {tab === "charges" && <ChargesTab outletId={outletId} platforms={platforms.data} canWrite={canWrite} />}
      {tab === "margin" && <MarginTab outletId={outletId} />}
      {tab === "platforms" && <PlatformsTab platforms={platforms.data} reload={platforms.reload} canManage={can("integration.manage")} />}
    </>
  );
}
