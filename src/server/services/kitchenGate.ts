/**
 * Online-payment kitchen gate for guest QR orders.
 *
 * A guest's own QR order (placed from the table QR: source QR, no staff
 * creator) reaches the kitchen only once verified gateway payments cover its
 * total. Every kitchen ticket is created by kot.createKOTsForOrder, which calls
 * assertKitchenReleasableTx: POS accept / submit, captain rounds and fire,
 * desktop Cloud Sync acceptance and the prepaid dispatch in
 * payment.verifyPayment all pass through it, so hiding a button is never the
 * only protection. There is deliberately no override: a staff member cannot
 * release an unpaid guest QR order, and counter payments (cash, card terminal,
 * till UPI — attested by staff, not verified by a bank) cannot settle one that
 * is still waiting for its online payment (assertCounterPaymentAllowed).
 *
 * "Verified" means a Payment that a gateway confirmed: SUCCESS or PARTIAL
 * (partly refunded, still counted at full amount as in the settlement rule),
 * provider in GATEWAY_PROVIDERS, and verifiedAt set by payment.verifyPayment.
 *
 * A payment verified after the fulfilment window does not release the order
 * by itself (payment.verifyPayment holds it for staff); a member of staff may
 * then send it (the gate passes: it is paid) or refund it.
 */
import type { Prisma } from "@prisma/client";
import { ValidationError } from "@/server/db/scope";
import { GATEWAY_PROVIDERS } from "@/integrations/payment";
import { D, money } from "@/domain/money";

type Tx = Prisma.TransactionClient;

export const ONLINE_PAYMENT_REQUIRED = "ONLINE_PAYMENT_REQUIRED";

/** A guest placed it from the table QR (staff-created orders always carry createdById). */
export function isGuestQrOrder(order: { source: string; createdById: string | null }): boolean {
  return order.source === "QR" && order.createdById === null;
}

/** A guest QR order not yet sent to the kitchen: it is waiting for the guest's online payment, not for staff. */
export function isAwaitingOnlinePayment(order: { source: string; createdById: string | null; status: string }): boolean {
  return isGuestQrOrder(order) && order.status === "OPEN";
}

/**
 * Fulfilment window for prepaid guest QR orders (GUEST_FULFILMENT_WINDOW_MINUTES,
 * default 10, 1-240). A verified payment that reaches RESTORA later than this
 * after the order was placed is recorded (the money is the guest's and is
 * shown as received), but the order is NOT sent to the kitchen automatically:
 * the guest may have left or ordered again. It is held for staff, who either
 * send it to the kitchen (POS: Send — kot gate passes, the order settles) or
 * refund it, and a HIGH reconciliation anomaly is raised. The age is measured
 * from order placement to the moment RESTORA verifies the payment.
 */
export const DEFAULT_FULFILMENT_WINDOW_MINUTES = 10;
export function fulfilmentWindowMs(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.GUEST_FULFILMENT_WINDOW_MINUTES);
  return (Number.isInteger(n) && n >= 1 && n <= 240 ? n : DEFAULT_FULFILMENT_WINDOW_MINUTES) * 60_000;
}
export function isPastFulfilmentWindow(order: { createdAt: Date }, now = new Date()): boolean {
  return now.getTime() - order.createdAt.getTime() > fulfilmentWindowMs();
}

/** Money verified by a gateway for this order (never staff-attested counter payments). */
export async function verifiedOnlineTotalTx(tx: Tx, orderId: string): Promise<Prisma.Decimal> {
  const paid = await tx.payment.aggregate({
    where: { orderId, status: { in: ["SUCCESS", "PARTIAL"] }, provider: { in: [...GATEWAY_PROVIDERS] }, verifiedAt: { not: null } },
    _sum: { amount: true },
  });
  return D(paid._sum.amount ?? 0);
}

/**
 * Refuse kitchen tickets for a guest QR order whose total is not yet covered by
 * verified online payments. Staff orders are never gated. Runs inside the
 * transaction that would create the tickets, so a payment verified concurrently
 * is either committed (and counted) or the transaction is retried.
 */
export async function assertKitchenReleasableTx(tx: Tx, order: { id: string; source: string; createdById: string | null; total: Prisma.Decimal | number | string }): Promise<void> {
  if (!isGuestQrOrder(order)) return;
  const verified = await verifiedOnlineTotalTx(tx, order.id);
  if (verified.gte(D(order.total))) return;
  throw new ValidationError(
    `This QR order is waiting for the guest's online payment (₹${money(D(order.total).minus(verified)).toFixed(2)} still due). It goes to the kitchen automatically once the payment is verified.`,
    { code: ONLINE_PAYMENT_REQUIRED },
  );
}

/** A guest QR order whose online payment is verified in full but which was held (late payment): staff decide. */
export async function isHeldForReviewTx(tx: Tx, order: { id: string; source: string; createdById: string | null; status: string; total: Prisma.Decimal | number | string }): Promise<boolean> {
  if (!isAwaitingOnlinePayment(order) || !D(order.total).gt(0)) return false;
  return (await verifiedOnlineTotalTx(tx, order.id)).gte(D(order.total));
}

/** Counter payments may not settle a guest QR order that is still waiting for its online payment. */
export function assertCounterPaymentAllowed(order: { source: string; createdById: string | null; status: string }, gatewayPayment: boolean): void {
  if (gatewayPayment || !isAwaitingOnlinePayment(order)) return;
  throw new ValidationError("This QR order is waiting for the guest's online payment and cannot be settled at the counter.", { code: ONLINE_PAYMENT_REQUIRED });
}
