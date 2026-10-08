"use client";

/**
 * Reorder screen (proposal module 02, p.5): what to buy today, computed live by
 * GET /api/procurement/reorder (svc/reorder.ts). The store-keeper reviews the
 * suggestions (quantity, vendor, rate), then raises DRAFT purchase orders (one
 * per vendor) or a DRAFT purchase request. Submitting, approving and ordering
 * stay in the normal PO / indent screens. Only ACTIVE vendors are offered: the
 * server lists them per row and re-checks every vendor when raising.
 */
import Link from "next/link";
import { useMemo, useState } from "react";
import { api, ApiError } from "@/lib/api/client";
import { useQuery } from "@/lib/hooks/useApi";
import { useShell, useOutletId } from "@/lib/shellContext";
import { createKeyedSubmitter } from "@/lib/idempotency";
import { formatMoney, formatQty } from "@/lib/format";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { Field, FormDialog, Input, Select, Textarea, opt } from "@/components/ui/Form";
import { DataTable } from "@/components/ui/Table";
import { Card, PageHeader, Stat, Tabs } from "@/components/ui/Page";
import { LoadingState, ErrorState } from "@/components/ui/States";
import { useToast } from "@/components/ui/Toast";
import { ProcureNav } from "@/features/backoffice/procurement";
import { useDepartments } from "@/features/backoffice/lookups";

type Priority = "CRITICAL" | "HIGH" | "NORMAL";
type IncomingDoc = { type: "PO" | "INDENT" | "GRN"; id: string; number: string; status: string; qty: number; draft: boolean };
export type ReorderRow = {
  materialId: string; sku: string; name: string; category: string | null; baseUnitId: string; baseUnit: string;
  priority: Priority; reasons: string[];
  onHand: number; onHandClamped: number; incoming: number; incomingDocs: IncomingDoc[]; includesDrafts: boolean;
  position: number; safetyStock: number; reorderLevel: number; parLevel: number | null; reorderPoint: number; target: number;
  usedInWindow: number; observedDays: number; avgDailyUse: number; daysOfCover: number | null; stockoutDate: string | null;
  historyStatus: "OK" | "INSUFFICIENT" | "NONE"; leadTimeDays: number; suggestedBaseQty: number;
  order: { unitId: string; unitCode: string; qty: number; packFactor: number | null };
  vendor: { id: string; name: string; rate: number | null; leadTimeDays: number | null; selectedBecause: string | null } | null;
  blockedVendorNote: string | null;
  alternatives: Array<{ vendorId: string; name: string; rate: number | null; leadTimeDays: number | null; estimatedValue: number | null }>;
  unitCost: number | null; costSource: string | null; estimatedValue: number | null; poRate: number | null;
  departments: Array<{ departmentId: string | null; name: string; onHand: number }>;
};
type SetupRow = { materialId: string; sku: string; name: string; reason: "NO_REORDER_SETTINGS" | "NO_ELIGIBLE_VENDOR"; usedInWindow: number; onHand: number; blockedVendorNote: string | null };
type DraftCovered = { materialId: string; sku: string; name: string; baseUnit: string; onHand: number; reorderPoint: number; incoming: number; draftIncoming: number; drafts: IncomingDoc[] };
export type ReorderData = {
  outletId: string; asOf: string; lookbackDays: number; rows: ReorderRow[]; needsSetup: SetupRow[]; coveredByDrafts: DraftCovered[];
  summary: { items: number; critical: number; high: number; normal: number; budget: number; noVendor: number; includesDrafts: number; coveredByDrafts: number; byVendor: Array<{ vendorId: string | null; vendorName: string | null; lines: number; spend: number }> };
};
type Edit = { selected: boolean; qty: string; vendorId: string; rate: string };

const PRIORITY_TONE: Record<Priority, "bad" | "warn" | "neutral"> = { CRITICAL: "bad", HIGH: "warn", NORMAL: "neutral" };
const REASON_LABEL: Record<string, string> = {
  NEGATIVE_STOCK: "Negative stock: count it",
  BELOW_SAFETY_STOCK: "Below safety stock",
  STOCKOUT_BEFORE_DELIVERY: "Runs out before delivery",
  USAGE_RAISED_REORDER_POINT: "Usage raised the reorder point",
  NO_HISTORY: "No usage history",
  INSUFFICIENT_HISTORY: "Short usage history",
  NO_PACK_CONVERSION: "Purchase unit has no conversion",
  NO_COST: "No cost known",
};
const docHref = (d: IncomingDoc) => (d.type === "PO" ? `/procurement/purchase-orders/${d.id}` : d.type === "INDENT" ? `/procurement/indents/${d.id}` : `/procurement/grns/${d.id}`);
const toNum = (v: string) => (v.trim() === "" ? NaN : Number(v));

