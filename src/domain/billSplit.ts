/**
 * Splitting a bill between the people at a table, each paying from their own phone (audit QR-08).
 *
 * The guest says how many people the bill is split between. Everyone pays an equal part of what is still due, rounded down to the
 * paisa, and whoever pays last pays whatever is left, so the parts always add up to the bill and nobody is charged more than a
 * fair share. The figure is worked out on the server from the amount outstanding at that moment; the page only displays it.
 */
import { D, money, type Decimalish } from "@/domain/money";

export const MIN_SPLIT_PARTS = 2;
export const MAX_SPLIT_PARTS = 12;

export type SplitShare = {
  /** What the next person pays. */
  amount: string;
  /** How many people (including this one) have still to pay, never below 1. */
  remainingParts: number;
  /** True when this person pays everything that is left. */
  last: boolean;
};

/**
 * @param outstanding what is still due on the order
 * @param parts       how many people the bill is split between
 * @param sharesPaid  how many of them have already paid their part online
 */
export function splitShare(outstanding: Decimalish, parts: number, sharesPaid: number): SplitShare {
  if (!Number.isInteger(parts) || parts < MIN_SPLIT_PARTS || parts > MAX_SPLIT_PARTS) throw new RangeError(`The bill can be split between ${MIN_SPLIT_PARTS} and ${MAX_SPLIT_PARTS} people`);
  const due = money(outstanding);
  const remainingParts = Math.max(1, parts - Math.max(0, Math.floor(sharesPaid)));
  if (remainingParts === 1) return { amount: due.toFixed(2), remainingParts, last: true };
  // Rounded down: the last payer makes up the difference.
  const each = due.div(remainingParts).toDecimalPlaces(2, 1 /* ROUND_DOWN */);
  // Less than a paisa each: one person settles it rather than asking for a zero payment.
  if (each.lte(0)) return { amount: due.toFixed(2), remainingParts: 1, last: true };
  return { amount: D(each).toFixed(2), remainingParts, last: false };
}
