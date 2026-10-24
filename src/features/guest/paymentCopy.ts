/**
 * Guest-facing online-payment wording. MOCK is the in-process simulator or the
 * local bank emulator (no money at all). SANDBOX is the bank's test
 * environment (no real money). LIVE is the bank's production UPI collection.
 * No mode names a payment gateway: guests pay the restaurant's bank by UPI.
 */
export type GuestPaymentDisclosure = { mode?: string | null; testMode?: boolean };

export function guestOnlinePaymentCopy(payment: GuestPaymentDisclosure): { title: string; detail: string } {
  if (payment.mode === "MOCK" || payment.testMode) {
    return { title: "Simulated online payment", detail: "Simulated payment — no real money is charged." };
  }
  if (payment.mode === "SANDBOX") {
    return { title: "Pay by UPI (test)", detail: "Bank test environment — no real money is charged." };
  }
  if (payment.mode === "LIVE") {
    return { title: "Pay by UPI", detail: "Scan the QR with any UPI app" };
  }
  return { title: "Pay online", detail: "Online payment" };
}
