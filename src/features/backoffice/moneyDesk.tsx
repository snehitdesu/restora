"use client";

/**
 * Money desk (proposal module 06): close the day honestly. One page per outlet
 * business day with the three-way check (what the POS rang, what the manager
 * declared, what reached the bank), collections per payment method, deposits,
 * petty cash, the day's discrepancies and the close / reopen controls. All
 * figures come from the server (Decimal, exact to the paisa); the page only
 * sends what people enter. Printing the page gives the day-end Z-report.
 */
import { useState } from "react";
import { api } from "@/lib/api/client";
import { createKeyedSubmitter } from "@/lib/idempotency";
import { useQuery } from "@/lib/hooks/useApi";
import { useShell, useOutletId } from "@/lib/shellContext";
import { formatDate, formatDateTime, formatMoney, humanize, isoDay } from "@/lib/format";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { Badge } from "@/components/ui/Badge";
import { Field, FormAlert, FormDialog, Input, Select, Textarea, formError, opt } from "@/components/ui/Form";
import { DataTable } from "@/components/ui/Table";
import { Card, PageHeader, Stat, StatusBadge, SubNav } from "@/components/ui/Page";
import { ErrorState, LoadingState } from "@/components/ui/States";
import { ActionButton } from "@/components/ui/Confirm";
import { useToast } from "@/components/ui/Toast";
import { ManualSalesDialog } from "@/features/backoffice/kitchen";

type Channel = { key: string; label: string; orders: number; billed: number; declared: number | null; difference: number | null; note: string | null; aggregator: boolean; commissionPct: number | null; commission: number | null; commissionBasis: string | null; expectedPayout: number | null };
type Collection = { method: string; expected: number; declared: number | null; difference: number | null };
type BankRow = { method: string; expected: number; basis: string; deposited: number; gap: number };
type Deposit = { id: string; method: string; amount: number; depositedAt: string; reference: string; bankAccount: string | null; notes: string | null; status: string; voidReason: string | null; createdAt: string };
type CloseRow = { id: string; revision: number; status: string; closedAt: string; closedById: string | null; notes: string | null; reopenedAt: string | null; reopenedById: string | null; reopenReason: string | null };
type Discrepancy = { id: string; type: string; severity: string; status: string; message: string; detectedAt: string; resolutionNote: string | null };
export type MoneyDesk = {
  outletId: string; businessDate: string; timezone: string; status: "OPEN" | "CLOSED" | "REOPENED";
  pos: { orders: number; grossSales: number; discounts: number; tax: number; billed: number; refunds: number; refundCount: number; fullyDiscountedOrders: number; atMenuPrice: number; billedItems: number; menuPriceGap: number; unpricedLines: number };
  channels: Channel[]; declaredTotal: number | null; declaredDifference: number | null; commissionTotal: number;
  collections: Collection[];
  bank: { rows: BankRow[]; expected: number; deposited: number; gap: number; deposits: Deposit[] };
  pettyCash: { opening: number; inflow: number; outflow: number; closing: number; byCategory: Array<{ category: string; amount: number }>; monthToDate: { outflow: number; byCategory: Array<{ category: string; amount: number }> } };
  expenses: { total: number; count: number };
  drawers: { open: number; closedVariance: number };
  reconciliations: { payments: { id: string; status: string } | null; sales: { id: string; status: string } | null };
  unsettledOrders: number; blockers: string[]; readyToClose: boolean;
  closes: CloseRow[]; discrepancies: Discrepancy[];
  changedSinceClose: Array<{ figure: string; atClose: number | null; now: number | null }>;
};
type VendorDue = { vendorId: string; vendorName: string; openBills: number; due: number; overdue: number };

/** Vendor dues on the manager's page (proposal p. 9); the payment run is on the vendor payments screen. */
function VendorDuesCard() {
  const outletId = useOutletId();
  const q = useQuery<VendorDue[]>("/api/finance/vendor-dues", { outletId });
  const rows = (q.data ?? []).filter((r) => r.due > 0);
  return (
    <Card title="Vendor dues" actions={<a href="/procurement/payments" className="text-sm text-brand-600 hover:underline print:hidden">Payment run</a>}>
      {q.error ? <ErrorState error={q.error} onRetry={q.reload} compact /> : !q.data ? <LoadingState /> : rows.length === 0 ? <p className="text-sm text-ink-500">Nothing owed to vendors.</p> : (
        <ul className="flex flex-col gap-1.5 text-sm">
          {rows.slice(0, 6).map((r) => (
            <li key={r.vendorId} className="flex items-baseline justify-between gap-2">
              <span className="text-ink-900">{r.vendorName} <span className="text-xs text-ink-500">· {r.openBills} bill{r.openBills === 1 ? "" : "s"}</span></span>
              <span className="tabular-nums">{formatMoney(r.due)}{r.overdue > 0 && <span className="ml-1 text-xs font-semibold text-bad-600">{formatMoney(r.overdue)} overdue</span>}</span>
            </li>
          ))}
          {rows.length > 6 && <li className="text-xs text-ink-500">and {rows.length - 6} more</li>}
        </ul>
      )}
    </Card>
  );
}

