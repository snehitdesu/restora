"use client";

/**
 * Guest QR orders that staff may still need to seat (Open orders → QR tables).
 * An order from the restaurant's common QR arrives with no table: the guest sat
 * wherever they liked and never chose one. Staff find them here (no table first),
 * ask or look, and assign the table; a wrong one can be changed while the food is
 * still being prepared. The server owns every rule (orderOps.setOrderTable):
 * seating an order past the table's guest QR limits is refused once with the
 * numbers, and goes through only when staff choose "Assign anyway" (audited).
 */
import { useCallback, useEffect, useState } from "react";
import { api, ApiError, describeError } from "@/lib/api/client";
import { formatMoney, toNumber } from "@/lib/format";
import type { TableDTO } from "@/features/pos/types";
import { NO_TABLE_YET } from "@/features/kitchen/kds";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { useToast } from "@/components/ui/Toast";
import { TablePicker } from "./TablePicker";

export type QrTableOrder = {
  id: string;
  status: string;
  total: string | number;
  createdAt: string;
  notes: string | null;
  tableId: string | null;
  table: { code: string } | null;
  customer: { name: string } | null;
  kots: Array<{ status: string }>;
};

const ref = (id: string) => id.slice(-6).toUpperCase();

/** What the order is doing, in the counter's words. */
export function qrOrderStage(o: Pick<QrTableOrder, "status" | "kots">): string {
  if (o.status === "OPEN") return "waiting for the guest's payment";
  const open = o.kots.filter((k) => !["SERVED", "CANCELLED"].includes(k.status));
  if (o.status === "PAID" && open.length && open.every((k) => k.status === "READY")) return "paid · ready to serve";
  if (o.status === "PAID") return "paid · in the kitchen";
  return o.status.toLowerCase();
}

export function QrTablesPanel({ outletId, tables }: { outletId: string; tables: TableDTO[] }) {
  const toast = useToast();
  const [orders, setOrders] = useState<QrTableOrder[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [picking, setPicking] = useState<QrTableOrder | null>(null);
  const [overLimit, setOverLimit] = useState<{ order: QrTableOrder; table: TableDTO; message: string } | null>(null);
  const load = useCallback(async () => {
    setError(null);
    try {
      setOrders(await api<QrTableOrder[]>("/api/orders/qr-tables", { query: { outletId } }));
    } catch (e) {
      setError(e);
    }
  }, [outletId]);
  useEffect(() => void load(), [load]);

  async function assign(order: QrTableOrder, t: TableDTO, overrideGuestLimits = false) {
    setPicking(null);
    setOverLimit(null);
    try {
      // fromTableId: the table this list showed, so a colleague's change in the meantime is a conflict, not overwritten.
      await api(`/api/orders/${order.id}/table`, { method: "POST", body: { tableId: t.id, fromTableId: order.tableId, ...(overrideGuestLimits ? { overrideGuestLimits: true } : {}) } });
      toast.show(`Order #${ref(order.id)} → table ${t.code}`, "ok");
    } catch (e) {
      // Past the table's guest limits: staff decide, with the server's numbers in front of them.
      if (e instanceof ApiError && e.code === "TableGuestLimit") return setOverLimit({ order, table: t, message: e.message });
      toast.show(describeError(e), "bad");
    }
    await load();
  }

  if (error) return <p className="py-4 text-sm text-bad-700" role="alert">{describeError(error)}</p>;
  if (!orders) return <p className="py-4 text-sm text-ink-500">Loading…</p>;
  if (orders.length === 0) return <p className="py-4 text-center text-sm text-ink-500">No QR orders need a table right now.</p>;
  return (
    <>
      <ul className="divide-y divide-ink-100" aria-label="QR orders and their tables">
        {orders.map((o) => (
          <li key={o.id} className="flex items-center justify-between gap-3 py-2" data-testid="qr-table-row">
            <div className="min-w-0">
              <p className="text-sm font-medium">
                {o.table ? `Table ${o.table.code}` : <span className="rounded bg-warn-50 px-1.5 py-0.5 font-bold uppercase text-warn-700">{NO_TABLE_YET}</span>}
                <span className="ml-2 font-mono text-xs text-ink-500">#{ref(o.id)}</span>
                {o.customer?.name ? <span className="ml-2 text-ink-700">{o.customer.name}</span> : null}
              </p>
              <p className="text-xs text-ink-500">{formatMoney(toNumber(o.total))} · {qrOrderStage(o)}{o.notes ? ` · ${o.notes}` : ""}</p>
            </div>
            <Button size="sm" variant={o.table ? "secondary" : "primary"} onClick={() => setPicking(o)} aria-label={`${o.table ? "Change table of" : "Assign a table to"} order ${ref(o.id)}`}>
              {o.table ? "Change table" : "Assign table"}
            </Button>
          </li>
        ))}
      </ul>
      {picking && <TablePicker tables={tables} selectedId={picking.tableId} onSelect={(t) => assign(picking, t)} onClose={() => setPicking(null)} />}
      {overLimit && (
        <Dialog
          open
          size="sm"
          title={`Table ${overLimit.table.code} is over its guest limits`}
          onClose={() => setOverLimit(null)}
          footer={
            <>
              <Button variant="secondary" onClick={() => setOverLimit(null)}>Cancel</Button>
              <Button onClick={() => assign(overLimit.order, overLimit.table, true)}>Assign anyway</Button>
            </>
          }
        >
          <p className="text-sm">{overLimit.message}</p>
          <p className="mt-2 text-xs text-ink-500">Assigning anyway is recorded in the audit log under your name.</p>
        </Dialog>
      )}
    </>
  );
}
