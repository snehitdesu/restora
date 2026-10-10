/**
 * Guest-facing online-payment wording. MOCK is the in-process simulator.
 * SANDBOX is Razorpay test mode. LIVE is the only mode that may name Razorpay
 * as a real checkout. Anything else stays unlabeled rather than claiming a provider.
 */
export type GuestPaymentDisclosure = { mode?: string | null; testMode?: boolean };

export function guestOnlinePaymentCopy(payment: GuestPaymentDisclosure): { title: string; detail: string } {
  if (payment.mode === "MOCK" || payment.testMode) {
    return { title: "Simulated online payment", detail: "Simulated payment — no real money is charged." };
  }
  if (payment.mode === "SANDBOX") {
    return { title: "Pay online", detail: "Razorpay test mode — no real money is charged." };
  }
  if (payment.mode === "LIVE") {
    return { title: "Pay online", detail: "UPI, cards, netbanking · Razorpay" };
  }
  return { title: "Pay online", detail: "Online payment" };
}
