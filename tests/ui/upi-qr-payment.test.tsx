// @vitest-environment jsdom
/**
 * The UPI QR panel re-renders every second for its countdown. Encoding the QR
 * (Reed-Solomon + mask scoring) must happen once per checkout, not on every tick:
 * on a slow phone that is a few milliseconds of main-thread work each second
 * for as long as the guest is paying.
 */
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";

const encode = vi.hoisted(() => ({ calls: 0 }));
vi.mock("@/lib/qrSvg", async (orig) => {
  const actual = await orig<typeof import("@/lib/qrSvg")>();
  return { ...actual, qrSvgPath: (text: string) => { encode.calls++; return actual.qrSvgPath(text); } };
});

import { UpiQrPayment, type UpiQrCheckout } from "@/features/guest/components/UpiQrPayment";

afterEach(() => { cleanup(); vi.useRealTimers(); encode.calls = 0; });

const checkout = (qr: string, at: number): UpiQrCheckout => ({ paymentId: "pay_1", amount: "250.00", mode: "MOCK", qr, expiresAt: new Date(at + 5 * 60_000).toISOString() });

describe("UpiQrPayment", () => {
  it("encodes the QR once while the countdown ticks, and again only for a new QR", () => {
    vi.useFakeTimers();
    const now = Date.now();
    const onCheck = vi.fn(async () => undefined);
    const { rerender } = render(<UpiQrPayment checkout={checkout("upi://pay?pa=a@sbi&am=250.00&cu=INR&tr=T1", now)} onCheck={onCheck} onRenew={() => {}} busy={false} />);
    expect(screen.getByRole("img", { name: /UPI QR code/ })).toBeInTheDocument();
    expect(encode.calls).toBe(1);

    act(() => { vi.advanceTimersByTime(10_000); }); // 10 countdown re-renders (and two status checks)
    expect(screen.getByText(/4:5\d/)).toBeInTheDocument();
    expect(onCheck).toHaveBeenCalled();
    expect(encode.calls).toBe(1);

    rerender(<UpiQrPayment checkout={checkout("upi://pay?pa=a@sbi&am=250.00&cu=INR&tr=T2", now)} onCheck={onCheck} onRenew={() => {}} busy={false} />);
    expect(encode.calls).toBe(2);
  });
});
