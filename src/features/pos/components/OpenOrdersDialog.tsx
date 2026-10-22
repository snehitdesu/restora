"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api/client";
import { formatMoney, formatElapsed } from "@/lib/format";
import { fulfilmentStage, FULFILMENT_LABEL } from "@/domain/orderProgress";
import { Dialog } from "@/components/ui/Dialog";
import { Badge } from "@/components/ui/Badge";
import { LoadingState, ErrorState, EmptyState } from "@/components/ui/States";
import type { TableDTO } from "@/features/pos/types";
import { NO_TABLE_YET } from "@/features/kitchen/kds";
import { QrTablesPanel } from "./QrTablesPanel";

export type OpenOrder = { id: string; channel: string; source: string; status: string; total: string | number; createdAt: string; tableId: string | null; table?: { code: string } | null; customer?: { name: string } | null; kots?: Array<{ status: string }>; holdLabel?: string | null; heldAt?: string | null; heldForReview?: boolean };

/**
 * A guest's QR order not in the kitchen yet: it is waiting for the guest's online payment, and the server
 * refuses to send it to the kitchen or settle it at the counter before that (kitchenGate.ts).
 */
export const isIncomingQr = (o: { source?: string; status: string; heldForReview?: boolean }) => o.source === "QR" && o.status === "OPEN" && !o.heldForReview;

/**
 * A guest's QR order that IS paid online in full, but the payment was confirmed after the fulfilment window, so it
 * was not sent to the kitchen by itself. Staff decide: Send (it goes to the kitchen and the bill settles) or refund it.
 */
export const isPaidLateQr = (o: { source?: string; status: string; heldForReview?: boolean }) => o.source === "QR" && o.status === "OPEN" && Boolean(o.heldForReview);

/** A bill saved at the counter and not sent to the kitchen (the hold list). */
export const isHeld = (o: Pick<OpenOrder, "status" | "heldAt">) => o.status === "OPEN" && Boolean(o.heldAt);
/** A held bill nobody came back for this long is flagged: the guest has probably left. */
export const STALE_HOLD_MINUTES = 120;
const heldMinutes = (o: Pick<OpenOrder, "heldAt">, now = Date.now()) => (o.heldAt ? Math.max(0, Math.floor((now - new Date(o.heldAt).getTime()) / 60000)) : 0);

const where = (o: OpenOrder, tableCode: (id: string | null) => string | null) => {
  const table = o.table?.code ?? tableCode(o.tableId);
  if (table) return `Table ${table}`;
  // The restaurant's common QR carries no table: staff assign one (QR tables tab).
  if (o.source === "QR") return `QR · ${NO_TABLE_YET}`;
  return o.channel === "DINE_IN" ? "Table ?" : o.channel.replace("_", " ").toLowerCase();
};

/**
 * Orders at the outlet. "Open" = not yet paid or cancelled (GET /api/orders?active=true):
 * reopen to accept a QR order, add items or take payment. "Held" = bills saved at the
 * counter and not sent (GET /api/orders?held=true), oldest first, with the name they were
 * saved under. "Recent" = the latest orders in any state, to reopen a bill / reprint a receipt.
 */
