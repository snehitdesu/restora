"use client";

/**
 * Kitchen production screens (proposal module 05) and the consumption
 * variance report (modules 01 / 08):
 *  - Dish worksheet: prepared (entered), sold (orders), wasted (posted dish
 *    wastage), the unexplained gap, and the costs of both for logins that may
 *    see costs. "Add wasted" posts a dish-wastage document; "Log dish sales"
 *    is the manual sales log.
 *  - Variance: expected vs actual usage per material, and the leakage summary.
 * Every figure is computed by the server; the screens only send what people
 * enter. Kitchen logins get quantities only (the server leaves costs out).
 */
import { useMemo, useState } from "react";
import { api } from "@/lib/api/client";
import { createKeyedSubmitter } from "@/lib/idempotency";
import { useQuery } from "@/lib/hooks/useApi";
import { useShell, useOutletId } from "@/lib/shellContext";
import { formatDate, formatMoney, formatPct, formatQty, humanize, isoDay } from "@/lib/format";
import { WastageReason } from "@/constants/enums";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { Badge } from "@/components/ui/Badge";
import { Field, FormDialog, Input, Select, Textarea, opt } from "@/components/ui/Form";
import { DataTable, type Column } from "@/components/ui/Table";
import { Card, PageHeader, Stat, SubNav } from "@/components/ui/Page";
import { ErrorState, LoadingState } from "@/components/ui/States";
import { DateRangeFilter, FilterBar, SelectFilter, type DateRange } from "@/components/ui/Filters";
import { useToast } from "@/components/ui/Toast";
import { useDepartments } from "@/features/backoffice/lookups";

type WorksheetRow = {
  menuItemId: string; name: string; departmentId: string | null; department: string | null;
  prepared: number | null; sold: number; wasted: number; wastedPending: number; variance: number | null;
  plateCost?: number | null; wastageCost?: number | null; varianceCost?: number | null; notes: string | null; updatedAt: string | null;
};
type Worksheet = { outletId: string; businessDate: string; showCost: boolean; rows: WorksheetRow[]; totals: { prepared: number; sold: number; wasted: number; unexplained: number; wastageCost?: number; varianceCost?: number } };
type MenuItemRow = { id: string; name: string; active: boolean; station: string };

export function ProductionNav() {
  return (
    <SubNav label="Production" items={[
      { href: "/inventory/worksheet", label: "Dish worksheet" },
      { href: "/inventory/production", label: "Sub-recipe batches" },
    ]} />
  );
}

function useToday() {
  const { outlet } = useShell();
  return isoDay(new Date(), outlet?.timezone);
}

// ============================================================
// Dish worksheet
// ============================================================

function WastedDialog({ row, day, onClose, onDone }: { row: WorksheetRow; day: string; onClose: () => void; onDone: () => void }) {
  const outletId = useOutletId();
  const [submitKeyed] = useState(() => createKeyedSubmitter("wsw"));
  const [qty, setQty] = useState("");
  const [reason, setReason] = useState("OVERPRODUCTION");
  const [notes, setNotes] = useState("");
  const toast = useToast();
  return (
    <FormDialog open onClose={onClose} title={`Wasted ${row.name}`} submitLabel="Record wasted portions"
      description="Takes the dish's ingredients out of stock now, at its plate cost. Large amounts wait for a manager's approval."
      onSubmit={() => {
        const body = { outletId, businessDate: day, menuItemId: row.menuItemId, qty: Number(qty), reason, notes: opt(notes) };
        return submitKeyed(body, (idempotencyKey) => api<{ posted: boolean; awaitingApproval: boolean }>("/api/inventory/worksheet/wastage", { method: "POST", body, idempotencyKey }));
      }}
      onDone={(r) => { toast.show(r.awaitingApproval ? "Saved: waiting for a manager to approve" : "Wastage recorded", r.awaitingApproval ? "info" : "ok"); onDone(); }}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Portions wasted" name="qty" required><Input type="number" inputMode="decimal" min="0" step="any" required value={qty} onChange={(e) => setQty(e.target.value)} autoFocus /></Field>
        <Field label="Reason" name="reason" required><Select value={reason} onChange={(e) => setReason(e.target.value)}>{WastageReason.values.map((r) => <option key={r} value={r}>{humanize(r)}</option>)}</Select></Field>
      </div>
      <Field label="Notes" name="notes"><Textarea value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={300} /></Field>
    </FormDialog>
  );
}

