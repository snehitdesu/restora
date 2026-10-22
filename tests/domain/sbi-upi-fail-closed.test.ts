/**
 * SBI UPI is a stub until it is built from SBI's specification and passes UAT
 * (src/integrations/payment/sbiUpi.ts). These tests drive it through the real
 * entry points, not the adapter alone: with PAYMENT_PROVIDER=sbi_upi a guest
 * is never offered online payment, and a callback that claims to be from SBI
 * (even one signed with the deployment's payment secret) is refused at the
 * HTTP route and settles nothing.
 */
import { describe, it, expect, afterAll, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/server/db/client";
import { systemContext } from "@/server/auth/context";
import { createOrder, addOrderItem } from "@/server/services/orders";
import { createPayment } from "@/server/services/payment";
import { guestPaymentOptions } from "@/server/services/guestOrdering";
import { signPaymentPayload } from "@/integrations/payment";
import { POST as webhookRoute } from "@/app/api/webhooks/[kind]/[provider]/route";

const RUN = Date.now().toString(36);
afterEach(() => vi.unstubAllEnvs());
afterAll(async () => { await prisma.$disconnect(); });

describe("SBI UPI stub through the real entry points", () => {
  it("PAYMENT_PROVIDER=sbi_upi: guests are never offered online payment, cached or fresh", async () => {
    vi.stubEnv("PAYMENT_PROVIDER", "sbi_upi");
    expect(await guestPaymentOptions({ fresh: true })).toEqual({ online: false, testMode: false, mode: null });
    expect(await guestPaymentOptions()).toEqual({ online: false, testMode: false, mode: null });
    vi.stubEnv("SBI_UPI_ENVIRONMENT", "production");
    expect((await guestPaymentOptions({ fresh: true })).online).toBe(false);
  });

  it("a callback to /api/webhooks/payment/sbi_upi is refused and leaves the payment PENDING", async () => {
    const org = await prisma.organization.create({ data: { name: `SBI stub ${RUN}` } });
    const outlet = await prisma.outlet.create({ data: { organizationId: org.id, code: `SBI${RUN}`.toUpperCase().slice(0, 20), name: "Main" } });
    const ctx = systemContext(org.id, [outlet.id]);
    const order = await createOrder(ctx, { outletId: outlet.id });
    await addOrderItem(ctx, order.id, { name: "Online", qty: 1, unitPrice: 250 });
    const providerRef = `sbiref-${RUN}`;
    const payment = await createPayment(ctx, order.id, { method: "ONLINE", amount: 250, provider: "sbi_upi", providerRef });

    const raw = JSON.stringify({ eventId: `sbi-ev-${RUN}`, accountId: `acct-${RUN}`, event: "payment.captured", providerRef, amount: 250 });
    for (const signature of [signPaymentPayload(raw), "anything", ""]) {
      const req = new NextRequest("http://localhost/api/webhooks/payment/sbi_upi", { method: "POST", body: raw, headers: { "x-signature": signature, "content-type": "application/json" } });
      const res = await webhookRoute(req, { params: Promise.resolve({ kind: "payment", provider: "sbi_upi" }) });
      expect(res.status).toBe(401);
      expect(JSON.stringify(await res.json())).not.toContain(payment.id);
    }

    const after = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(after.status).toBe("PENDING");
    expect(after.verifiedAt).toBeNull();
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).not.toBe("PAID");
    expect(await prisma.webhookEvent.count({ where: { provider: { contains: "sbi_upi" }, status: "PROCESSED" } })).toBe(0);
  });
});