export function OpenOrdersDialog({ outletId, tableCode, tables = [], onOpen, onClose }: { outletId: string; tableCode: (id: string | null) => string | null; tables?: TableDTO[]; onOpen: (orderId: string) => void; onClose: () => void }) {
  const [tab, setTab] = useState<"open" | "held" | "recent" | "qr">("open");
  const [qrOnly, setQrOnly] = useState(false);
  const [orders, setOrders] = useState<OpenOrder[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const load = useCallback(async () => {
    setError(null);
    setOrders(null);
    if (tab === "qr") return;
    try {
      setOrders((await api<{ items: OpenOrder[] }>("/api/orders", { query: { outletId, active: tab === "open" ? "true" : undefined, held: tab === "held" ? "true" : undefined, take: tab === "recent" ? 30 : 100 } })).items);
    } catch (e) {
      setError(e);
    }
  }, [outletId, tab]);
  useEffect(() => void load(), [load]);

  // Incoming QR orders first (oldest first: they have waited longest), then the rest newest first.
  // A guest paying at the counter is already in the kitchen (SENT…): still listed here, unpaid.
  const shown = orders && qrOnly ? orders.filter((o) => o.source === "QR") : orders;
  const first = (o: OpenOrder) => isPaidLateQr(o) || isIncomingQr(o);
  const sorted = shown && tab === "open" ? [...shown.filter(isPaidLateQr), ...shown.filter(isIncomingQr).reverse(), ...shown.filter((o) => !first(o))] : shown;

  return (
    <Dialog open onClose={onClose} title="Open orders" description={tab === "qr" ? "Guest QR orders and where to take them — assign a table to orders from the restaurant QR" : tab === "open" ? "Orders not yet paid or cancelled" : tab === "held" ? "Bills saved without sending them to the kitchen — pick one up where you left it" : "Latest orders — open a bill or reprint a receipt"} size="lg">
      <div role="tablist" aria-label="Order lists" className="mb-3 flex gap-2">
        {(["open", "held", "recent", "qr"] as const).map((t) => (
          <button key={t} type="button" role="tab" aria-selected={tab === t} onClick={() => setTab(t)} className={`h-9 rounded-md border px-3 text-sm font-medium ${tab === t ? "border-brand-600 bg-brand-50" : "border-ink-300 hover:bg-ink-100"}`}>
            {t === "open" ? "Open" : t === "held" ? "Held" : t === "recent" ? "Recent" : "QR tables"}
          </button>
        ))}
        {tab !== "qr" && <button type="button" aria-pressed={qrOnly} onClick={() => setQrOnly((v) => !v)} className={`ml-auto h-9 rounded-md border px-3 text-sm font-medium ${qrOnly ? "border-brand-600 bg-brand-50" : "border-ink-300 hover:bg-ink-100"}`}>
          QR orders only
        </button>}
      </div>
      {tab === "qr" ? (
        <QrTablesPanel outletId={outletId} tables={tables} />
      ) : error ? (
        <ErrorState error={error} onRetry={load} compact />
      ) : !sorted ? (
        <LoadingState />
      ) : sorted.length === 0 ? (
        <EmptyState title={qrOnly ? "No QR orders here" : tab === "open" ? "No open orders" : tab === "held" ? "No held bills" : "No orders yet"} hint={tab === "held" && !qrOnly ? "Save a bill from the till and it waits here." : undefined} />
      ) : (
        <ul className="divide-y divide-ink-100">
          {sorted.map((o) => {
            const stage = o.kots ? fulfilmentStage({ status: o.status, kots: o.kots }) : null;
            const closed = ["PAID", "CANCELLED", "REFUNDED"].includes(o.status);
            return (
              <li key={o.id} className="flex items-center gap-2">
                <button type="button" disabled={closed} onClick={() => onOpen(o.id)} className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1 px-2 py-2.5 text-left text-sm hover:bg-ink-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-500 disabled:cursor-default disabled:hover:bg-transparent">
                  <span className="font-mono text-ink-500">#{o.id.slice(-6).toUpperCase()}</span>
                  <span className="font-medium">{where(o, tableCode)}{o.customer?.name ? ` · ${o.customer.name}` : ""}</span>
                  {isIncomingQr(o) ? <Badge tone="warn">New QR order · awaiting online payment</Badge> : isPaidLateQr(o) ? <Badge tone="bad">QR · paid late · send or refund</Badge> : o.source === "QR" ? <Badge tone="neutral">{closed ? "QR" : "QR · unpaid"}</Badge> : null}
                  {isHeld(o) && <Badge tone={heldMinutes(o) >= STALE_HOLD_MINUTES ? "warn" : "neutral"}>Held{o.holdLabel ? ` · ${o.holdLabel}` : ""}{heldMinutes(o) >= STALE_HOLD_MINUTES ? " · old" : ""}</Badge>}
                  <Badge tone={o.status === "PAID" ? "ok" : o.status === "CANCELLED" ? "bad" : "info"}>{o.status}</Badge>
                  {stage && stage !== "AWAITING_ACCEPTANCE" && <span className="text-xs text-ink-600">{FULFILMENT_LABEL[stage]}</span>}
                  <span className="text-ink-500">{formatElapsed(o.createdAt)} ago</span>
                  <span className="ml-auto font-semibold tabular-nums">{formatMoney(o.total)}</span>
                </button>
                <a href={`/pos/bill/${o.id}`} className="shrink-0 rounded-md border border-ink-300 px-2 py-1 text-xs font-medium hover:bg-ink-100" aria-label={`Bill for order ${o.id.slice(-6).toUpperCase()}`}>
                  {o.status === "PAID" || o.status === "REFUNDED" ? "Receipt" : "Bill"}
                </a>
              </li>
            );
          })}
        </ul>
      )}
    </Dialog>
  );
}
