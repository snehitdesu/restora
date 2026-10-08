"use client";

/**
 * Group 4 screens: menu engineering (proposal module 07), department P&L and
 * daily costing (module 05), the live stock matrix (module 03), the supplier
 * price board with purchase price history (p. 17 / p. 4) and QR stock labels
 * (p. 17). Every figure comes from the server (Decimal, rounded there); these
 * screens only choose filters and draw. CSV goes through /api/exports (audited,
 * re-authorized, formula-guarded).
 */
import { useMemo, useState } from "react";
import Link from "next/link";
import { apiDownload, saveBlob, api } from "@/lib/api/client";
import { useQuery } from "@/lib/hooks/useApi";
import { useShell, useOutletId } from "@/lib/shellContext";
import { formatDate, formatDateTime, formatMoney, formatPct, formatQty, formatPrecise, isoDay } from "@/lib/format";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { Badge } from "@/components/ui/Badge";
import { Dialog } from "@/components/ui/Dialog";
import { FormAlert, Input, formError } from "@/components/ui/Form";
import { DataTable } from "@/components/ui/Table";
import { Card, PageHeader, Stat, Tabs } from "@/components/ui/Page";
import { ErrorState, LoadingState, EmptyState } from "@/components/ui/States";
import { DateRangeFilter, FilterBar, SelectFilter, type DateRange } from "@/components/ui/Filters";
import { QrCode } from "@/components/ui/QrCode";
import { useToast } from "@/components/ui/Toast";
import { useDepartments } from "@/features/backoffice/lookups";

// ---------------------------------------------------------------- shared

