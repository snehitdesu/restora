"use client";

/**
 * Order discount at the till: a coupon code the guest gives (the server prices it, checks every rule and counts the
 * use) and/or a manual amount. The manual amount is the order's TOTAL discount, including any coupon on it.
 */
import { useCallback, useEffect, useState } from "react";
import { api, describeError } from "@/lib/api/client";
import { formatMoney, toNumber } from "@/lib/format";
import type { OrderDTO } from "@/features/pos/types";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { useToast } from "@/components/ui/Toast";

type AppliedCoupon = { code: string; name: string; amount: number; stackable: boolean } | null;

export function DiscountDialog({ order, onClose, onChanged }: { order: OrderDTO; onClose: () => void; onChanged: () => Promise<unknown> }) {
  const toast = useToast();
  const [coupon, setCoupon] = useState<AppliedCoupon | undefined>(undefined);
  const [code, setCode] = useState("");
  const [amount, setAmount] = useState(String(toNumber(order.discount) || ""));
  const [busy, setBusy] = useState<"apply" | "remove" | "amount" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setCoupon((await api<{ coupon: AppliedCoupon }>(`/api/growth/orders/${order.id}/coupon`)).coupon);
    } catch {
      setCoupon(null); // no coupon support for this login: the manual amount still works
    }
  }, [order.id]);
  useEffect(() => { void load(); }, [load]);

  async function run(kind: "apply" | "remove" | "amount", fn: () => Promise<unknown>, done: string) {
    setBusy(kind);
    setError(null);
    try {
      await fn();
      await onChanged();
      toast.show(done, "ok");
      return true;
    } catch (e) {
      setError(describeError(e));
      return false;
    } finally {
      setBusy(null);
    }
  }
  const applyCode = async () => {
    if (await run("apply", () => api(`/api/growth/orders/${order.id}/coupon`, { method: "POST", body: { code: code.trim() } }), "Coupon applied")) {
      setCode("");
      await load();
    }
  };
  const removeCode = async () => {
    if (await run("remove", () => api(`/api/growth/orders/${order.id}/coupon/remove`, { method: "POST", body: {} }), "Coupon removed")) await load();
  };
  const applyAmount = async () => {
    if (await run("amount", () => api(`/api/orders/${order.id}/discount`, { method: "POST", body: { amount: Number(amount) || 0 } }), "Discount applied")) onClose();
  };

  return (
    <Dialog open onClose={onClose} title="Order discount" size="sm" footer={<Button variant="primary" onClick={applyAmount} loading={busy === "amount"} disabled={busy !== null && busy !== "amount"}>Apply</Button>}>
      <div className="space-y-4">
        {error && <p role="alert" className="rounded-md border border-bad-100 bg-bad-50 px-3 py-2 text-sm text-bad-700">{error}</p>}
        <section aria-label="Coupon">
          <h3 className="text-sm font-medium text-ink-700">Coupon</h3>
          {coupon ? (
            <div className="mt-1 flex items-center justify-between gap-3 rounded-md bg-paper-warm px-3 py-2 text-sm">
              <span><span className="font-mono font-semibold text-ink-900">{coupon.code}</span> <span className="text-ink-500">{coupon.name}</span><br />−{formatMoney(coupon.amount)}</span>
              <Button size="sm" onClick={removeCode} loading={busy === "remove"} disabled={busy !== null && busy !== "remove"}>Remove</Button>
            </div>
          ) : (
            <form className="mt-1 flex gap-2" onSubmit={(e) => { e.preventDefault(); if (code.trim()) void applyCode(); }}>
              <label className="sr-only" htmlFor="coupon-code">Coupon code</label>
              <input id="coupon-code" name="coupon" autoComplete="off" autoCapitalize="characters" value={code} onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))} placeholder="Code from the guest" maxLength={20} data-autofocus className="h-10 min-w-0 flex-1 rounded-md border border-ink-300 px-3 font-mono text-sm uppercase" />
              <Button type="submit" loading={busy === "apply"} disabled={!code.trim() || (busy !== null && busy !== "apply")}>Use code</Button>
            </form>
          )}
        </section>
        <div className="text-sm">
          <label htmlFor="discount-amount">Discount amount (₹)</label>
          <input id="discount-amount" name="discount" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ""))} aria-describedby="discount-amount-hint" className="mt-1 h-10 w-full rounded-md border border-ink-300 px-3 text-sm" />
          <span id="discount-amount-hint" className="mt-1 block text-xs text-ink-500">{coupon ? "The order's total discount, including the coupon above." : "A manual amount off the whole order."}</span>
        </div>
      </div>
    </Dialog>
  );
}
