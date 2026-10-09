"use client";

/**
 * Floor operations on the order open at a table (audit MB-03): move it to another table, merge another table's order into
 * it, split some of its lines onto a new bill. The server owns every rule (money already on the bill, coupons, billed
 * orders, permissions, tenants); this screen only offers the choices that can work and shows the server's reason when one
 * does not. The split is one keyed request: a double tap or a retry after a lost response returns the same new bill.
 */
import { useRef, useState } from "react";
import { api, ApiError, describeError } from "@/lib/api/client";
import { formatMoney, toNumber } from "@/lib/format";
import { newIdempotencyKey } from "@/lib/idempotency";
import { createSubmitGuard } from "@/features/pos/submitGuard";
import type { OrderDTO } from "@/features/pos/types";
import type { BoardTable } from "@/server/services/mobile";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Icon } from "@/components/ui/Icon";
import { useToast } from "@/components/ui/Toast";

type Mode = "move" | "merge" | "split" | null;
const ref = (id: string) => id.slice(-6).toUpperCase();

export function OrderActions({ order, table, tables, paid, onMoved, onChanged }: {
  order: OrderDTO;
  table: BoardTable;
  /** Every table of the outlet with its running orders (the board). */
  tables: BoardTable[];
  /** Money already taken on this order. */
  paid: number;
  /** The order now sits at another table. */
  onMoved: (tableId: string) => void | Promise<void>;
  /** The order or its neighbours changed (merge, split): refresh. `showOrderId` selects another bill at this table. */
  onChanged: (showOrderId?: string) => void | Promise<void>;
}) {
  const [mode, setMode] = useState<Mode>(null);
  const hasPayment = paid > 0.004;
  return (
    <section aria-label="Table actions" className="rounded-xl border border-ink-200 bg-paper p-3 shadow-card">
      <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-ink-500">Table actions</p>
      <div className="grid grid-cols-3 gap-2">
        <Button onClick={() => setMode("move")}><Icon name="table" /> Move</Button>
        <Button onClick={() => setMode("merge")} disabled={order.status === "BILLED"}><Icon name="plus" /> Merge</Button>
        <Button onClick={() => setMode("split")} disabled={hasPayment || order.items.length === 0}><Icon name="receipt" /> Split</Button>
      </div>
      {hasPayment && <p className="mt-2 text-xs text-ink-500">This bill already has a payment, so it cannot be split.</p>}
      {mode === "move" && <MoveDialog order={order} table={table} tables={tables} onClose={() => setMode(null)} onMoved={onMoved} />}
      {mode === "merge" && <MergeDialog order={order} tables={tables} onClose={() => setMode(null)} onChanged={onChanged} />}
      {mode === "split" && <SplitDialog order={order} onClose={() => setMode(null)} onChanged={onChanged} />}
    </section>
  );
}