export function ManualSalesDialog({ day, items, onClose, onDone }: { day: string; items: MenuItemRow[]; onClose: () => void; onDone: () => void }) {
  const outletId = useOutletId();
  const [submitKeyed] = useState(() => createKeyedSubmitter("msl"));
  const [lines, setLines] = useState<Array<{ menuItemId: string; qty: string }>>([{ menuItemId: "", qty: "" }]);
  const [notes, setNotes] = useState("");
  const toast = useToast();
  const set = (i: number, patch: Partial<{ menuItemId: string; qty: string }>) => setLines(lines.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  return (
    <FormDialog open onClose={onClose} size="lg" title="Log dish sales" submitLabel="Record sales"
      description="For dishes sold outside the POS. Priced at today's menu price and dated to the business day; stock is taken out exactly like a POS bill."
      onSubmit={() => {
        const body = { outletId, businessDate: day, notes: opt(notes), lines: lines.filter((l) => l.menuItemId).map((l) => ({ menuItemId: l.menuItemId, qty: Number(l.qty) })) };
        return submitKeyed(body, (idempotencyKey) => api("/api/inventory/manual-sales", { method: "POST", body, idempotencyKey }));
      }}
      onDone={() => { toast.show("Sales recorded", "ok"); onDone(); }}>
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm font-medium text-ink-700">Dishes sold on {day}</legend>
        {lines.map((l, i) => (
          <div key={i} className="grid grid-cols-12 items-center gap-2">
            <Select className="col-span-7" aria-label={`Dish ${i + 1}`} value={l.menuItemId} onChange={(e) => set(i, { menuItemId: e.target.value })} required={i === 0}>
              <option value="">Select dish…</option>
              {items.filter((m) => m.active).map((m) => <option key={m.id} value={m.id} disabled={lines.some((x, j) => j !== i && x.menuItemId === m.id)}>{m.name}</option>)}
            </Select>
            <Input className="col-span-3" aria-label={`Quantity ${i + 1}`} type="number" inputMode="decimal" min="0" step="any" value={l.qty} onChange={(e) => set(i, { qty: e.target.value })} required={Boolean(l.menuItemId)} />
            <Button className="col-span-2" size="sm" variant="ghost" onClick={() => setLines(lines.length > 1 ? lines.filter((_, j) => j !== i) : [{ menuItemId: "", qty: "" }])} aria-label={`Remove line ${i + 1}`}><Icon name="x" /></Button>
          </div>
        ))}
        <div><Button size="sm" onClick={() => setLines([...lines, { menuItemId: "", qty: "" }])}><Icon name="plus" /> Add dish</Button></div>
      </fieldset>
      <Field label="Notes" name="notes"><Textarea value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={500} /></Field>
    </FormDialog>
  );
}

/** Prepared portions: typed, saved on Enter or with the button. */
function PreparedCell({ row, day, canEdit, onSaved }: { row: WorksheetRow; day: string; canEdit: boolean; onSaved: () => void }) {
  const outletId = useOutletId();
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const value = draft ?? (row.prepared === null ? "" : String(row.prepared));
  if (!canEdit) return <span>{row.prepared === null ? "—" : formatQty(row.prepared)}</span>;
  const dirty = draft !== null && draft !== (row.prepared === null ? "" : String(row.prepared));
  const save = async () => {
    if (!dirty || busy || draft === null || draft.trim() === "") return;
    setBusy(true);
    try {
      await api("/api/inventory/worksheet", { method: "POST", body: { outletId, businessDate: day, menuItemId: row.menuItemId, preparedQty: Number(draft) } });
      setDraft(null);
      onSaved();
    } catch (e) {
      toast.show(e instanceof Error ? e.message : "Could not save", "bad");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex items-center justify-end gap-1">
      <div className="w-20">
        <Input className="text-right" type="number" inputMode="decimal" min="0" step="any" aria-label={`Prepared ${row.name}`} value={value}
          onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void save(); } }} />
      </div>
      {dirty && <Button size="sm" variant="primary" loading={busy} onClick={save} aria-label={`Save prepared ${row.name}`}><Icon name="check" /></Button>}
    </div>
  );
}