type CloseHistory = { id: string; businessDate: string; revision: number; status: string; closedAt: string; billed: number; deposited: number; bankGap: number; reopenReason: string | null };

const CHANNEL_KEYS = ["DINE_IN", "TAKEAWAY", "DELIVERY", "ONLINE", "ZOMATO", "SWIGGY", "AGGREGATOR"];
const CHANNEL_LABELS: Record<string, string> = { DINE_IN: "Dine-in (incl. table QR)", TAKEAWAY: "Takeaway", DELIVERY: "Own delivery", ONLINE: "Own website", ZOMATO: "Zomato", SWIGGY: "Swiggy", AGGREGATOR: "Other aggregators" };

function FinanceTabs() {
  const { can } = useShell();
  const fv = !can("finance.view");
  return (
    <SubNav label="Finance" items={[
      { href: "/finance/money-desk", label: "Money desk", hidden: fv }, { href: "/finance", label: "Overview", hidden: fv }, { href: "/finance/payments", label: "Payments & refunds", hidden: fv },
      { href: "/finance/expenses", label: "Expenses", hidden: fv }, { href: "/finance/petty-cash", label: "Petty cash", hidden: fv && !can("finance.petty_cash") }, { href: "/finance/drawer", label: "Cash drawer", hidden: fv },
      { href: "/finance/reconciliation", label: "Reconciliation", hidden: fv },
    ]} />
  );
}

const METHOD_LABELS: Record<string, string> = { CASH: "Cash", UPI: "UPI", CARD: "Card", ONLINE: "Online (gateway)", WALLET: "Wallet", OTHER: "Other / aggregator", BANK: "Bank" };
const methodLabel = (m: string) => METHOD_LABELS[m] ?? humanize(m);

const gapTone = (v: number | null) => (v === null ? "" : v < 0 ? "font-semibold text-bad-600" : v > 0 ? "font-semibold text-warn-700" : "text-ok-600");
const Gap = ({ v }: { v: number | null }) => (v === null ? <span className="text-ink-400">—</span> : <span className={`tabular-nums ${gapTone(v)}`}>{v > 0 ? "+" : ""}{formatMoney(v)}</span>);

// ---------------- declared revenue ----------------

