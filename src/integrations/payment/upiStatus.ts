/**
 * The decision every direct-bank UPI adapter makes from a transaction-status
 * answer: is this OUR payment, for the exact amount, in INR, and finally
 * successful? Shared by the test emulator adapter (upiEmulator.ts) and, once
 * SBI's specification is available, the SBI adapter (sbiUpi.ts), so the rules
 * cannot drift between them.
 *
 *  - success only on a FINAL success status, and only when merchant, our
 *    transaction reference, amount (in paise, exact) and currency (INR) all match;
 *  - a final success that does NOT match is never a success: it is reported as
 *    `mismatch` (the payment stays PENDING and staff are alerted — money may
 *    have moved, so it is neither paid nor failed);
 *  - a final failure / expiry is a definitive failure;
 *  - anything else (pending, deemed, unknown, a status we have never seen) is
 *    undecided: the payment stays PENDING.
 */
import type { VerifyResult } from "./types";

/** A bank transaction as the bank reported it, normalized by the adapter (amounts in paise). */
export type ObservedUpiTxn = { reference: string; merchantId: string; amountPaise: number; currency: string; status: string; bankRef?: string | null };
export type ExpectedUpiTxn = { reference: string; merchantId: string; amountPaise: number };
/** Which of the bank's status values are final. Everything not listed is undecided. */
export type UpiStatusVocabulary = { success: readonly string[]; failure: readonly string[] };

export const UPI_CURRENCY = "INR";

export function decideUpiTxn(expected: ExpectedUpiTxn, observed: ObservedUpiTxn, vocab: UpiStatusVocabulary): VerifyResult {
  const status = observed.status.trim().toUpperCase();
  if (vocab.success.includes(status)) {
    const problem =
      observed.reference !== expected.reference ? "transaction reference does not match" :
      observed.merchantId !== expected.merchantId ? "merchant does not match" :
      observed.currency.toUpperCase() !== UPI_CURRENCY ? `currency is ${observed.currency}, not INR` :
      !Number.isInteger(observed.amountPaise) || observed.amountPaise !== expected.amountPaise ? `amount ₹${(observed.amountPaise / 100).toFixed(2)} does not match ₹${(expected.amountPaise / 100).toFixed(2)}` :
      null;
    if (problem) return { verified: false, pending: true, mismatch: problem, reason: `Bank reported success but ${problem}` };
    return { verified: true, providerRef: expected.reference, bankRef: observed.bankRef ?? undefined };
  }
  if (vocab.failure.includes(status)) {
    // A failure for another reference is not a failure of ours.
    if (observed.reference !== expected.reference) return { verified: false, pending: true, reason: "Status answer is for another transaction" };
    return { verified: false, reason: `Bank status ${status}` };
  }
  return { verified: false, pending: true, reason: `Bank status ${status || "unknown"}` };
}

export const paiseOf = (rupees: number) => Math.round(rupees * 100);