/** Download a registered report as CSV through the audited export endpoint. */
export function CsvExportButton({ report, filters, disabled, label = "Download CSV" }: { report: string; filters: Record<string, string | undefined>; disabled?: boolean; label?: string }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const run = async () => {
    setBusy(true);
    setErr(null);
    try {
      const { blob, filename, headers } = await apiDownload("/api/exports", { method: "POST", body: { report, filters, mode: "inline" } });
      saveBlob(blob, filename);
      toast.show(`Exported ${headers.get("x-row-count") ?? ""} rows`, "ok");
    } catch (e) {
      setErr(formError(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <span className="inline-flex flex-col items-end gap-1 print:hidden">
      <Button onClick={run} loading={busy} disabled={disabled}><Icon name="download" /> {label}</Button>
      {err && <span role="alert" className="text-xs text-bad-700">{err}</span>}
    </span>
  );
}

function useMonthRange() {
  const { outlet } = useShell();
  const today = isoDay(new Date(), outlet?.timezone);
  return { today, initial: { from: `${today.slice(0, 8)}01`, to: today } as DateRange };
}

const signed = (v: number, fmt: (n: number) => string) => `${v > 0 ? "+" : ""}${fmt(v)}`;

// ---------------------------------------------------------------- menu engineering

type MenuClass = "STAR" | "PLOWHORSE" | "PUZZLE" | "DOG";
export type MenuEngineeringRow = {
  menuItemId: string; name: string; category: string | null; price: number; ingredientCost: number; overheadPct: number; plateCost: number;
  margin: number; marginPct: number; foodCostPct: number; sold: number; netRevenue: number; totalMargin: number;
  historicalPlateCost: number | null; costChange: number | null; marginChange: number | null; historicalPrice: number | null; priceChange: number | null;
  historicalMarginPct: number | null; marginPctChange: number | null; costCoverage: number | null; confidence: "FULL" | "PARTIAL" | "NONE";
  actualCost: number | null; actualGrossMargin: number | null; highCost: boolean; notes: string[];
  class: MenuClass | null; label: string | null; action: string | null;
};
export type MenuEngineeringResult = {
  sufficient: boolean; insufficientReason: string | null; medianSold: number | null; medianMarginPct: number | null; highFoodCostPct: number; recostAdvice: string;
  counts: Record<MenuClass, number>; highCostItems: number; rows: MenuEngineeringRow[]; unscored: Array<{ menuItemId: string; name: string; sold: number; reason: string }>; basis: string;
};

const CLASS_TONE: Record<MenuClass, "ok" | "info" | "accent" | "neutral"> = { STAR: "ok", PLOWHORSE: "accent", PUZZLE: "info", DOG: "neutral" };
const CLASS_NAME: Record<MenuClass, string> = { STAR: "Stars", PLOWHORSE: "Plow-horses", PUZZLE: "Puzzles", DOG: "Dogs" };
// One series (dishes) in a cool hue, the reserved warning amber only as the "re-cost" ring (validated: CVD dE 20.9, normal 24.4, both >= 3:1 on paper).
const DOT = "#3a6ea5";
const RECOST_RING = "#b4741a";

function niceMax(v: number) {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  return [1, 2, 2.5, 5, 10].map((m) => m * p).find((m) => m >= v) ?? 10 * p;
}

/** Volume x margin % scatter, split at this menu's medians: the quadrant IS the verdict (position encodes the class). */
export function MenuMatrix({ rows, medianSold, medianMarginPct, highFoodCostPct }: { rows: MenuEngineeringRow[]; medianSold: number; medianMarginPct: number; highFoodCostPct: number }) {
  const [hover, setHover] = useState<MenuEngineeringRow | null>(null);
  const W = 720, H = 380, L = 52, R = 16, T = 18, B = 44;
  const pw = W - L - R, ph = H - T - B;
  const xMax = niceMax(Math.max(medianSold, ...rows.map((r) => r.sold)) * 1.08);
  const yMin = Math.min(0, Math.floor(Math.min(...rows.map((r) => r.marginPct)) / 20) * 20);
  const yMax = 100;
  const x = (v: number) => L + (v / xMax) * pw;
  const y = (v: number) => T + (1 - (v - yMin) / (yMax - yMin)) * ph;
  const xTicks = [0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(f * xMax * 100) / 100);
  const yTicks: number[] = [];
  for (let v = yMin; v <= yMax; v += 20) yTicks.push(v);
  const mx = x(medianSold), my = y(medianMarginPct);
  return (
    <div className="relative">
      <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label={`Menu engineering matrix: ${rows.length} dishes by portions sold and margin %, split at the median volume ${formatQty(medianSold)} and median margin ${medianMarginPct}%. The table below lists every dish.`}>
        {yTicks.map((t) => (
          <g key={`y${t}`}>
            <line x1={L} x2={W - R} y1={y(t)} y2={y(t)} className="stroke-ink-100" strokeWidth={1} />
            <text x={L - 8} y={y(t)} dy="0.32em" textAnchor="end" className="fill-ink-500 text-[11px] tabular-nums">{t}%</text>
          </g>
        ))}
        {xTicks.map((t) => <text key={`x${t}`} x={x(t)} y={H - B + 18} textAnchor="middle" className="fill-ink-500 text-[11px] tabular-nums">{formatQty(t)}</text>)}
        <line x1={L} x2={W - R} y1={T + ph} y2={T + ph} className="stroke-ink-300" strokeWidth={1} />
        <text x={L + pw / 2} y={H - 6} textAnchor="middle" className="fill-ink-600 text-[11px]">Portions sold in the period</text>
        <text transform={`translate(12 ${T + ph / 2}) rotate(-90)`} textAnchor="middle" className="fill-ink-600 text-[11px]">Margin %</text>
        {/* The split: this menu's medians, not an industry rule. */}
        <line x1={mx} x2={mx} y1={T} y2={T + ph} className="stroke-ink-400" strokeDasharray="4 4" strokeWidth={1} />
        <line x1={L} x2={W - R} y1={my} y2={my} className="stroke-ink-400" strokeDasharray="4 4" strokeWidth={1} />
        <text x={mx + 4} y={T + 10} className="fill-ink-500 text-[10px]">median {formatQty(medianSold)} sold</text>
        <text x={W - R - 4} y={my - 5} textAnchor="end" className="fill-ink-500 text-[10px]">median {medianMarginPct}%</text>
        {([["PUZZLE", L + 8, T + 14, "start"], ["STAR", W - R - 8, T + 14, "end"], ["DOG", L + 8, T + ph - 8, "start"], ["PLOWHORSE", W - R - 8, T + ph - 8, "end"]] as const).map(([c, qx, qy, anchor]) => (
          <text key={c} x={qx} y={qy} textAnchor={anchor} className="fill-ink-400 text-[11px] font-semibold uppercase tracking-[0.08em]">{CLASS_NAME[c]}</text>
        ))}
        {rows.map((r) => (
          <g key={r.menuItemId} onMouseEnter={() => setHover(r)} onMouseLeave={() => setHover((h) => (h?.menuItemId === r.menuItemId ? null : h))}>
            {r.highCost && <circle cx={x(r.sold)} cy={y(r.marginPct)} r={10} fill="none" stroke={RECOST_RING} strokeWidth={2} />}
            <circle cx={x(r.sold)} cy={y(r.marginPct)} r={hover?.menuItemId === r.menuItemId ? 7.5 : 6} fill={DOT} className="stroke-paper" strokeWidth={2} />
            <circle cx={x(r.sold)} cy={y(r.marginPct)} r={14} fill="transparent" />
          </g>
        ))}
      </svg>
      {hover && (
        <div role="tooltip" className="pointer-events-none absolute z-10 w-60 rounded-md border border-ink-200 bg-paper p-2.5 text-xs shadow-card"
          style={{ left: `min(calc(${((x(hover.sold) / W) * 100).toFixed(2)}% + 12px), calc(100% - 15rem))`, top: `${((y(hover.marginPct) / H) * 100).toFixed(2)}%` }}>
          <p className="font-semibold text-ink-900">{hover.name}</p>
          <p className="text-ink-600">{hover.label ?? "Not classified"}{hover.highCost ? " · food cost above " + highFoodCostPct + "%" : ""}</p>
          <dl className="mt-1 grid grid-cols-2 gap-x-2 tabular-nums text-ink-700">
            <dt>Sold</dt><dd className="text-right">{formatQty(hover.sold)}</dd>
            <dt>Margin</dt><dd className="text-right">{formatPct(hover.marginPct)}</dd>
            <dt>Plate cost</dt><dd className="text-right">{formatMoney(hover.plateCost)}</dd>
            <dt>Food cost</dt><dd className="text-right">{formatPct(hover.foodCostPct)}</dd>
          </dl>
        </div>
      )}
      <p className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ink-600">
        <span className="inline-flex items-center gap-1.5"><svg width="12" height="12" aria-hidden><circle cx="6" cy="6" r="5" fill={DOT} /></svg>a dish</span>
        <span className="inline-flex items-center gap-1.5"><svg width="16" height="16" aria-hidden><circle cx="8" cy="8" r="6.5" fill="none" stroke={RECOST_RING} strokeWidth="2" /></svg>food cost above {highFoodCostPct}%: re-cost it</span>
        <span>Dashed lines: this menu&apos;s median volume and median margin.</span>
      </p>
    </div>
  );
}

export function MenuEngineeringScreen() {
  const outletId = useOutletId();
  const { initial } = useMonthRange();
  const [range, setRange] = useState<DateRange>(initial);
  const invalid = Boolean(range.from && range.to && range.from > range.to);
  const filters = { outletId: outletId ?? undefined, from: range.from || undefined, to: range.to || undefined };
  const q = useQuery<MenuEngineeringResult>(outletId && !invalid ? "/api/analytics/menu-engineering" : null, filters);
  const d = q.data;
  return (
    <>
      <PageHeader title="Menu engineering" subtitle="Which dishes to push, fix, price up or remove, from real sales and real recipe costs"
        actions={<CsvExportButton report="MENU_ENGINEERING" filters={filters} disabled={invalid || !d} />} />
      <FilterBar><DateRangeFilter value={range} onChange={setRange} /></FilterBar>
      {invalid ? <FormAlert message="The start date must be on or before the end date." /> : q.error ? <ErrorState error={q.error} onRetry={q.reload} /> : !d ? <LoadingState /> : (
        <div className="flex flex-col gap-4">
          {!d.sufficient && (
            <div role="status" className="rounded-md border border-warn-200 bg-warn-50 p-3 text-sm text-warn-800">
              <p className="font-semibold">Not enough data to classify the menu</p>
              <p className="mt-0.5">{d.insufficientReason} Dishes are listed with their costs; no verdict is given.</p>
            </div>
          )}
          {d.sufficient && (
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
              {(["STAR", "PLOWHORSE", "PUZZLE", "DOG"] as MenuClass[]).map((c) => <Stat key={c} label={CLASS_NAME[c]} value={d.counts[c]} />)}
              <Stat label={`Food cost > ${d.highFoodCostPct}%`} value={d.highCostItems} tone={d.highCostItems ? "bad" : undefined} hint="re-cost these" />
            </div>
          )}
          {d.sufficient && d.rows.length > 0 && (
            <Card title="The matrix">
              <MenuMatrix rows={d.rows} medianSold={d.medianSold!} medianMarginPct={d.medianMarginPct!} highFoodCostPct={d.highFoodCostPct} />
            </Card>
          )}
          <DataTable label="Menu engineering by dish" rows={d.rows} rowKey={(r) => r.menuItemId} empty="No dish can be scored for this period"
            columns={[
              { key: "n", header: "Dish", cell: (r) => <div><p className="font-medium text-ink-900">{r.name}</p>{r.category && <p className="text-xs text-ink-500">{r.category}</p>}</div> },
              { key: "p", header: "Price", numeric: true, cell: (r) => formatMoney(r.price) },
              { key: "pc", header: "Plate cost", numeric: true, cell: (r) => <span title={r.overheadPct ? `Ingredients ${formatMoney(r.ingredientCost)} + ${r.overheadPct}% overhead` : undefined}>{formatMoney(r.plateCost)}</span> },
              { key: "m", header: "Margin", numeric: true, cell: (r) => formatMoney(r.margin) },
              { key: "mp", header: "Margin %", numeric: true, cell: (r) => formatPct(r.marginPct) },
              { key: "fc", header: "Food cost %", numeric: true, cell: (r) => (r.highCost ? <Badge tone="warn"><Icon name="alert" /> {formatPct(r.foodCostPct)}</Badge> : formatPct(r.foodCostPct)) },
              { key: "s", header: "Sold", numeric: true, cell: (r) => formatQty(r.sold) },
              { key: "v", header: "Verdict", cell: (r) => (r.class ? <Badge tone={CLASS_TONE[r.class]}>{r.label}</Badge> : <span className="text-ink-500">—</span>) },
              { key: "a", header: "What to do", className: "min-w-[16rem] whitespace-normal", cell: (r) => (
                <div className="text-sm">
                  {r.action && <p>{r.action}</p>}
                  {r.highCost && r.class && <p className="text-warn-800">{d.recostAdvice}</p>}
                  {r.notes.map((n) => <p key={n} className="text-xs text-ink-600">{n}</p>)}
                </div>
              ) },
              { key: "h", header: "When sold", numeric: true, cell: (r) => (r.historicalPlateCost === null ? <span className="text-xs text-ink-500">no sale-time cost</span> : (
                <div className="text-xs">
                  <p>plate {formatMoney(r.historicalPlateCost)}{r.costChange ? <span className={r.costChange > 0 ? "text-bad-700" : "text-ok-700"}> ({signed(r.costChange, formatMoney)})</span> : null}</p>
                  {r.historicalPrice !== null && <p>price {formatMoney(r.historicalPrice)}{r.priceChange ? ` (${signed(r.priceChange, formatMoney)})` : ""}</p>}
                  {r.confidence === "PARTIAL" && <p className="text-warn-800">{formatPct(r.costCoverage ?? 0, 0)} of portions costed</p>}
                </div>
              )) },
            ]} />
          {d.unscored.length > 0 && (
            <Card title="Not scored">
              <ul className="flex flex-col gap-1.5 text-sm">
                {d.unscored.map((u) => <li key={u.menuItemId} className="flex flex-wrap justify-between gap-2"><span className="font-medium text-ink-900">{u.name} <span className="font-normal text-ink-500">· {formatQty(u.sold)} sold</span></span><span className="text-ink-600">{u.reason}</span></li>)}
              </ul>
              <p className="mt-2 text-xs text-ink-500">A dish is only scored with a price, an approved recipe, a purchase cost for every ingredient at this outlet and a full period on the menu. Missing costs are never guessed.</p>
            </Card>
          )}
          <p className="text-xs text-ink-500">{d.basis}</p>
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------- department P&L + daily costing

type PnlRow = { departmentId: string | null; department: string; kind: string; sales: number; costIssuedIn: number; wastage: number; grossMargin: number; marginPct: number; recipeCostOfSales: number };
type Pnl = { rows: PnlRow[]; total: { sales: number; costIssuedIn: number; wastage: number; grossMargin: number; marginPct: number }; basis: string };
type DailyRow = { date: string; departmentId: string | null; department: string; opening: number; receipts: number; issuesOut: number; consumption: number; wastage: number; adjustments: number; closing: number };
type Daily = { rows: DailyRow[]; basis: string };

export function DepartmentCostingScreen() {
  const outletId = useOutletId();
  const { initial } = useMonthRange();
  const [tab, setTab] = useState<"pnl" | "daily">("pnl");
  const [range, setRange] = useState<DateRange>(initial);
  const [dept, setDept] = useState("");
  const depts = useDepartments(outletId);
  const invalid = !range.from || !range.to || range.from > range.to;
  const days = invalid ? 0 : Math.round((Date.parse(range.to) - Date.parse(range.from)) / 86_400_000) + 1;
  const tooLong = tab === "daily" && days > 31;
  const filters = { outletId: outletId ?? undefined, from: range.from || undefined, to: range.to || undefined };
  const pnl = useQuery<Pnl>(tab === "pnl" && outletId && !invalid ? "/api/analytics/department-pnl" : null, filters);
  const daily = useQuery<Daily>(tab === "daily" && outletId && !invalid && !tooLong ? "/api/analytics/daily-costing" : null, { ...filters, departmentId: dept || undefined });
  return (
    <>
      <PageHeader title="Department costing" subtitle="Profit and loss per department, and the day-by-day stock costing behind it"
        actions={<CsvExportButton report={tab === "pnl" ? "DEPARTMENT_PNL" : "DAILY_COSTING"} filters={filters} disabled={invalid || tooLong} />} />
      <Tabs label="Department costing views" value={tab} onChange={setTab} options={[{ value: "pnl", label: "Department P&L" }, { value: "daily", label: "Daily costing" }]} />
      <FilterBar>
        <DateRangeFilter value={range} onChange={setRange} />
        {tab === "daily" && <SelectFilter label="Department" value={dept} onChange={setDept} options={(depts.data ?? []).map((d) => ({ value: d.id, label: d.name }))} anyLabel="All departments" />}
      </FilterBar>
      {invalid ? <FormAlert message="Choose a start and an end date (start on or before end)." /> : tooLong ? <FormAlert message="Daily costing covers at most 31 days: shorten the range." /> : tab === "pnl" ? (
        pnl.error ? <ErrorState error={pnl.error} onRetry={pnl.reload} /> : !pnl.data ? <LoadingState /> : (
          <>
            <DataTable label="Department P&L" rows={pnl.data.rows} rowKey={(r) => r.departmentId ?? "unattributed"} empty="Nothing sold, issued or wasted in this period"
              columns={[
                { key: "d", header: "Department", cell: (r) => <span className="font-medium text-ink-900">{r.department}</span> },
                { key: "s", header: "Sales value", numeric: true, cell: (r) => formatMoney(r.sales) },
                { key: "c", header: "Cost issued in", numeric: true, cell: (r) => formatMoney(r.costIssuedIn) },
                { key: "w", header: "Item wastage", numeric: true, cell: (r) => formatMoney(r.wastage) },
                { key: "g", header: "Gross margin", numeric: true, cell: (r) => <span className={r.grossMargin < 0 ? "font-semibold text-bad-700" : "font-semibold"}>{formatMoney(r.grossMargin)}</span> },
                { key: "p", header: "Margin %", numeric: true, cell: (r) => (r.sales ? formatPct(r.marginPct) : "—") },
                { key: "r", header: "Recipe cost of sales", numeric: true, cell: (r) => formatMoney(r.recipeCostOfSales) },
              ]}
              footer={<tr className="font-semibold"><td className="px-3.5 py-2">Total</td><td className="px-3.5 py-2 text-right tabular-nums">{formatMoney(pnl.data.total.sales)}</td><td className="px-3.5 py-2 text-right tabular-nums">{formatMoney(pnl.data.total.costIssuedIn)}</td><td className="px-3.5 py-2 text-right tabular-nums">{formatMoney(pnl.data.total.wastage)}</td><td className="px-3.5 py-2 text-right tabular-nums">{formatMoney(pnl.data.total.grossMargin)}</td><td className="px-3.5 py-2 text-right tabular-nums">{pnl.data.total.sales ? formatPct(pnl.data.total.marginPct) : "—"}</td><td /></tr>} />
            <p className="mt-2 text-xs text-ink-500">{pnl.data.basis} Gross margin = sales value - cost issued in - item wastage (proposal p. 8).</p>
          </>
        )
      ) : daily.error ? <ErrorState error={daily.error} onRetry={daily.reload} /> : !daily.data ? <LoadingState /> : (
        <>
          <DataTable label="Daily costing" rows={daily.data.rows} rowKey={(r) => `${r.date}|${r.departmentId ?? ""}`} empty="No stock movement in this period"
            columns={[
              { key: "dt", header: "Day", cell: (r) => formatDate(r.date) },
              { key: "d", header: "Department", cell: (r) => r.department },
              { key: "o", header: "Opening", numeric: true, cell: (r) => formatMoney(r.opening) },
              { key: "rc", header: "Receipts", numeric: true, cell: (r) => formatMoney(r.receipts) },
              { key: "io", header: "Issues out", numeric: true, cell: (r) => formatMoney(r.issuesOut) },
              { key: "cn", header: "Consumption", numeric: true, cell: (r) => formatMoney(r.consumption) },
              { key: "w", header: "Wastage", numeric: true, cell: (r) => formatMoney(r.wastage) },
              { key: "a", header: "Adjustments", numeric: true, cell: (r) => formatMoney(r.adjustments) },
              { key: "c", header: "Closing", numeric: true, cell: (r) => <span className="font-semibold">{formatMoney(r.closing)}</span> },
            ]} />
          <p className="mt-2 text-xs text-ink-500">{daily.data.basis}</p>
        </>
      )}
    </>
  );
}

// ---------------------------------------------------------------- stock matrix

type MatrixRow = { materialId: string; sku: string; name: string; category: string | null; unit: string; quantities: Record<string, number>; total: number; par: number; belowPar: boolean; negative: boolean; avgCost?: number; value?: number };
type Matrix = { columns: Array<{ id: string; name: string; kind: string }>; rows: MatrixRow[]; showValue: boolean; totalValue?: number; valueByCategory?: Array<{ category: string; value: number }> };

export function StockMatrixScreen() {
  const outletId = useOutletId();
  const { can } = useShell();
  const [search, setSearch] = useState("");
  const q = useQuery<Matrix>(outletId ? "/api/inventory/matrix" : null, { outletId: outletId ?? undefined });
  const rows = useMemo(() => {
    const s = search.trim().toLowerCase();
    return (q.data?.rows ?? []).filter((r) => !s || r.name.toLowerCase().includes(s) || r.sku.toLowerCase().includes(s) || (r.category ?? "").toLowerCase().includes(s));
  }, [q.data, search]);
  const d = q.data;
  return (
    <>
      <PageHeader title="Stock matrix" subtitle="Every material against every department: quantity on hand, valued at weighted average cost"
        actions={can("reports.view") && <CsvExportButton report="STOCK_BY_DEPARTMENT" filters={{ outletId: outletId ?? undefined }} disabled={!d} />} />
      <FilterBar>
        <label className="flex flex-col gap-0.5 text-xs text-ink-500"><span>Search</span><Input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Material, SKU or category" className="min-w-56" /></label>
      </FilterBar>
      {q.error ? <ErrorState error={q.error} onRetry={q.reload} /> : !d ? <LoadingState /> : (
        <div className="flex flex-col gap-4">
          {d.showValue && d.valueByCategory && (
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <Stat label="Stock value" value={formatMoney(d.totalValue ?? 0)} hint="quantity × weighted average cost" />
              {d.valueByCategory.slice(0, 3).map((c) => <Stat key={c.category} label={c.category} value={formatMoney(c.value)} />)}
            </div>
          )}
          <DataTable label="Stock by department" rows={rows} rowKey={(r) => r.materialId} empty={search ? "No material matches" : "No stock recorded yet"}
            columns={[
              { key: "m", header: "Material", cell: (r) => <div><Link href={`/inventory/stock/${r.materialId}`} className="font-medium text-ink-900 hover:text-brand-700 hover:underline">{r.name}</Link><p className="text-xs text-ink-500">{r.sku}{r.category ? ` · ${r.category}` : ""}</p></div> },
              ...d.columns.map((c) => ({ key: `c-${c.id}`, header: c.name, numeric: true, cell: (r: MatrixRow) => {
                const v = r.quantities[c.id] ?? 0;
                return v === 0 ? <span className="text-ink-300">·</span> : <span className={v < 0 ? "font-semibold text-bad-700" : undefined}>{formatPrecise(v, 3)}</span>;
              } })),
              { key: "t", header: "Total", numeric: true, cell: (r) => <span className={`font-semibold ${r.negative ? "text-bad-700" : ""}`}>{formatPrecise(r.total, 3)} <span className="font-normal text-ink-500">{r.unit}</span></span> },
              { key: "f", header: "", cell: (r) => (r.negative ? <Badge tone="bad">Negative</Badge> : r.belowPar ? <Badge tone="warn">Below PAR {formatQty(r.par)}</Badge> : null) },
              ...(d.showValue ? [{ key: "v", header: "Value", numeric: true, cell: (r: MatrixRow) => formatMoney(r.value ?? 0) }] : []),
            ]} />
          <p className="text-xs text-ink-500">Unassigned = received but not yet issued to a department. Negative stock means a missing purchase, a wrong recipe quantity or an unrecorded transfer.</p>
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------- supplier prices + price history

type Quote = { vendorId: string; vendor: string; status: string; buyable: boolean; preferred: boolean; ratePerBase: number | null; ratePerPurchaseUnit: number | null; leadTimeDays: number; lastReceived: { ratePerBase: number; receivedAt: string; grnNumber: string } | null; cheapest: boolean; aboveCheapestPct: number | null };
type PriceRow = { materialId: string; sku: string; name: string; category: string | null; baseUnit: string; purchaseUnit: string | null; packFactor: number | null; avgCost: number | null; lastCost: number | null; comparable: number; spread: number | null; quotes: Quote[] };
type PriceBoard = { rows: PriceRow[]; basis: string };
type History = { name: string; unit: string; avgCost: number | null; lastCost: number | null; window: { receipts: number; qty: number; weightedRate: number; low: number; high: number } | null; receipts: Array<{ id: string; receivedAt: string; qty: number; ratePerBase: number; vendor: string | null; document: string | null; changePct: number | null }> };

function PriceDetailDialog({ row, onClose }: { row: PriceRow; onClose: () => void }) {
  const outletId = useOutletId();
  const { outlet } = useShell();
  const h = useQuery<History>(outletId ? "/api/procurement/price-history" : null, { outletId: outletId ?? undefined, materialId: row.materialId });
  return (
    <Dialog open onClose={onClose} size="lg" title={row.name} description={`Per ${row.baseUnit}${row.purchaseUnit && row.packFactor ? ` · 1 ${row.purchaseUnit} = ${formatPrecise(row.packFactor)} ${row.baseUnit}` : ""}`}>
      <DataTable label={`Vendor quotes for ${row.name}`} rows={row.quotes} rowKey={(x) => x.vendorId}
        columns={[
          { key: "v", header: "Vendor", cell: (x) => <span className={x.buyable ? "font-medium text-ink-900" : "text-ink-500 line-through"}>{x.vendor}{x.preferred && <Badge tone="brand" className="ml-1">Preferred</Badge>}</span> },
          { key: "st", header: "Status", cell: (x) => (x.buyable ? <Badge tone="ok">Active</Badge> : <Badge tone="neutral">{x.status.toLowerCase()}</Badge>) },
          { key: "r", header: `Per ${row.baseUnit}`, numeric: true, cell: (x) => (x.ratePerBase === null ? "—" : <span className={x.cheapest ? "font-semibold text-ok-700" : undefined}>{formatMoney(x.ratePerBase)}{x.aboveCheapestPct !== null && x.buyable && <span className="ml-1 text-xs text-ink-500">+{x.aboveCheapestPct}%</span>}</span>) },
          { key: "pu", header: row.purchaseUnit ? `Per ${row.purchaseUnit}` : "Per pack", numeric: true, cell: (x) => (x.ratePerPurchaseUnit === null ? "—" : formatMoney(x.ratePerPurchaseUnit)) },
          { key: "l", header: "Last received", numeric: true, cell: (x) => (x.lastReceived ? <span title={`${x.lastReceived.grnNumber}, ${formatDateTime(x.lastReceived.receivedAt, outlet?.timezone)}`}>{formatMoney(x.lastReceived.ratePerBase)}</span> : "—") },
          { key: "lt", header: "Lead time", numeric: true, cell: (x) => `${x.leadTimeDays} d` },
        ]} />
      <h3 className="mb-2 mt-4 text-sm font-semibold text-ink-900">Purchase price history</h3>
      {h.error ? <ErrorState error={h.error} onRetry={h.reload} compact /> : !h.data ? <LoadingState /> : h.data.receipts.length === 0 ? <p className="text-sm text-ink-500">Nothing received at this outlet yet.</p> : (
        <>
          {h.data.window && <p className="mb-2 text-sm text-ink-700">{h.data.window.receipts} receipts · {formatPrecise(h.data.window.qty)} {h.data.unit} · weighted {formatMoney(h.data.window.weightedRate)} · low {formatMoney(h.data.window.low)} · high {formatMoney(h.data.window.high)}</p>}
          <DataTable label={`Price history for ${row.name}`} rows={h.data.receipts} rowKey={(r) => r.id}
            columns={[
              { key: "d", header: "Received", cell: (r) => formatDateTime(r.receivedAt, outlet?.timezone) },
              { key: "v", header: "Vendor", cell: (r) => r.vendor ?? "—" },
              { key: "doc", header: "Document", cell: (r) => r.document ?? "—" },
              { key: "q", header: "Qty", numeric: true, cell: (r) => `${formatPrecise(r.qty)} ${h.data!.unit}` },
              { key: "r", header: `Per ${h.data.unit}`, numeric: true, cell: (r) => formatMoney(r.ratePerBase) },
              { key: "c", header: "Change", numeric: true, cell: (r) => (r.changePct === null ? "—" : <span className={r.changePct > 0 ? "text-bad-700" : r.changePct < 0 ? "text-ok-700" : undefined}>{signed(r.changePct, (n) => formatPct(n))}</span>) },
            ]} />
        </>
      )}
    </Dialog>
  );
}

export function SupplierPricesScreen() {
  const outletId = useOutletId();
  const [search, setSearch] = useState("");
  const [applied, setApplied] = useState("");
  const [comparableOnly, setComparableOnly] = useState(false);
  const [open, setOpen] = useState<PriceRow | null>(null);
  const q = useQuery<PriceBoard>(outletId ? "/api/procurement/supplier-prices" : null, { outletId: outletId ?? undefined, search: applied || undefined, comparableOnly: comparableOnly ? "true" : undefined });
  const cheapestOf = (r: PriceRow) => r.quotes.find((x) => x.cheapest) ?? null;
  return (
    <>
      <PageHeader title="Supplier prices" subtitle="Every vendor's price for each material, per base unit so different pack sizes compare fairly"
        actions={<CsvExportButton report="SUPPLIER_PRICES" filters={{ outletId: outletId ?? undefined }} disabled={!q.data} />} />
      <FilterBar>
        <form className="flex items-end gap-2" onSubmit={(e) => { e.preventDefault(); setApplied(search.trim()); }}>
          <label className="flex flex-col gap-0.5 text-xs text-ink-500"><span>Search</span><Input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Material or SKU" className="min-w-56" /></label>
          <Button type="submit">Search</Button>
        </form>
        <label className="flex items-center gap-2 self-end pb-2 text-sm text-ink-700"><input type="checkbox" checked={comparableOnly} onChange={(e) => setComparableOnly(e.target.checked)} className="h-4 w-4 accent-brand-600" /> Only materials two vendors can supply</label>
      </FilterBar>
      {q.error ? <ErrorState error={q.error} onRetry={q.reload} /> : !q.data ? <LoadingState /> : (
        <>
          <DataTable label="Supplier price comparison" rows={q.data.rows} rowKey={(r) => r.materialId} onRowClick={setOpen} empty={applied ? "No material matches" : "No vendor is linked to a material yet"}
            columns={[
              { key: "m", header: "Material", cell: (r) => <div><p className="font-medium text-ink-900">{r.name}</p><p className="text-xs text-ink-500">{r.sku}{r.category ? ` · ${r.category}` : ""}</p></div> },
              { key: "best", header: "Cheapest active vendor", cell: (r) => { const c = cheapestOf(r); return c ? <span>{c.vendor}</span> : <span className="text-ink-500">no active quote</span>; } },
              { key: "rate", header: "Best rate", numeric: true, cell: (r) => { const c = cheapestOf(r); return c?.ratePerBase != null ? `${formatMoney(c.ratePerBase)} / ${r.baseUnit}` : "—"; } },
              { key: "n", header: "Vendors", numeric: true, cell: (r) => `${r.comparable} of ${r.quotes.length}` },
              { key: "sp", header: "Spread", numeric: true, cell: (r) => (r.spread === null ? "—" : formatMoney(r.spread)) },
              { key: "avg", header: "Average cost", numeric: true, cell: (r) => (r.avgCost === null ? "—" : formatMoney(r.avgCost)) },
            ]} />
          <p className="mt-2 text-xs text-ink-500">{q.data.basis} Open a material for every quote and its purchase price history.</p>
        </>
      )}
      {open && <PriceDetailDialog row={open} onClose={() => setOpen(null)} />}
    </>
  );
}

// ---------------------------------------------------------------- QR stock labels

type LabelItem = { materialId: string; sku: string; name: string; unit: string; category: string | null; payload: string };
type Lookup = { materialId: string; sku: string; name: string; active: boolean; unit: string; category: string | null; onHand: number; reorderLevel: number; departments: Array<{ departmentId: string | null; department: string; qty: number }>; avgCost?: number | null; value?: number | null };

function ScanLookup() {
  const outletId = useOutletId();
  const { can } = useShell();
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [found, setFound] = useState<Lookup | null>(null);
  const look = async (value: string) => {
    if (!value.trim() || !outletId) return;
    setBusy(true);
    setErr(null);
    try {
      setFound(await api<Lookup>(`/api/inventory/labels/lookup?outletId=${encodeURIComponent(outletId)}&code=${encodeURIComponent(value.trim())}`));
    } catch (e) {
      setFound(null);
      setErr(formError(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card title="Scan or type a label">
      <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); void look(code); }}>
        <label className="flex min-w-64 flex-1 flex-col gap-0.5 text-xs text-ink-500">
          <span>Label code or SKU</span>
          <Input value={code} onChange={(e) => setCode(e.target.value)} placeholder="Scan with a USB scanner, or type RM-0001" autoComplete="off" aria-label="Label code or SKU" />
        </label>
        <Button type="submit" variant="primary" loading={busy}><Icon name="search" /> Look up</Button>
      </form>
      <FormAlert message={err} />
      {found && (
        <div className="mt-3 rounded-md border border-ink-200 p-3">
          <p className="font-semibold text-ink-900">{found.name} <span className="font-normal text-ink-500">· {found.sku}{found.category ? ` · ${found.category}` : ""}</span>{!found.active && <Badge tone="neutral" className="ml-2">Inactive</Badge>}</p>
          <p className="mt-1 text-2xl font-semibold tabular-nums text-ink-900">{formatPrecise(found.onHand, 3)} <span className="text-base font-normal text-ink-500">{found.unit} on hand</span></p>
          {found.reorderLevel > 0 && found.onHand < found.reorderLevel && <Badge tone="warn">Below PAR ({formatQty(found.reorderLevel)})</Badge>}
          {found.departments.length > 0 && <ul className="mt-2 flex flex-wrap gap-2">{found.departments.map((d) => <li key={d.departmentId ?? "u"}><Badge tone="neutral">{d.department}: {formatPrecise(d.qty, 3)}</Badge></li>)}</ul>}
          {found.value !== undefined && found.value !== null && <p className="mt-1 text-sm text-ink-600">Value {formatMoney(found.value)}</p>}
          <div className="mt-3 flex flex-wrap gap-2">
            <Link href={`/inventory/stock/${found.materialId}`} className="text-sm text-brand-700 hover:underline">Movements</Link>
            {can("inventory.count") && <Link href="/inventory/counts" className="text-sm text-brand-700 hover:underline">Count</Link>}
            {can("inventory.issue") && <Link href="/inventory/issues" className="text-sm text-brand-700 hover:underline">Issue</Link>}
            {can("inventory.wastage") && <Link href="/inventory/wastage" className="text-sm text-brand-700 hover:underline">Record wastage</Link>}
          </div>
        </div>
      )}
    </Card>
  );
}

export function StockLabelsScreen() {
  const outletId = useOutletId();
  const [search, setSearch] = useState("");
  const [applied, setApplied] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const q = useQuery<LabelItem[]>(outletId ? "/api/inventory/labels" : null, { outletId: outletId ?? undefined, search: applied || undefined });
  const items = q.data ?? [];
  const toPrint = items.filter((i) => picked.has(i.materialId));
  const toggle = (id: string) => setPicked((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  return (
    <>
      <PageHeader title="Stock labels" subtitle="QR labels for shelves and bins: they carry the material's SKU, so scanning one shows its stock"
        actions={<Button variant="primary" onClick={() => window.print()} disabled={!toPrint.length} className="print:hidden"><Icon name="receipt" /> Print {toPrint.length || ""} label{toPrint.length === 1 ? "" : "s"}</Button>} />
      <div className="print:hidden">
        <ScanLookup />
        <Card title="Choose labels to print" className="mt-4">
          <form className="mb-3 flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); setApplied(search.trim()); }}>
            <label className="flex min-w-56 flex-col gap-0.5 text-xs text-ink-500"><span>Search materials</span><Input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Name or SKU" /></label>
            <Button type="submit">Search</Button>
            {items.length > 0 && <Button onClick={() => setPicked(new Set(items.map((i) => i.materialId)))}>Select all shown</Button>}
            {picked.size > 0 && <Button variant="ghost" onClick={() => setPicked(new Set())}>Clear</Button>}
          </form>
          {q.error ? <ErrorState error={q.error} onRetry={q.reload} compact /> : !q.data ? <LoadingState /> : items.length === 0 ? <EmptyState title="No material found" /> : (
            <ul className="grid gap-1 sm:grid-cols-2 lg:grid-cols-3">
              {items.map((i) => (
                <li key={i.materialId}>
                  <label className="flex min-h-11 cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-vanilla-50">
                    <input type="checkbox" checked={picked.has(i.materialId)} onChange={() => toggle(i.materialId)} className="h-4 w-4 accent-brand-600" />
                    <span className="font-medium text-ink-900">{i.name}</span><span className="text-xs text-ink-500">{i.sku}</span>
                  </label>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
      {toPrint.length > 0 && (
        <section aria-label="Label sheet" className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 print:mt-0 print:grid-cols-3 print:gap-2">
          {toPrint.map((i) => (
            <figure key={i.materialId} className="flex break-inside-avoid flex-col items-center rounded-md border border-ink-300 bg-white p-3 text-center print:border-ink-800">
              <QrCode value={i.payload} label={`Stock label ${i.sku}`} className="h-28 w-28" />
              <figcaption className="mt-1.5">
                <p className="text-sm font-semibold leading-tight text-ink-900">{i.name}</p>
                <p className="font-mono text-xs text-ink-700">{i.sku} · {i.unit}</p>
              </figcaption>
            </figure>
          ))}
        </section>
      )}
    </>
  );
}