function MoveDialog({ order, table, tables, onClose, onMoved }: { order: OrderDTO; table: BoardTable; tables: BoardTable[]; onClose: () => void; onMoved: (tableId: string) => void | Promise<void> }) {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const free = tables.filter((t) => t.id !== table.id && !t.order && t.status === "AVAILABLE");
  async function move(t: BoardTable) {
    if (busy) return;
    setBusy(t.id);
    try {
      await api(`/api/orders/${order.id}/transfer`, { method: "POST", body: { tableId: t.id } });
      toast.show(`Moved to table ${t.code}`, "ok");
      onClose();
      await onMoved(t.id);
    } catch (e) {
      toast.show(describeError(e), "bad");
    } finally {
      setBusy(null);
    }
  }
  return (
    <Dialog open onClose={onClose} title="Move to another table" description={`Order #${ref(order.id)} is at table ${table.code}. Its kitchen tickets follow it.`} footer={<Button size="lg" onClick={onClose}>Cancel</Button>}>
      {free.length === 0 ? <p className="py-4 text-center text-sm text-ink-500">No free table right now.</p> : (
        <ul className="grid grid-cols-3 gap-2" aria-label="Free tables">
          {free.map((t) => (
            <li key={t.id}>
              <Button size="lg" className="w-full" loading={busy === t.id} onClick={() => move(t)} aria-label={`Move to table ${t.code}`}>
                {t.code}<span className="ml-1 text-xs font-normal text-ink-500">{t.capacity}</span>
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}

function MergeDialog({ order, tables, onClose, onChanged }: { order: OrderDTO; tables: BoardTable[]; onClose: () => void; onChanged: (showOrderId?: string) => void | Promise<void> }) {
  const toast = useToast();
  const [chosen, setChosen] = useState<{ id: string; label: string; total: number } | null>(null);
  const [busy, setBusy] = useState(false);
  // Every other running order of the outlet that has not asked for its bill.
  const candidates = tables.flatMap((t) => [t.order ? { ...t.order, tableCode: t.code } : null, ...t.others.map((o) => ({ ...o, tableCode: t.code }))])
    .filter((o): o is NonNullable<typeof o> => o !== null && o.id !== order.id && o.status !== "BILLED");
  async function merge() {
    if (!chosen || busy) return;
    setBusy(true);
    try {
      await api(`/api/orders/${order.id}/merge`, { method: "POST", body: { fromOrderId: chosen.id } });
      toast.show(`Merged ${chosen.label} into this order`, "ok");
      onClose();
      await onChanged();
    } catch (e) {
      toast.show(describeError(e), "bad");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open onClose={onClose} title="Merge another order into this one" description="Its items and kitchen tickets come over; this bill carries the total." footer={
      <>
        <Button size="lg" onClick={chosen ? () => setChosen(null) : onClose}>{chosen ? "Back" : "Cancel"}</Button>
        {chosen && <Button size="lg" variant="primary" loading={busy} onClick={merge}>Merge</Button>}
      </>
    }>
      {chosen ? (
        <p className="py-2 text-sm" role="status">Merge <strong>{chosen.label}</strong> ({formatMoney(chosen.total)}) into order #{ref(order.id)}? The other order closes; its table is freed.</p>
      ) : candidates.length === 0 ? <p className="py-4 text-center text-sm text-ink-500">No other running order to merge.</p> : (
        <ul className="divide-y divide-ink-100" aria-label="Orders to merge">
          {candidates.map((o) => (
            <li key={o.id} className="flex items-center gap-2 py-2">
              <span className="min-w-0 flex-1 text-sm"><span className="font-semibold">Table {o.tableCode}</span> · #{ref(o.id)}</span>
              <span className="text-sm tabular-nums">{formatMoney(o.total)}</span>
              <Button size="sm" aria-label={`Merge table ${o.tableCode} order #${ref(o.id)}`} onClick={() => setChosen({ id: o.id, label: `table ${o.tableCode} · #${ref(o.id)}`, total: o.total })}>Merge</Button>
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}

function SplitDialog({ order, onClose, onChanged }: { order: OrderDTO; onClose: () => void; onChanged: (showOrderId?: string) => void | Promise<void> }) {
  const toast = useToast();
  const guard = useRef(createSubmitGuard(() => newIdempotencyKey("split")));
  const [take, setTake] = useState<Record<string, number>>({});
  const [guests, setGuests] = useState(1);
  const [busy, setBusy] = useState(false);
  const qtyOf = (i: OrderDTO["items"][number]) => toNumber(i.qty);
  const chosen = order.items.filter((i) => (take[i.id] ?? 0) > 0);
  const everything = order.items.every((i) => (take[i.id] ?? 0) >= qtyOf(i));
  const step = (i: OrderDTO["items"][number], delta: number) => setTake((t) => {
    const max = qtyOf(i);
    // A fractional quantity (0.5 kg) moves whole; whole quantities move one at a time.
    const next = Number.isInteger(max) ? Math.min(max, Math.max(0, (t[i.id] ?? 0) + delta)) : delta > 0 ? max : 0;
    return { ...t, [i.id]: next };
  });
  async function split() {
    if (!chosen.length || everything || busy) return;
    setBusy(true);
    const lines = chosen.map((i) => ({ orderItemId: i.id, ...((take[i.id] ?? 0) < qtyOf(i) ? { qty: take[i.id] } : {}) }));
    const result = await guard.current.run(JSON.stringify([order.id, lines, guests]), (key) =>
      api<{ order: OrderDTO }>(`/api/orders/${order.id}/split`, { method: "POST", idempotencyKey: key, body: { lines, covers: guests } }));
    setBusy(false);
    if (result.status === "busy") return;
    if (result.status === "error") {
      const e = result.error;
      return toast.show(e instanceof ApiError && e.kind === "network" ? "No connection — nothing was lost. Tap Split again; it will not be split twice." : describeError(e), "bad");
    }
    toast.show(`New bill #${ref(result.value.order.id)} · ${formatMoney(toNumber(result.value.order.total))}`, "ok");
    onClose();
    await onChanged(result.value.order.id);
  }
  return (
    <Dialog open onClose={onClose} title="Split the bill" description="Choose what goes on the new bill. Each bill is paid and invoiced on its own." footer={
      <>
        <Button size="lg" onClick={onClose}>Cancel</Button>
        <Button size="lg" variant="primary" disabled={!chosen.length || everything} loading={busy} onClick={split}>Split{chosen.length ? ` · ${chosen.length} item${chosen.length === 1 ? "" : "s"}` : ""}</Button>
      </>
    }>
      <ul className="divide-y divide-ink-100" aria-label="Items to move">
        {order.items.map((i) => {
          const n = take[i.id] ?? 0;
          return (
            <li key={i.id} className="flex items-center gap-2 py-2">
              <span className="min-w-0 flex-1 text-sm">{qtyOf(i)} × {i.name}</span>
              <Button size="sm" aria-label={`Fewer ${i.name} on the new bill`} disabled={n <= 0} onClick={() => step(i, -1)}><Icon name="minus" /></Button>
              <span className="w-8 text-center text-sm font-semibold tabular-nums" aria-label={`${i.name} on the new bill`}>{n}</span>
              <Button size="sm" aria-label={`More ${i.name} on the new bill`} disabled={n >= qtyOf(i)} onClick={() => step(i, 1)}><Icon name="plus" /></Button>
            </li>
          );
        })}
      </ul>
      <div className="mt-3 flex items-center gap-3" role="group" aria-label="Guests on the new bill">
        <span className="text-sm">Guests on the new bill</span>
        <Button size="sm" aria-label="Fewer guests on the new bill" disabled={guests <= 1} onClick={() => setGuests((g) => Math.max(1, g - 1))}><Icon name="minus" /></Button>
        <span className="w-6 text-center font-semibold tabular-nums">{guests}</span>
        <Button size="sm" aria-label="More guests on the new bill" disabled={guests >= Math.max(1, order.covers - 1)} onClick={() => setGuests((g) => g + 1)}><Icon name="plus" /></Button>
      </div>
      {everything && chosen.length > 0 && <p className="mt-2 text-sm text-warn-700" role="alert">Leave at least one item on this bill. To move everything, use Move.</p>}
    </Dialog>
  );
}