export function WorksheetScreen() {
  const { can, outletId } = useShell();
  const today = useToday();
  const [day, setDay] = useState(today);
  const [dept, setDept] = useState("");
  const [extra, setExtra] = useState<string[]>([]);
  const [wasting, setWasting] = useState<WorksheetRow | null>(null);
  const [selling, setSelling] = useState(false);
  const sheet = useQuery<Worksheet>(outletId ? "/api/inventory/worksheet" : null, { outletId: outletId ?? undefined, businessDate: day, departmentId: dept || undefined });
  const menu = useQuery<MenuItemRow[]>(can("menu.view") ? "/api/menu" : null, { activeOnly: "true" });
  const depts = useDepartments(outletId);
  const canPrepare = can("inventory.produce");
  const canWaste = can("inventory.wastage");
  const canSell = can("order.create") || can("inventory.produce");
  const future = day > today;
  const showCost = Boolean(sheet.data?.showCost);

  // Dishes added on screen before anything was recorded for them.
  const rows = useMemo(() => {
    const listed = sheet.data?.rows ?? [];
    const added = extra.filter((id) => !listed.some((r) => r.menuItemId === id)).map((id): WorksheetRow => {
      const m = menu.data?.find((x) => x.id === id);
      return { menuItemId: id, name: m?.name ?? id, departmentId: null, department: null, prepared: null, sold: 0, wasted: 0, wastedPending: 0, variance: null, notes: null, updatedAt: null };
    });
    return [...listed, ...added];
  }, [sheet.data, extra, menu.data]);
  const addable = (menu.data ?? []).filter((m) => !rows.some((r) => r.menuItemId === m.id));

  const columns: Column<WorksheetRow>[] = [
    { key: "dish", header: "Dish", cell: (r) => <div><p className="font-medium text-ink-900">{r.name}</p>{r.department && <p className="text-xs text-ink-500">{r.department}</p>}</div> },
    { key: "prep", header: "Prepared", numeric: true, cell: (r) => <PreparedCell row={r} day={day} canEdit={canPrepare && !future} onSaved={sheet.reload} /> },
    { key: "sold", header: "Sold", numeric: true, cell: (r) => formatQty(r.sold) },
    {
      key: "waste", header: "Wasted", numeric: true,
      cell: (r) => (
        <div className="flex items-center justify-end gap-2 whitespace-nowrap">
          <span>{formatQty(r.wasted)}</span>
          {r.wastedPending > 0 && <Badge tone="warn">+{formatQty(r.wastedPending)} awaiting approval</Badge>}
          {canWaste && !future && <Button size="sm" variant="ghost" onClick={() => setWasting(r)} aria-label={`Add wasted ${r.name}`}><Icon name="plus" /></Button>}
        </div>
      ),
    },
    {
      key: "var", header: "Unexplained", numeric: true,
      cell: (r) => (r.variance === null ? <span className="text-ink-400" title="Enter the prepared portions">—</span>
        : <span className={r.variance > 0 ? "font-semibold text-bad-600" : r.variance < 0 ? "text-warn-700" : "text-ok-600"}>{formatQty(r.variance)}</span>),
    },
  ];
  if (showCost) {
    columns.push(
      { key: "plate", header: "Plate cost", numeric: true, cell: (r) => (r.plateCost === null || r.plateCost === undefined ? "No recipe" : formatMoney(r.plateCost)) },
      { key: "wc", header: "Wastage ₹", numeric: true, cell: (r) => formatMoney(r.wastageCost ?? 0) },
      { key: "vc", header: "Unexplained ₹", numeric: true, cell: (r) => (r.varianceCost === null || r.varianceCost === undefined ? "—" : formatMoney(r.varianceCost)) },
    );
  }

  return (
    <>
      <PageHeader title="Dish production" subtitle="What the kitchen prepared, sold and threw away, per dish per day"
        actions={canSell && !future && <Button onClick={() => setSelling(true)} disabled={!menu.data}><Icon name="receipt" /> Log dish sales</Button>} />
      <ProductionNav />
      <FilterBar>
        <label className="flex flex-col gap-0.5 text-xs text-ink-500">
          <span>Business date</span>
          <Input type="date" value={day} max={today} onChange={(e) => e.target.value && setDay(e.target.value)} />
        </label>
        <SelectFilter label="Department" value={dept} onChange={setDept} options={(depts.data ?? []).filter((d) => d.active).map((d) => ({ value: d.id, label: d.name }))} anyLabel="All departments" />
        {canPrepare && !future && addable.length > 0 && (
          <label className="flex flex-col gap-0.5 text-xs text-ink-500">
            <span>Add a dish</span>
            <Select value="" onChange={(e) => e.target.value && setExtra([...extra, e.target.value])} aria-label="Add a dish to the worksheet" className="min-w-48">
              <option value="">Choose dish…</option>
              {addable.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </Select>
          </label>
        )}
      </FilterBar>
      {sheet.error ? <ErrorState error={sheet.error} onRetry={sheet.reload} /> : !sheet.data ? <LoadingState /> : (
        <>
          <div className="mb-3 grid grid-cols-2 gap-3 md:grid-cols-4">
            <Stat label="Prepared" value={formatQty(sheet.data.totals.prepared)} />
            <Stat label="Sold" value={formatQty(sheet.data.totals.sold)} />
            <Stat label="Wasted" value={formatQty(sheet.data.totals.wasted)} hint={showCost ? formatMoney(sheet.data.totals.wastageCost ?? 0) : undefined} />
            <Stat label="Unexplained" value={formatQty(sheet.data.totals.unexplained)} tone={sheet.data.totals.unexplained > 0 ? "bad" : undefined} hint={showCost ? `${formatMoney(sheet.data.totals.varianceCost ?? 0)} at plate cost` : "portions prepared but neither sold nor wasted"} />
          </div>
          <DataTable label="Dish production worksheet" rows={rows} rowKey={(r) => r.menuItemId} loading={sheet.loading}
            empty="Nothing prepared, sold or wasted on this day"
            emptyHint={canPrepare ? "Add a dish above to enter what the kitchen prepared." : undefined}
            columns={columns} />
          <p className="mt-2 text-xs text-ink-500">Sold comes from settled orders and the dish sales log. Preparing does not take stock out; selling and wasting do, so the unexplained portions show up at the next stock count.</p>
        </>
      )}
      {wasting && <WastedDialog row={wasting} day={day} onClose={() => setWasting(null)} onDone={sheet.reload} />}
      {selling && menu.data && <ManualSalesDialog day={day} items={menu.data} onClose={() => setSelling(false)} onDone={sheet.reload} />}
    </>
  );
}

// ============================================================
// Consumption variance
// ============================================================

type VarianceRow = {
  materialId: string; sku: string; name: string; unit: string | null; category: string | null;
  expectedQty: number; expectedCost: number; wastageQty: number; wastageCost: number; countLossQty: number; countLossCost: number;
  actualQty: number; actualCost: number; varianceQty: number; varianceCost: number; variancePct: number | null;
};
type Leakage = { revenue: number; theoreticalFoodCost: number; wastage: number; countVarianceLoss: number; actualFoodCost: number; leakage: number; pct: { theoretical: number; wastage: number; countVariance: number; actual: number; leakage: number } };
type VarianceReport = { rows: VarianceRow[]; totals: { expectedCost: number; wastageCost: number; countLossCost: number; actualCost: number; varianceCost: number; variancePct: number | null }; leakage: Leakage };

export function VarianceScreen() {
  const { outletId, outlet } = useShell();
  const today = isoDay(new Date(), outlet?.timezone);
  const monthStart = `${today.slice(0, 8)}01`;
  const [range, setRange] = useState<DateRange>({ from: monthStart, to: today });
  const [dept, setDept] = useState("");
  const depts = useDepartments(outletId);
  // Date-only from/to are whole business days in the outlet's timezone (server-side).
  const q = useQuery<VarianceReport>(outletId ? "/api/analytics/consumption-variance" : null, { outletId: outletId ?? undefined, from: range.from || undefined, to: range.to || undefined, departmentId: dept || undefined });
  const qtyCell = (v: number, unit: string | null) => (v === 0 ? <span className="text-ink-400">0</span> : `${formatQty(v)} ${unit ?? ""}`);
  return (
    <>
      <PageHeader title="Consumption variance" subtitle="What the recipes say you used, against what actually left the shelf" />
      <FilterBar>
        <DateRangeFilter value={range} onChange={setRange} />
        <SelectFilter label="Department" value={dept} onChange={setDept} options={(depts.data ?? []).map((d) => ({ value: d.id, label: d.name }))} anyLabel="Whole outlet" />
      </FilterBar>
      {q.error ? <ErrorState error={q.error} onRetry={q.reload} /> : !q.data ? <LoadingState /> : (
        <>
          <Card title="Food cost leakage" className="mb-4">
            <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2 lg:grid-cols-3">
              {([
                ["Revenue (net)", q.data.leakage.revenue, null],
                ["Theoretical food cost", q.data.leakage.theoreticalFoodCost, q.data.leakage.pct.theoretical],
                ["Wastage", q.data.leakage.wastage, q.data.leakage.pct.wastage],
                ["Count variance (loss)", q.data.leakage.countVarianceLoss, q.data.leakage.pct.countVariance],
                ["Actual food cost", q.data.leakage.actualFoodCost, q.data.leakage.pct.actual],
                ["Leakage gap", q.data.leakage.leakage, q.data.leakage.pct.leakage],
              ] as Array<[string, number, number | null]>).map(([label, v, pct]) => (
                <div key={label} className="flex items-baseline justify-between gap-2 border-b border-ink-100 py-1">
                  <dt className="text-ink-600">{label}</dt>
                  <dd className={`tabular-nums ${label === "Leakage gap" ? "font-semibold text-ink-900" : ""}`}>{formatMoney(v)}{pct !== null && <span className="ml-1 text-xs text-ink-500">{formatPct(pct)} of sales</span>}</dd>
                </div>
              ))}
            </dl>
          </Card>
          <div className="mb-3 grid grid-cols-2 gap-3 md:grid-cols-4">
            <Stat label="Expected usage" value={formatMoney(q.data.totals.expectedCost)} hint="recipes × dishes sold" />
            <Stat label="Wastage" value={formatMoney(q.data.totals.wastageCost)} />
            <Stat label="Count loss" value={formatMoney(q.data.totals.countLossCost)} />
            <Stat label="Variance" value={formatMoney(q.data.totals.varianceCost)} tone={q.data.totals.varianceCost > 0 ? "bad" : undefined} hint={q.data.totals.variancePct === null ? "nothing expected" : `${formatPct(q.data.totals.variancePct)} of expected`} />
          </div>
          <DataTable label="Consumption variance by material" rows={q.data.rows} rowKey={(r) => r.materialId} empty="No sales, wastage or counts in this period"
            columns={[
              { key: "m", header: "Material", cell: (r) => <div><p className="font-medium text-ink-900">{r.name}</p><p className="text-xs text-ink-500">{r.sku}{r.category ? ` · ${r.category}` : ""}</p></div> },
              { key: "e", header: "Expected", numeric: true, cell: (r) => qtyCell(r.expectedQty, r.unit) },
              { key: "w", header: "Wasted", numeric: true, cell: (r) => qtyCell(r.wastageQty, r.unit) },
              { key: "c", header: "Count loss", numeric: true, cell: (r) => qtyCell(r.countLossQty, r.unit) },
              { key: "a", header: "Actual", numeric: true, cell: (r) => qtyCell(r.actualQty, r.unit) },
              { key: "vq", header: "Variance", numeric: true, cell: (r) => <span className={r.varianceQty > 0 ? "font-medium text-bad-600" : undefined}>{qtyCell(r.varianceQty, r.unit)}</span> },
              { key: "vc", header: "Variance ₹", numeric: true, cell: (r) => <span className={r.varianceCost > 0 ? "font-semibold text-bad-600" : undefined}>{formatMoney(r.varianceCost)}</span> },
              { key: "vp", header: "% of expected", numeric: true, cell: (r) => (r.variancePct === null ? <span className="text-ink-500">no sales</span> : formatPct(r.variancePct)) },
            ]} />
          <p className="mt-2 text-xs text-ink-500">Expected = sale consumption from the recipes (POS, table QR and the dish sales log). Actual adds recorded wastage and the losses stock counts found. Production of prepared stock is a transformation, not usage. Largest rupee variance first.</p>
          <CountTrendCard range={range} departmentId={dept} />
        </>
      )}
    </>
  );
}

type CountTrend = {
  rows: Array<{ countId: string; number: string; approvedAt: string; department: string; itemsCounted: number; itemsAdjusted: number; loss: number; surplus: number; net: number }>;
  trend: { earlierAvgLoss: number; laterAvgLoss: number; direction: "CLOSING" | "WIDENING" | "FLAT" } | null;
};

/** Stock count variance over time (proposal p. 6: "variance trends over time tell you whether the leak is closing"). */
function CountTrendCard({ range, departmentId }: { range: DateRange; departmentId: string }) {
  const { outletId, outlet } = useShell();
  const q = useQuery<CountTrend>(outletId ? "/api/analytics/count-variance-trend" : null, { outletId: outletId ?? undefined, from: range.from || undefined, to: range.to || undefined, departmentId: departmentId || undefined });
  const max = Math.max(1, ...(q.data?.rows ?? []).map((r) => r.loss));
  const t = q.data?.trend;
  return (
    <Card title="Stock count variance over time" className="mt-4">
      {q.error ? <ErrorState error={q.error} onRetry={q.reload} compact /> : !q.data ? <LoadingState /> : q.data.rows.length === 0 ? <p className="text-sm text-ink-500">No stock count was approved in this period.</p> : (
        <>
          {t ? (
            <p className="mb-3 text-sm text-ink-800">
              {t.direction === "CLOSING" ? "The leak is closing" : t.direction === "WIDENING" ? "The leak is widening" : "The leak is unchanged"}: average loss per count {formatMoney(t.earlierAvgLoss)} in the earlier counts, {formatMoney(t.laterAvgLoss)} in the later ones.
            </p>
          ) : <p className="mb-3 text-sm text-ink-500">One count so far: a trend needs at least two.</p>}
          <DataTable label="Stock count variance by count" rows={q.data.rows} rowKey={(r) => r.countId}
            columns={[
              { key: "d", header: "Approved", cell: (r) => <span><span className="font-medium text-ink-900">{r.number}</span> <span className="text-xs text-ink-500">{formatDate(r.approvedAt, outlet?.timezone)}</span></span> },
              { key: "dep", header: "Counted", cell: (r) => `${r.department} · ${r.itemsCounted} items` },
              { key: "l", header: "Loss found", numeric: true, cell: (r) => (
                <span className="inline-flex items-center justify-end gap-2">
                  <span aria-hidden className="inline-block h-2 rounded-sm bg-[#3a6ea5]" style={{ width: `${Math.max(2, (r.loss / max) * 96)}px` }} />
                  <span className={r.loss > 0 ? "font-medium text-bad-700" : undefined}>{formatMoney(r.loss)}</span>
                </span>
              ) },
              { key: "s", header: "Surplus found", numeric: true, cell: (r) => formatMoney(r.surplus) },
              { key: "n", header: "Net", numeric: true, cell: (r) => formatMoney(r.net) },
            ]} />
        </>
      )}
    </Card>
  );
}
