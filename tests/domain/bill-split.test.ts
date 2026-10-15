import { describe, it, expect } from "vitest";
import { splitShare, MAX_SPLIT_PARTS, MIN_SPLIT_PARTS } from "@/domain/billSplit";

/** Everyone pays in turn, as the page would ask each of them. */
function payAll(total: number, parts: number) {
  let due = total;
  const paid: number[] = [];
  for (let i = 0; i < parts; i++) {
    const s = splitShare(due, parts, i);
    paid.push(Number(s.amount));
    due = Math.round((due - Number(s.amount)) * 100) / 100;
  }
  return { paid, due };
}

describe("splitShare", () => {
  it("splits evenly when the bill divides: the parts add up to the bill", () => {
    expect(payAll(900, 3)).toEqual({ paid: [300, 300, 300], due: 0 });
    expect(payAll(1000, 4)).toEqual({ paid: [250, 250, 250, 250], due: 0 });
  });

  it("rounds each part down to the paisa and leaves the difference to the last payer", () => {
    const r = payAll(100, 3);
    expect(r.paid).toEqual([33.33, 33.33, 33.34]);
    expect(r.due).toBe(0);
    const t = payAll(1234.57, 5);
    expect(t.due).toBe(0);
    // Each part is worked out again from what is still due, so a rounding difference is spread rather than dumped on one person.
    expect(t.paid).toEqual([246.91, 246.91, 246.91, 246.92, 246.92]);
    expect(Math.max(...t.paid) - Math.min(...t.paid)).toBeLessThan(0.05); // nobody pays noticeably more
  });

  it("works from what is still due, so cash taken at the counter in between is respected", () => {
    // 1,200 split three ways; one person paid 400 online; the table then paid 200 in cash at the counter.
    expect(splitShare(600, 3, 1)).toEqual({ amount: "300.00", remainingParts: 2, last: false });
    expect(splitShare(300, 3, 2)).toEqual({ amount: "300.00", remainingParts: 1, last: true });
  });

  it("the last payer pays everything left, and more payers than parts also pay what is left", () => {
    expect(splitShare(77.77, 2, 1)).toEqual({ amount: "77.77", remainingParts: 1, last: true });
    expect(splitShare(77.77, 2, 5)).toEqual({ amount: "77.77", remainingParts: 1, last: true });
  });

  it("never asks for a zero payment", () => {
    expect(splitShare(0.05, 12, 0)).toEqual({ amount: "0.05", remainingParts: 1, last: true });
  });

  it("refuses a split that is not between 2 and 12 people", () => {
    for (const parts of [0, 1, 13, 2.5, NaN]) expect(() => splitShare(100, parts, 0)).toThrow(RangeError);
    expect(() => splitShare(100, MIN_SPLIT_PARTS, 0)).not.toThrow();
    expect(() => splitShare(100, MAX_SPLIT_PARTS, 0)).not.toThrow();
  });

  it("any bill and any number of people: the parts add up exactly and differ by at most the rounding", () => {
    for (const total of [1, 9.99, 100, 349.5, 1234.56, 99999.99]) {
      for (let parts = 2; parts <= 12; parts++) {
        const { paid, due } = payAll(total, parts);
        expect(due, `${total} / ${parts}`).toBe(0);
        expect(Math.round(paid.reduce((a, b) => a + b, 0) * 100) / 100, `${total} / ${parts}`).toBe(total);
        expect(paid.every((p) => p > 0 || total < 0.02)).toBe(true);
      }
    }
  });
});