function DeclareCard({ d, editable, onSaved }: { d: MoneyDesk; editable: boolean; onSaved: () => void }) {
  const outletId = useOutletId();
  const toast = useToast();
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [extra, setExtra] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const listed = [...new Set([...d.channels.map((c) => c.key), ...extra])];
  // A day without sales still needs a declaration (zero) before it can close.
  const keys = listed.length ? listed : ["DINE_IN"];
  const val = (k: string) => draft[k] ?? (d.channels.find((c) => c.key === k)?.declared?.toString() ?? "");
  const addable = CHANNEL_KEYS.filter((k) => !keys.includes(k));
  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      const declared = keys.map((k) => ({ channel: k, amount: Number(val(k) || 0), note: opt(notes[k] ?? d.channels.find((c) => c.key === k)?.note ?? "") }));
      await api("/api/finance/money-desk/declare", { method: "POST", body: { outletId, businessDate: d.businessDate, declared } });
      toast.show("Declared revenue saved", "ok");
      setDraft({});
      onSaved();
    } catch (e) {
      setErr(formError(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card title="Revenue by channel" actions={d.reconciliations.sales && <StatusBadge status={d.reconciliations.sales.status} />}>
      <FormAlert message={err} />
      <div className="overflow-x-auto">
        <table className="w-full text-sm sm:min-w-max" aria-label="Revenue by channel">
          <thead>
            <tr className="border-b border-ink-200 text-left text-[11px] font-semibold uppercase tracking-eyebrow text-ink-600">
              <th scope="col" className="py-2 pr-3">Channel</th>
              <th scope="col" className="hidden py-2 pr-3 text-right sm:table-cell">Orders</th>
              <th scope="col" className="py-2 pr-3 text-right">POS rang</th>
              <th scope="col" className="py-2 pr-3 text-right">Declared</th>
              <th scope="col" className="py-2 pr-3 text-right">Difference</th>
              <th scope="col" className="hidden py-2 pr-3 text-right sm:table-cell">Commission</th>
              <th scope="col" className="hidden py-2 text-right sm:table-cell">Expected payout</th>
            </tr>
          </thead>
          <tbody>
            {keys.map((k) => {
              const c = d.channels.find((x) => x.key === k);
              return (
                <tr key={k} className="border-b border-ink-100">
                  <td className="py-2 pr-3 font-medium text-ink-900">{c?.label ?? CHANNEL_LABELS[k] ?? k}</td>
                  <td className="hidden py-2 pr-3 text-right tabular-nums sm:table-cell">{c?.orders ?? 0}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">{formatMoney(c?.billed ?? 0)}</td>
                  <td className="py-2 pr-3 text-right">
                    {editable ? (
                      <><div className="ml-auto w-24 sm:w-32 print:hidden"><Input className="text-right" type="number" inputMode="decimal" min="0" step="0.01" aria-label={`Declared ${c?.label ?? CHANNEL_LABELS[k]}`} value={val(k)} onChange={(e) => setDraft({ ...draft, [k]: e.target.value })} /></div><span className="hidden tabular-nums print:inline">{c?.declared === null || c?.declared === undefined ? "—" : formatMoney(c.declared)}</span></>
                    ) : <span className="tabular-nums">{c?.declared === null || c?.declared === undefined ? "—" : formatMoney(c.declared)}</span>}
                  </td>
                  <td className="py-2 pr-3 text-right"><Gap v={c?.difference ?? null} /></td>
                  <td className="hidden py-2 pr-3 text-right tabular-nums sm:table-cell">{c?.commission === null || c?.commission === undefined ? (c?.aggregator ? <span className="text-xs text-ink-500">rate not set</span> : "—") : <span title={c.commissionBasis === "recorded" ? "Recorded on the imported orders" : `${c.commissionPct}% stored commission`}>{formatMoney(c.commission)}</span>}</td>
                  <td className="hidden py-2 text-right tabular-nums sm:table-cell">{c?.expectedPayout === null || c?.expectedPayout === undefined ? "—" : formatMoney(c.expectedPayout)}</td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr className="font-semibold text-ink-900">
              <td className="py-2 pr-3">Total</td>
              <td className="hidden py-2 pr-3 text-right tabular-nums sm:table-cell">{d.pos.orders}</td>
              <td className="py-2 pr-3 text-right tabular-nums">{formatMoney(d.pos.billed)}</td>
              <td className="py-2 pr-3 text-right tabular-nums">{d.declaredTotal === null ? "—" : formatMoney(d.declaredTotal)}</td>
              <td className="py-2 pr-3 text-right"><Gap v={d.declaredDifference} /></td>
              <td className="hidden py-2 pr-3 text-right tabular-nums sm:table-cell">{formatMoney(d.commissionTotal)}</td>
              <td className="hidden py-2 sm:table-cell" />
            </tr>
          </tfoot>
        </table>
      </div>
      {editable && (
        <div className="mt-3 flex flex-wrap items-end justify-between gap-2 print:hidden">
          {addable.length > 0 ? (
            <label className="flex flex-col gap-0.5 text-xs text-ink-500">
              <span>Add a channel</span>
              <Select value="" onChange={(e) => e.target.value && setExtra([...extra, e.target.value])} aria-label="Add a sales channel" className="min-w-44">
                <option value="">Choose…</option>
                {addable.map((k) => <option key={k} value={k}>{CHANNEL_LABELS[k]}</option>)}
              </Select>
            </label>
          ) : <span />}
          <Button variant="primary" onClick={save} loading={busy}>Save declared revenue</Button>
        </div>
      )}
      <p className="mt-2 text-xs text-ink-500">Declared = the gross revenue per channel from your own records (counter sheet, aggregator app). A channel the POS billed but left blank is declared as zero. Negative difference: the POS rang more than was declared.</p>
      {editable && keys.some((k) => d.channels.find((c) => c.key === k)?.aggregator) && (
        <div className="mt-2 grid gap-2 sm:grid-cols-2 print:hidden">
          {keys.filter((k) => d.channels.find((c) => c.key === k)?.aggregator).map((k) => (
            <Field key={k} label={`Note for ${CHANNEL_LABELS[k] ?? k}`} name={`note-${k}`}>
              <Input value={notes[k] ?? d.channels.find((c) => c.key === k)?.note ?? ""} onChange={(e) => setNotes({ ...notes, [k]: e.target.value })} maxLength={300} placeholder="e.g. figure from the partner app" />
            </Field>
          ))}
        </div>
      )}
    </Card>
  );
}

// ---------------- collections ----------------

function CollectionsCard({ d, editable, onSaved }: { d: MoneyDesk; editable: boolean; onSaved: () => void }) {
  const outletId = useOutletId();
  const toast = useToast();
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const val = (m: string) => draft[m] ?? (d.collections.find((c) => c.method === m)?.declared?.toString() ?? "");
  // No payments taken: the drawer is still counted (normally zero) so the day can close.
  const rows: Collection[] = d.collections.length ? d.collections : [{ method: "CASH", expected: 0, declared: null, difference: null }];
  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api("/api/finance/reconciliations/daily", { method: "POST", body: { outletId, businessDate: d.businessDate, actuals: rows.map((c) => ({ method: c.method, actual: Number(val(c.method) || 0) })) } });
      toast.show("Counted money saved", "ok");
      setDraft({});
      onSaved();
    } catch (e) {
      setErr(formError(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card title="Money collected" actions={d.reconciliations.payments && <StatusBadge status={d.reconciliations.payments.status} />}>
      <FormAlert message={err} />
      {d.collections.length === 0 && <p className="mb-2 text-sm text-ink-500">No payments were taken on this day.{editable && " Count the cash drawer anyway (enter 0 if it is empty) so the day can be closed."}</p>}
      {(d.collections.length > 0 || editable) && (
        // A plain table like "Revenue by channel": on a phone the method wraps and the input stays on screen.
        <div className="overflow-x-auto">
          <table className="w-full text-sm sm:min-w-max" aria-label="Money collected per payment method">
            <thead>
              <tr className="border-b border-ink-200 text-left text-[11px] font-semibold uppercase tracking-eyebrow text-ink-600">
                <th scope="col" className="py-2 pr-3">Method</th>
                <th scope="col" className="py-2 pr-3 text-right">System</th>
                <th scope="col" className="py-2 pr-3 text-right">Counted / settled</th>
                <th scope="col" className="hidden py-2 text-right sm:table-cell">Difference</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.method} className="border-b border-ink-100">
                  <td className="py-2 pr-3 font-medium text-ink-900">{methodLabel(c.method)}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">{formatMoney(c.expected)}</td>
                  <td className="py-2 pr-3 text-right">
                    {editable ? (
                      <>
                        <div className="ml-auto w-24 sm:w-32 print:hidden"><Input className="text-right" type="number" inputMode="decimal" min="0" step="0.01" aria-label={`Counted ${methodLabel(c.method)}`} value={val(c.method)} onChange={(e) => setDraft({ ...draft, [c.method]: e.target.value })} /></div>
                        <span className="hidden tabular-nums print:inline">{c.declared === null ? "—" : formatMoney(c.declared)}</span>
                      </>
                    ) : <span className="tabular-nums">{c.declared === null ? "—" : formatMoney(c.declared)}</span>}
                  </td>
                  <td className="hidden py-2 text-right sm:table-cell"><Gap v={c.difference} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {editable && <div className="mt-3 flex justify-end print:hidden"><Button variant="primary" onClick={save} loading={busy}>Save counted money</Button></div>}
      <p className="mt-2 text-xs text-ink-500">System = payments recorded in RESTORA for the day, net of refunds. Counted = the cash in the drawer and the UPI / card settlement amounts.</p>
    </Card>
  );
}

// ---------------- bank ----------------

function DepositDialog({ day, onClose, onDone }: { day: string; onClose: () => void; onDone: () => void }) {
  const outletId = useOutletId();
  const { outlet } = useShell();
  const [submitKeyed] = useState(() => createKeyedSubmitter("dep"));
  const [method, setMethod] = useState("CASH");
  const [amount, setAmount] = useState("");
  const [when, setWhen] = useState(() => isoDay(new Date(), outlet?.timezone));
  const [reference, setReference] = useState("");
  const [account, setAccount] = useState("");
  const [notes, setNotes] = useState("");
  return (
    <FormDialog open onClose={onClose} title="Record money that reached the bank" submitLabel="Record"
      description={`For sales day ${formatDate(day)}: a cash deposit slip, or the UPI / card settlement credited for that day.`}
      onSubmit={() => {
        // A date-only deposit date is taken as the end of that day in the outlet's timezone at the latest "now".
        const at = when === isoDay(new Date(), outlet?.timezone) ? new Date() : new Date(`${when}T12:00:00`);
        const body = { outletId, businessDate: day, method, amount: Number(amount), depositedAt: at.toISOString(), reference, bankAccount: opt(account), notes: opt(notes) };
        return submitKeyed(body, (idempotencyKey) => api("/api/finance/money-desk/deposits", { method: "POST", body, idempotencyKey }));
      }} onDone={onDone}>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Type" name="method" required><Select value={method} onChange={(e) => setMethod(e.target.value)}><option value="CASH">Cash deposit</option><option value="UPI">UPI settlement</option><option value="CARD">Card settlement</option></Select></Field>
        <Field label="Amount" name="amount" required><Input type="number" inputMode="decimal" min="0" step="0.01" required value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
        <Field label="Date reached the bank" name="depositedAt" required><Input type="date" required min={day} max={isoDay(new Date(), outlet?.timezone)} value={when} onChange={(e) => setWhen(e.target.value)} /></Field>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Slip / UTR reference" name="reference" required><Input required minLength={2} maxLength={80} value={reference} onChange={(e) => setReference(e.target.value)} /></Field>
        <Field label="Bank account" name="bankAccount"><Input maxLength={60} value={account} onChange={(e) => setAccount(e.target.value)} placeholder="e.g. HDFC current ••4521" /></Field>
      </div>
      <Field label="Notes" name="notes"><Textarea maxLength={300} value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
    </FormDialog>
  );
}

function VoidDepositDialog({ deposit, onClose, onDone }: { deposit: Deposit; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState("");
  return (
    <FormDialog open onClose={onClose} danger title={`Void ${deposit.reference}?`} submitLabel="Void entry"
      description="The entry stays on record, marked void, and leaves the totals. Your password is asked for again."
      onSubmit={() => api(`/api/finance/money-desk/deposits/${deposit.id}/void`, { method: "POST", body: { reason } })} onDone={onDone}>
      <Field label="Reason" name="reason" required><Textarea required minLength={3} maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
    </FormDialog>
  );
}

function BankCard({ d, canWrite, onChanged }: { d: MoneyDesk; canWrite: boolean; onChanged: () => void }) {
  const { outlet } = useShell();
  const [adding, setAdding] = useState(false);
  const [voiding, setVoiding] = useState<Deposit | null>(null);
  return (
    <Card title="Reached the bank" actions={canWrite && <Button size="sm" onClick={() => setAdding(true)} className="print:hidden"><Icon name="plus" /> Record deposit</Button>}>
      <DataTable label="Expected against deposited, per method" rows={d.bank.rows} rowKey={(r) => r.method}
        columns={[
          { key: "m", header: "Method", cell: (r) => <span className="font-medium text-ink-900">{methodLabel(r.method)}</span> },
          { key: "e", header: "Expected", numeric: true, cell: (r) => <span title={r.basis === "counted" ? "From the counted figure" : "System figure (not counted yet)"}>{formatMoney(r.expected)}{r.basis === "system" && <span className="ml-1 text-xs text-ink-500">system</span>}</span> },
          { key: "d", header: "Deposited", numeric: true, cell: (r) => formatMoney(r.deposited) },
          { key: "g", header: "Gap", numeric: true, cell: (r) => <Gap v={r.gap} /> },
        ]}
        footer={<tr className="font-semibold"><td className="px-3.5 py-2">Total</td><td className="px-3.5 py-2 text-right tabular-nums">{formatMoney(d.bank.expected)}</td><td className="px-3.5 py-2 text-right tabular-nums">{formatMoney(d.bank.deposited)}</td><td className="px-3.5 py-2 text-right"><Gap v={d.bank.gap} /></td></tr>} />
      {d.bank.deposits.length > 0 && (
        <div className="mt-3">
          <DataTable label="Deposit entries" rows={d.bank.deposits} rowKey={(x) => x.id}
            columns={[
              { key: "r", header: "Reference", cell: (x) => <span className={x.status === "VOIDED" ? "text-ink-400 line-through" : "font-medium text-ink-900"}>{x.reference}</span> },
              { key: "m", header: "Type", cell: (x) => methodLabel(x.method) },
              { key: "a", header: "Amount", numeric: true, cell: (x) => formatMoney(x.amount) },
              { key: "t", header: "Reached bank", cell: (x) => formatDateTime(x.depositedAt, outlet?.timezone) },
              { key: "s", header: "Status", cell: (x) => (x.status === "VOIDED" ? <span title={x.voidReason ?? undefined}><Badge tone="neutral">Void</Badge></span> : <Badge tone="ok">Recorded</Badge>) },
              { key: "x", header: "", cell: (x) => (canWrite && x.status === "RECORDED" ? <Button size="sm" variant="ghost" className="print:hidden" onClick={() => setVoiding(x)}>Void</Button> : null) },
            ]} />
        </div>
      )}
      <p className="mt-2 text-xs text-ink-500">Expected to bank = cash + UPI + card, counted where entered. A deposit made after the day is closed is normal; record it here against this sales day.</p>
      {adding && <DepositDialog day={d.businessDate} onClose={() => setAdding(false)} onDone={onChanged} />}
      {voiding && <VoidDepositDialog deposit={voiding} onClose={() => setVoiding(null)} onDone={onChanged} />}
    </Card>
  );
}

// ---------------- close / reopen ----------------

function ReopenDialog({ day, onClose, onDone }: { day: string; onClose: () => void; onDone: () => void }) {
  const outletId = useOutletId();
  const [reason, setReason] = useState("");
  return (
    <FormDialog open onClose={onClose} danger title={`Reopen ${formatDate(day)}?`} submitLabel="Reopen day"
      description="The closed figures stay on record. Corrections become possible again and the day must be closed again. Your password is asked for again."
      onSubmit={() => api("/api/finance/money-desk/reopen", { method: "POST", body: { outletId, businessDate: day, reason } })} onDone={onDone}>
      <Field label="Why is the day being reopened?" name="reason" required><Textarea required minLength={5} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
    </FormDialog>
  );
}

export function MoneyDeskScreen() {
  const { can, outletId, outlet } = useShell();
  const today = isoDay(new Date(), outlet?.timezone);
  const [day, setDay] = useState(today);
  const [reopening, setReopening] = useState(false);
  const [selling, setSelling] = useState(false);
  const menu = useQuery<Array<{ id: string; name: string; active: boolean; station: string }>>(selling ? "/api/menu" : null, { activeOnly: "true" });
  const [closeNotes, setCloseNotes] = useState("");
  const q = useQuery<MoneyDesk>(outletId ? "/api/finance/money-desk" : null, { outletId: outletId ?? undefined, businessDate: day });
  const history = useQuery<CloseHistory[]>(outletId ? "/api/finance/money-desk/closes" : null, { outletId: outletId ?? undefined });
  const canWrite = can("finance.reconcile");
  const reload = () => { q.reload(); history.reload(); };
  const d = q.data;
  const editable = Boolean(d && canWrite && d.status !== "CLOSED" && day <= today);
  const closeRow = d?.closes[0];
  return (
    <>
      <PageHeader title="Money desk" subtitle="What the POS rang, what was declared and what reached the bank, for one business day"
        badge={d && (d.status === "CLOSED" ? <Badge tone="ok">Closed · revision {closeRow?.revision}</Badge> : d.status === "REOPENED" ? <Badge tone="warn">Reopened</Badge> : <Badge tone="info">Open</Badge>)}
        actions={d && (
          <div className="flex flex-wrap gap-2 print:hidden">
            {(can("order.create") || can("inventory.produce")) && d.status !== "CLOSED" && day <= today && <Button onClick={() => setSelling(true)}><Icon name="note" /> Log dish sales</Button>}
            <Button onClick={() => window.print()}><Icon name="receipt" /> Print day report</Button>
            {canWrite && d.status === "CLOSED" && <Button variant="danger" onClick={() => setReopening(true)}>Reopen day</Button>}
          </div>
        )} />
      <div className="print:hidden"><FinanceTabs /></div>
      <div className="mb-3 flex flex-wrap items-end gap-3 print:hidden">
        <label className="flex flex-col gap-0.5 text-xs text-ink-500">
          <span>Business date</span>
          <Input type="date" value={day} max={today} onChange={(e) => e.target.value && setDay(e.target.value)} />
        </label>
      </div>
      {q.error ? <ErrorState error={q.error} onRetry={q.reload} /> : !d ? <LoadingState /> : (
        <div className="flex flex-col gap-4">
          <p className="hidden text-sm print:block">{outlet?.name} · business day {formatDate(d.businessDate)} · printed {formatDateTime(new Date().toISOString(), outlet?.timezone)}</p>
          {d.status === "CLOSED" && d.changedSinceClose.length > 0 && (
            <div role="alert" className="rounded-md border border-warn-200 bg-warn-50 p-3 text-sm text-warn-800">
              <p className="font-semibold">Changed since the day was closed</p>
              <ul className="mt-1 list-disc pl-5">{d.changedSinceClose.map((c) => <li key={c.figure}>{c.figure}: {c.figure === "Orders" ? c.atClose : formatMoney(c.atClose)} at close, now {c.figure === "Orders" ? c.now : formatMoney(c.now)}</li>)}</ul>
              <p className="mt-1 text-xs">Orders and deposits are never blocked. Reopen the day to bring the closed figures up to date.</p>
            </div>
          )}
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
            <Stat label="POS rang" value={formatMoney(d.pos.billed)} hint={`${d.pos.orders} settled orders`} />
            <Stat label="Declared" value={d.declaredTotal === null ? "—" : formatMoney(d.declaredTotal)} hint={d.declaredTotal === null ? "not declared yet" : <Gap v={d.declaredDifference} />} />
            <Stat label="Expected to bank" value={formatMoney(d.bank.expected)} hint="cash + UPI + card" />
            <Stat label="Reached the bank" value={formatMoney(d.bank.deposited)} />
            <Stat label="Bank gap" value={<Gap v={d.bank.gap} />} tone={d.bank.gap < 0 ? "bad" : undefined} />
          </div>

          <DeclareCard key={`decl-${d.businessDate}-${d.reconciliations.sales?.status}`} d={d} editable={editable} onSaved={reload} />
          <CollectionsCard key={`col-${d.businessDate}-${d.reconciliations.payments?.status}`} d={d} editable={editable} onSaved={reload} />
          <BankCard d={d} canWrite={canWrite && day <= today} onChanged={reload} />
          <div className="grid gap-4 lg:grid-cols-2">
            <Card title="Cross-check against the menu">
              <dl className="flex flex-col gap-1.5 text-sm">
                <div className="flex justify-between gap-2"><dt className="text-ink-600">Items at today&apos;s menu price (ex tax)</dt><dd className="tabular-nums">{formatMoney(d.pos.atMenuPrice)}</dd></div>
                <div className="flex justify-between gap-2"><dt className="text-ink-600">Items as billed (ex tax)</dt><dd className="tabular-nums">{formatMoney(d.pos.billedItems)}</dd></div>
                <div className="flex justify-between gap-2 border-t border-ink-100 pt-1.5"><dt className="font-medium text-ink-900">Sold below / above menu price</dt><dd><Gap v={d.pos.menuPriceGap} /></dd></div>
                <div className="flex justify-between gap-2"><dt className="text-ink-600">Bill discounts</dt><dd className="tabular-nums">{formatMoney(d.pos.discounts)}</dd></div>
                <div className="flex justify-between gap-2"><dt className="text-ink-600">Refunds ({d.pos.refundCount})</dt><dd className="tabular-nums">{formatMoney(d.pos.refunds)}</dd></div>
                <div className="flex justify-between gap-2"><dt className="text-ink-600">Fully discounted orders</dt><dd className="tabular-nums">{d.pos.fullyDiscountedOrders}</dd></div>
                <div className="flex justify-between gap-2"><dt className="text-ink-600">Tax billed</dt><dd className="tabular-nums">{formatMoney(d.pos.tax)}</dd></div>
              </dl>
              {d.pos.unpricedLines > 0 && <p className="mt-2 text-xs text-ink-500">{d.pos.unpricedLines} line(s) were not menu items and count at their billed price.</p>}
            </Card>
            <Card title="Petty cash and spending">
              <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm">
                <dt className="text-ink-600">Opening</dt><dd className="text-right tabular-nums">{formatMoney(d.pettyCash.opening)}</dd>
                <dt className="text-ink-600">Added</dt><dd className="text-right tabular-nums">{formatMoney(d.pettyCash.inflow)}</dd>
                <dt className="text-ink-600">Spent</dt><dd className="text-right tabular-nums">{formatMoney(d.pettyCash.outflow)}</dd>
                <dt className="font-medium text-ink-900">Closing</dt><dd className="text-right font-semibold tabular-nums">{formatMoney(d.pettyCash.closing)}</dd>
                <dt className="text-ink-600">Expenses ({d.expenses.count})</dt><dd className="text-right tabular-nums">{formatMoney(d.expenses.total)}</dd>
                <dt className="text-ink-600">Drawer variance</dt><dd className="text-right"><Gap v={d.drawers.closedVariance} /></dd>
                <dt className="text-ink-600">Petty cash spent this month</dt><dd className="text-right tabular-nums">{formatMoney(d.pettyCash.monthToDate.outflow)}</dd>
              </dl>
              {d.pettyCash.byCategory.length > 0 && (
                <ul className="mt-3 flex flex-wrap gap-2" aria-label="Petty cash spent today by category">
                  {d.pettyCash.byCategory.map((c) => <li key={c.category}><Badge tone="neutral">{humanize(c.category)} · {formatMoney(c.amount)}</Badge></li>)}
                </ul>
              )}
              {d.pettyCash.monthToDate.byCategory.length > 0 && (
                <p className="mt-2 text-xs text-ink-500">This month: {d.pettyCash.monthToDate.byCategory.map((c) => `${humanize(c.category)} ${formatMoney(c.amount)}`).join(" · ")}</p>
              )}
            </Card>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card title="Discrepancies" actions={<a href="/anomalies" className="text-sm text-brand-600 hover:underline print:hidden">All anomalies</a>}>
              {d.discrepancies.length === 0 ? <p className="text-sm text-ink-500">{d.status === "OPEN" ? "Raised when the day is closed." : "None for this day."}</p> : (
                <ul className="flex flex-col gap-2">
                  {d.discrepancies.map((x) => (
                    <li key={x.id} className="flex items-start justify-between gap-3 text-sm">
                      <span>{x.message}{x.resolutionNote && <span className="block text-xs text-ink-500">{x.resolutionNote}</span>}</span>
                      <span className="flex shrink-0 gap-1"><StatusBadge status={x.severity} /><StatusBadge status={x.status} /></span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
            {can("finance.view") && <VendorDuesCard />}
          </div>
          {d.status !== "CLOSED" && canWrite && (
            <Card title="Close the day">
              {d.blockers.length > 0 ? (
                <div role="note" className="text-sm">
                  <p className="font-medium text-ink-900">Not ready to close:</p>
                  <ul className="mt-1 list-disc pl-5 text-ink-700">{d.blockers.map((b) => <li key={b}>{b}</li>)}</ul>
                </div>
              ) : <p className="text-sm text-ink-700">Everything is counted and declared. Closing locks the day; differences beyond ₹1 become discrepancies to review.</p>}
              <div className="mt-3 flex flex-wrap items-end gap-2 print:hidden">
                <div className="min-w-64 flex-1"><Field label="Closing note" name="closeNotes"><Input maxLength={500} value={closeNotes} onChange={(e) => setCloseNotes(e.target.value)} /></Field></div>
                <ActionButton variant="primary" disabled={!d.readyToClose} action={() => api("/api/finance/money-desk/close", { method: "POST", body: { outletId, businessDate: d.businessDate, notes: opt(closeNotes) } })}
                  confirm={{ title: `Close ${formatDate(d.businessDate)}?`, message: "The day's figures are frozen and the day is locked. Corrections need the day to be reopened, with a reason." }}
                  success="Day closed" onDone={() => { setCloseNotes(""); reload(); }}>Close day</ActionButton>
              </div>
            </Card>
          )}
          {d.closes.length > 0 && (
            <Card title="Close history for this day">
              <ul className="flex flex-col gap-1.5 text-sm">
                {d.closes.map((c) => (
                  <li key={c.id}>
                    <span className="font-medium text-ink-900">Revision {c.revision}</span> · closed {formatDateTime(c.closedAt, outlet?.timezone)}{c.notes ? ` · “${c.notes}”` : ""}
                    {c.status === "REOPENED" && <span className="text-warn-700"> · reopened {formatDateTime(c.reopenedAt, outlet?.timezone)}: {c.reopenReason}</span>}
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>
      )}
      <div className="mt-6 print:hidden">
        <h2 className="mb-2 text-sm font-semibold text-ink-900">Recent closes</h2>
        <DataTable label="Recent day closes" rows={history.data ?? []} rowKey={(h) => h.id} loading={history.loading} error={history.error} onRetry={history.reload} empty="No day closed yet"
          onRowClick={(h) => setDay(h.businessDate)}
          columns={[
            { key: "d", header: "Business date", cell: (h) => formatDate(h.businessDate) },
            { key: "r", header: "Revision", numeric: true, cell: (h) => h.revision },
            { key: "s", header: "Status", cell: (h) => <StatusBadge status={h.status} /> },
            { key: "b", header: "POS rang", numeric: true, cell: (h) => formatMoney(h.billed) },
            { key: "dep", header: "Deposited", numeric: true, cell: (h) => formatMoney(h.deposited) },
            { key: "g", header: "Bank gap", numeric: true, cell: (h) => <Gap v={h.bankGap} /> },
          ]} />
      </div>
      {reopening && d && <ReopenDialog day={d.businessDate} onClose={() => setReopening(false)} onDone={reload} />}
      {selling && d && menu.data && <ManualSalesDialog day={d.businessDate} items={menu.data} onClose={() => setSelling(false)} onDone={reload} />}
    </>
  );
}