function initialEdits(rows: ReorderRow[]): Record<string, Edit> {
  return Object.fromEntries(rows.map((r) => [r.materialId, { selected: true, qty: String(r.order.qty), vendorId: r.vendor?.id ?? "", rate: r.poRate !== null ? String(r.poRate) : "" }]));
}

function IncomingCell({ r }: { r: ReorderRow }) {
  if (!r.incomingDocs.length) return <span className="text-ink-400">—</span>;
  return (
    <div className="text-right">
      <span className="font-medium">{formatQty(r.incoming)} {r.baseUnit}</span>
      <ul className="mt-0.5 space-y-0.5 text-xs text-ink-500" aria-label={`Incoming documents for ${r.name}`}>
        {r.incomingDocs.map((d) => (
          <li key={`${d.type}-${d.id}`}>
            <Link href={docHref(d)} className="text-brand-600 hover:underline">{d.number}</Link> · {d.status} · {formatQty(d.qty)}
            {d.draft && <Badge tone="warn" className="ml-1">Draft</Badge>}
          </li>
        ))}
      </ul>
    </div>
  );
}

function ItemDetails({ r }: { r: ReorderRow }) {
  return (
    <details className="mt-1 text-xs text-ink-600">
      <summary className="cursor-pointer text-brand-600">Details</summary>
      <div className="mt-1 space-y-1">
        <p>Used {formatQty(r.usedInWindow)} {r.baseUnit} over {r.observedDays} day{r.observedDays === 1 ? "" : "s"} · lead time {r.leadTimeDays} day{r.leadTimeDays === 1 ? "" : "s"} · safety stock {formatQty(r.safetyStock)} · reorder level {formatQty(r.reorderLevel)}{r.parLevel !== null ? ` · par ${formatQty(r.parLevel)}` : ""}</p>
        {r.departments.length > 0 && <p>By department: {r.departments.map((d) => `${d.name} ${formatQty(d.onHand)}`).join(" · ")}</p>}
        {r.alternatives.length > 0 && (
          <table className="mt-1 text-xs" aria-label={`Vendor prices for ${r.name}`}>
            <thead><tr className="text-left text-ink-500"><th className="pr-3">Vendor</th><th className="pr-3 text-right">Rate / {r.baseUnit}</th><th className="pr-3 text-right">Lead</th><th className="text-right">Order value</th></tr></thead>
            <tbody>
              {r.alternatives.map((a) => (
                <tr key={a.vendorId}><td className="pr-3">{a.name}</td><td className="pr-3 text-right tabular-nums">{a.rate !== null ? formatMoney(a.rate) : "—"}</td><td className="pr-3 text-right tabular-nums">{a.leadTimeDays ?? "—"}</td><td className="text-right tabular-nums">{a.estimatedValue !== null ? formatMoney(a.estimatedValue) : "—"}</td></tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </details>
  );
}

export function ReorderScreen() {
  const { can } = useShell();
  const outletId = useOutletId();
  const toast = useToast();
  const [lookbackDays, setLookbackDays] = useState("14");
  const q = useQuery<ReorderData>(outletId ? "/api/procurement/reorder" : null, { outletId: outletId ?? undefined, lookbackDays });
  const [tab, setTab] = useState<"reorder" | "setup">("reorder");
  const [edits, setEdits] = useState<Record<string, Edit>>({});
  const [seen, setSeen] = useState<ReorderData | undefined>(undefined);
  const [dialog, setDialog] = useState<null | "po" | "indent">(null);
  const [conflict, setConflict] = useState<string | null>(null);
  const [raised, setRaised] = useState<Array<{ href: string; label: string }>>([]);
  const mayRaise = can("purchase.create");

  // Fresh data (load / reload / window change) resets the review to the suggestions.
  if (q.data !== seen) {
    setSeen(q.data);
    setEdits(q.data ? initialEdits(q.data.rows) : {});
  }
  const data = q.data;
  const rows = useMemo(() => data?.rows ?? [], [data]);
  const set = (id: string, patch: Partial<Edit>) => setEdits((e) => ({ ...e, [id]: { ...e[id], ...patch } }));
  const selected = rows.filter((r) => edits[r.materialId]?.selected);
  const poLines = selected.filter((r) => edits[r.materialId]?.vendorId);
  const noVendorSelected = selected.length - poLines.length;

  const groups = useMemo(() => {
    const g = new Map<string, { vendorId: string | null; vendorName: string; rows: ReorderRow[] }>();
    for (const r of rows) {
      const k = r.vendor?.id ?? "";
      if (!g.has(k)) g.set(k, { vendorId: r.vendor?.id ?? null, vendorName: r.vendor?.name ?? "No eligible vendor", rows: [] });
      g.get(k)!.rows.push(r);
    }
    return [...g.values()].sort((a, b) => (a.vendorId ? 0 : 1) - (b.vendorId ? 0 : 1) || a.vendorName.localeCompare(b.vendorName));
  }, [rows]);

  const onRaiseError = (e: unknown) => {
    if (e instanceof ApiError && e.status === 409) setConflict(e.message);
    throw e;
  };
  const reload = () => { setConflict(null); setRaised([]); q.reload(); };

  if (!outletId) return null;
  return (
    <>
      <PageHeader title="Reorder" subtitle={data ? `What to buy, from the stock ledger as of ${new Date(data.asOf).toLocaleString()} · usage over the last ${data.lookbackDays} days` : "What to buy, from the stock ledger"}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-2 whitespace-nowrap text-sm text-ink-600">Usage window
              <Select value={lookbackDays} onChange={(e) => setLookbackDays(e.target.value)} aria-label="Usage window">
                <option value="7">7 days</option><option value="14">14 days</option><option value="30">30 days</option>
              </Select>
            </label>
            <Button onClick={reload}><Icon name="refresh" /> Reload</Button>
            {mayRaise && <Button onClick={() => setDialog("indent")} disabled={!selected.length}>Raise purchase request ({selected.length})</Button>}
            {mayRaise && <Button variant="primary" onClick={() => setDialog("po")} disabled={!poLines.length}>Raise purchase orders ({poLines.length})</Button>}
          </div>
        } />
      <ProcureNav />
      {q.loading && !data && <LoadingState />}
      {q.error && <ErrorState error={q.error} onRetry={q.reload} />}
      {data && (
        <>
          {conflict && (
            <div role="alert" className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-bad-100 bg-bad-50 px-4 py-3 text-sm text-bad-700">
              <span>{conflict}</span>
              <Button onClick={reload}>Reload</Button>
            </div>
          )}
          {raised.length > 0 && (
            <div role="status" className="mb-4 rounded-lg border border-ok-100 bg-ok-50 px-4 py-3 text-sm text-ok-700">
              Raised as drafts: {raised.map((d, i) => <span key={d.href}>{i > 0 && ", "}<Link href={d.href} className="font-medium underline">{d.label}</Link></span>)}. Submit and approve them from Purchasing.
            </div>
          )}
          <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Items to reorder" value={data.summary.items} />
            <Stat label="Critical" value={data.summary.critical} tone={data.summary.critical ? "bad" : undefined} hint="Out of stock, below safety stock, or runs out before delivery" />
            <Stat label="Estimated budget" value={formatMoney(data.summary.budget)} hint="Suggested quantities at current average cost" />
            <Stat label="Without an eligible vendor" value={data.summary.noVendor} tone={data.summary.noVendor ? "bad" : undefined} hint="Purchase request only" />
          </div>
          {(data.summary.includesDrafts > 0 || data.coveredByDrafts.length > 0) && (
            <div role="note" className="mb-4 rounded-lg border border-warn-100 bg-warn-50 px-4 py-3 text-sm text-warn-700">
              <p className="font-semibold">Includes draft documents</p>
              <p>DRAFT purchase orders and requests count as stock on its way. {data.summary.includesDrafts > 0 && `${data.summary.includesDrafts} item${data.summary.includesDrafts === 1 ? "" : "s"} below include drafts. `}Cancel drafts nobody will send, or the need they cover stays hidden.</p>
              {data.coveredByDrafts.length > 0 && (
                <ul className="mt-2 space-y-1" aria-label="Covered only by draft documents">
                  {data.coveredByDrafts.map((c) => (
                    <li key={c.materialId}>
                      <span className="font-medium">{c.name}</span> ({c.sku}): on hand {formatQty(c.onHand)} {c.baseUnit}, reorder point {formatQty(c.reorderPoint)}, covered only by{" "}
                      {c.drafts.map((d, i) => <span key={`${d.type}-${d.id}`}>{i > 0 && ", "}<Link href={docHref(d)} className="underline">{d.number}</Link> ({d.status}, {formatQty(d.qty)})</span>)}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          <Tabs label="Reorder view" value={tab} onChange={setTab} options={[{ value: "reorder", label: `To reorder (${rows.length})` }, { value: "setup", label: `Needs setup (${data.needsSetup.length})` }]} />
          {tab === "reorder" && (rows.length === 0 ? (
            <Card><p className="text-sm text-ink-600">Nothing is below its reorder point at this outlet. Items need a reorder level, minimum or par level to be checked; see Needs setup.</p></Card>
          ) : groups.map((g) => (
            <section key={g.vendorId ?? "none"} className="mb-5" aria-label={g.vendorId ? `Vendor ${g.vendorName}` : "No eligible vendor"}>
              <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold text-ink-800">
                {g.vendorName}
                {!g.vendorId && <Badge tone="bad">Purchase request only</Badge>}
                <span className="font-normal text-ink-500">· {g.rows.length} item{g.rows.length === 1 ? "" : "s"}</span>
              </h2>
              <DataTable label={`Reorder ${g.vendorName}`} rows={g.rows} rowKey={(r) => r.materialId}
                columns={[
                  ...(mayRaise ? [{ key: "sel", header: <span className="sr-only">Include</span>, cell: (r: ReorderRow) => <input type="checkbox" aria-label={`Include ${r.name}`} checked={Boolean(edits[r.materialId]?.selected)} onChange={(e) => set(r.materialId, { selected: e.target.checked })} /> }] : []),
                  {
                    key: "item", header: "Item", cell: (r) => (
                      <div className="max-w-xs">
                        <div className="flex flex-wrap items-center gap-1.5"><Badge tone={PRIORITY_TONE[r.priority]}>{r.priority}</Badge><span className="font-medium text-ink-900">{r.name}</span><span className="text-xs text-ink-500">{r.sku}</span></div>
                        <div className="mt-1 flex flex-wrap gap-1">
                          {r.reasons.filter((x) => REASON_LABEL[x]).map((x) => <Badge key={x} tone={x === "NEGATIVE_STOCK" || x === "STOCKOUT_BEFORE_DELIVERY" ? "bad" : "neutral"}>{REASON_LABEL[x]}</Badge>)}
                          {r.includesDrafts && <Badge tone="warn">Includes drafts</Badge>}
                          {r.blockedVendorNote && <Badge tone="warn">{r.blockedVendorNote}</Badge>}
                        </div>
                        <ItemDetails r={r} />
                      </div>
                    ),
                  },
                  {
                    key: "qty", header: "Order", numeric: true, cell: (r) => mayRaise ? (
                      <div className="flex flex-col items-end">
                        <span className="flex items-center gap-1"><span className="w-24"><Input className="text-right" type="number" inputMode="decimal" min="0" step={r.order.packFactor ? "1" : "any"} aria-label={`Order quantity for ${r.name}`} value={edits[r.materialId]?.qty ?? ""} onChange={(e) => set(r.materialId, { qty: e.target.value })} /></span>{r.order.unitCode}</span>
                        {r.order.packFactor && <span className="text-xs text-ink-500">= {formatQty((toNum(edits[r.materialId]?.qty ?? "") || 0) * r.order.packFactor)} {r.baseUnit}</span>}
                      </div>
                    ) : <span>{formatQty(r.order.qty)} {r.order.unitCode}</span>,
                  },
                  {
                    key: "vendor", header: "Vendor", cell: (r) => mayRaise && r.alternatives.length ? (
                      <div className="w-56"><Select aria-label={`Vendor for ${r.name}`} value={edits[r.materialId]?.vendorId ?? ""} onChange={(e) => set(r.materialId, { vendorId: e.target.value })}>
                        <option value="">No vendor (request only)</option>
                        {r.alternatives.map((a) => <option key={a.vendorId} value={a.vendorId}>{a.name}{a.rate !== null ? ` · ${formatMoney(a.rate)}/${r.baseUnit}` : ""}{a.leadTimeDays !== null ? ` · ${a.leadTimeDays}d` : ""}</option>)}
                      </Select></div>
                    ) : <span className={r.vendor ? "" : "text-bad-600"}>{r.vendor?.name ?? "No eligible vendor"}</span>,
                  },
                  {
                    key: "rate", header: "Rate / order unit", numeric: true, cell: (r) => mayRaise ? (
                      <div className="ml-auto w-28"><Input className="text-right" type="number" inputMode="decimal" min="0" step="any" aria-label={`Rate for ${r.name}`} placeholder="Rate" value={edits[r.materialId]?.rate ?? ""} onChange={(e) => set(r.materialId, { rate: e.target.value })} /></div>
                    ) : r.poRate !== null ? formatMoney(r.poRate) : "—",
                  },
                  { key: "val", header: "Est. value", numeric: true, cell: (r) => (r.estimatedValue !== null ? formatMoney(r.estimatedValue) : <span className="text-ink-400">no cost</span>) },
                  { key: "oh", header: "On hand", numeric: true, cell: (r) => <span className={r.onHand <= 0 ? "font-semibold text-bad-600" : ""}>{formatQty(r.onHand)} {r.baseUnit}</span> },
                  { key: "in", header: "Incoming", numeric: true, cell: (r) => <IncomingCell r={r} /> },
                  { key: "use", header: "Use / day · cover", numeric: true, cell: (r) => <span>{r.avgDailyUse ? formatQty(r.avgDailyUse) : "—"}<br /><span className="text-xs text-ink-500">{r.daysOfCover !== null ? `${r.daysOfCover} days` : "no usage"}</span></span> },
                  { key: "lvl", header: "Reorder point → target", numeric: true, cell: (r) => `${formatQty(r.reorderPoint)} → ${formatQty(r.target)}` },
                ]} />
            </section>
          )))}
          {tab === "setup" && (
            <DataTable label="Needs setup" rows={data.needsSetup} rowKey={(r) => `${r.reason}-${r.materialId}`} empty="Every used item has reorder settings and an approved vendor"
              columns={[
                { key: "m", header: "Item", cell: (r) => <span><span className="font-medium text-ink-900">{r.name}</span> <span className="text-xs text-ink-500">{r.sku}</span></span> },
                { key: "why", header: "Needs", cell: (r) => (r.reason === "NO_REORDER_SETTINGS" ? "A reorder level, minimum or par level" : <>An approved vendor{r.blockedVendorNote ? ` (${r.blockedVendorNote})` : ""}</>) },
                { key: "u", header: "Used in window", numeric: true, cell: (r) => formatQty(r.usedInWindow) },
                { key: "oh", header: "On hand", numeric: true, cell: (r) => formatQty(r.onHand) },
                { key: "go", header: "", cell: (r) => (r.reason === "NO_REORDER_SETTINGS" ? <Link href={`/master/materials/${r.materialId}`} className="text-brand-600 hover:underline">Set levels →</Link> : <Link href="/master/vendors" className="text-brand-600 hover:underline">Vendors →</Link>) },
              ]} />
          )}
          {dialog === "po" && (
            <RaisePODialog data={data} rows={poLines} edits={edits} skipped={noVendorSelected} onClose={() => setDialog(null)} onError={onRaiseError}
              onDone={(pos) => { setRaised(pos.map((p) => ({ href: `/procurement/purchase-orders/${p.id}`, label: p.number }))); toast.show(`${pos.length} draft purchase order${pos.length === 1 ? "" : "s"} raised`, "ok"); q.reload(); }} />
          )}
          {dialog === "indent" && (
            <RaiseIndentDialog data={data} rows={selected} edits={edits} onClose={() => setDialog(null)} onError={onRaiseError}
              onDone={(ind) => { setRaised([{ href: `/procurement/indents/${ind.id}`, label: ind.number }]); toast.show("Draft purchase request raised", "ok"); q.reload(); }} />
          )}
        </>
      )}
    </>
  );
}

type RaisedPO = { id: string; number: string; vendorId: string; total: string };

/** One DRAFT PO per vendor; the summary shows exactly what will be created. */
function RaisePODialog({ data, rows, edits, skipped, onClose, onError, onDone }: { data: ReorderData; rows: ReorderRow[]; edits: Record<string, Edit>; skipped: number; onClose: () => void; onError: (e: unknown) => never | void; onDone: (pos: RaisedPO[]) => void }) {
  const [submitKeyed] = useState(() => createKeyedSubmitter("reorder-po"));
  const [notes, setNotes] = useState("");
  const vendorName = (r: ReorderRow, id: string) => r.alternatives.find((a) => a.vendorId === id)?.name ?? id;
  const byVendor = new Map<string, { name: string; lines: number; total: number }>();
  for (const r of rows) {
    const e = edits[r.materialId];
    const g = byVendor.get(e.vendorId) ?? { name: vendorName(r, e.vendorId), lines: 0, total: 0 };
    g.lines++;
    g.total += (toNum(e.qty) || 0) * (toNum(e.rate) || 0);
    byVendor.set(e.vendorId, g);
  }
  return (
    <FormDialog open onClose={onClose} title="Raise purchase orders" size="lg" submitLabel={`Create ${byVendor.size} draft PO${byVendor.size === 1 ? "" : "s"}`}
      description="Draft purchase orders, one per vendor. Nothing is submitted, approved or ordered yet."
      onSubmit={() => {
        const body = {
          outletId: data.outletId, asOf: data.asOf, lookbackDays: data.lookbackDays, notes: opt(notes),
          lines: rows.map((r) => {
            const e = edits[r.materialId];
            const rate = toNum(e.rate);
            return { materialId: r.materialId, vendorId: e.vendorId, qty: toNum(e.qty), unitId: r.order.unitId, ...(Number.isFinite(rate) && rate > 0 ? { rate } : {}), expectedIncoming: r.incoming };
          }),
        };
        return submitKeyed(body, (idempotencyKey) => api<{ purchaseOrders: RaisedPO[] }>("/api/procurement/reorder/purchase-orders", { method: "POST", body, idempotencyKey })).catch(onError) as Promise<{ purchaseOrders: RaisedPO[] }>;
      }}
      onDone={(r) => onDone(r.purchaseOrders)}>
      <table className="w-full text-sm" aria-label="Purchase orders to create">
        <thead><tr className="text-left text-xs uppercase text-ink-500"><th>Vendor</th><th className="text-right">Lines</th><th className="text-right">Total (before tax)</th></tr></thead>
        <tbody>{[...byVendor.entries()].map(([id, g]) => <tr key={id}><td>{g.name}</td><td className="text-right tabular-nums">{g.lines}</td><td className="text-right tabular-nums">{formatMoney(g.total)}</td></tr>)}</tbody>
      </table>
      {skipped > 0 && <p className="text-xs text-warn-700">{skipped} selected item{skipped === 1 ? " has" : "s have"} no vendor and {skipped === 1 ? "is" : "are"} left out; raise a purchase request for {skipped === 1 ? "it" : "them"}.</p>}
      <Field label="Notes" name="notes"><Textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Raised from the reorder screen" /></Field>
    </FormDialog>
  );
}

type RaisedIndent = { id: string; number: string };

function RaiseIndentDialog({ data, rows, edits, onClose, onError, onDone }: { data: ReorderData; rows: ReorderRow[]; edits: Record<string, Edit>; onClose: () => void; onError: (e: unknown) => never | void; onDone: (indent: RaisedIndent) => void }) {
  const [submitKeyed] = useState(() => createKeyedSubmitter("reorder-ind"));
  const departments = useDepartments(data.outletId);
  const [departmentId, setDepartmentId] = useState("");
  const [notes, setNotes] = useState("");
  return (
    <FormDialog open onClose={onClose} title="Raise purchase request" submitLabel="Create draft request"
      description={`A DRAFT purchase request (indent) for ${rows.length} item${rows.length === 1 ? "" : "s"}; a manager approves it before a PO is raised.`}
      onSubmit={() => {
        const body = {
          outletId: data.outletId, asOf: data.asOf, lookbackDays: data.lookbackDays, departmentId: opt(departmentId), notes: opt(notes),
          lines: rows.map((r) => ({ materialId: r.materialId, qty: toNum(edits[r.materialId].qty), unitId: r.order.unitId, expectedIncoming: r.incoming })),
        };
        return submitKeyed(body, (idempotencyKey) => api<{ indent: RaisedIndent }>("/api/procurement/reorder/indents", { method: "POST", body, idempotencyKey })).catch(onError) as Promise<{ indent: RaisedIndent }>;
      }}
      onDone={(r) => onDone(r.indent)}>
      <Field label="Requesting department" name="departmentId">
        <Select value={departmentId} onChange={(e) => setDepartmentId(e.target.value)}>
          <option value="">Whole outlet</option>
          {(departments.data ?? []).filter((d) => d.active).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
        </Select>
      </Field>
      <Field label="Notes" name="notes"><Textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Raised from the reorder screen" /></Field>
    </FormDialog>
  );
}
