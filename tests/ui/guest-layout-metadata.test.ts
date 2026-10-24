/**
 * The table storefront layout (/t/[token]) re-runs generateMetadata and
 * generateViewport on EVERY client navigation (menu ↔ cart ↔ checkout), while
 * the layout itself is not re-rendered. They need only the restaurant name and
 * table code, so they must resolve the table only: loading the guest menu
 * there cost 10 queries and a payment-gateway health check per navigation.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NotFoundError } from "@/server/db/scope";

const resolveTable = vi.fn();
const guestMenuFor = vi.fn();
vi.mock("@/server/services/guestOrdering", () => ({
  resolveTable: (...a: unknown[]) => resolveTable(...a),
  guestMenuFor: (...a: unknown[]) => guestMenuFor(...a),
}));

const { generateMetadata, generateViewport } = await import("@/app/t/[token]/layout");
const { brandFor } = await import("@/features/guest/brand");

const props = (token: string) => ({ params: Promise.resolve({ token }) });
const table = { ctx: {}, table: { id: "tb1", code: "T01" }, outlet: { id: "o1", name: "Coders' Cafe" }, restaurantName: "Coders' Cafe" };

beforeEach(() => {
  resolveTable.mockReset();
  guestMenuFor.mockReset();
});

describe("guest storefront layout metadata", () => {
  it("names the restaurant and table without loading the menu or checking the payment gateway", async () => {
    resolveTable.mockResolvedValue(table);
    const meta = await generateMetadata(props("ccf-token-123"));
    const viewport = await generateViewport(props("ccf-token-123"));
    expect(meta).toMatchObject({ title: "Coders' Cafe · Table T01", description: "Order from Table T01 at Coders' Cafe.", robots: { index: false, follow: false }, referrer: "no-referrer" });
    expect(viewport).toMatchObject({ themeColor: brandFor("Coders' Cafe").themeColor });
    expect(resolveTable).toHaveBeenCalledWith("ccf-token-123");
    expect(guestMenuFor).not.toHaveBeenCalled();
  });

  it("an unknown or disabled QR gets the neutral title, never a hint", async () => {
    resolveTable.mockRejectedValue(new NotFoundError("This table QR code is not valid. Please ask the staff for help."));
    expect(await generateMetadata(props("unknown-token-1"))).toMatchObject({ title: "Table QR", description: undefined });
    expect(await generateViewport(props("unknown-token-1"))).toMatchObject({ themeColor: brandFor(undefined).themeColor });
    expect(guestMenuFor).not.toHaveBeenCalled();
  });

  it("other failures are not swallowed", async () => {
    resolveTable.mockRejectedValue(new Error("database unavailable"));
    await expect(generateMetadata(props("ccf-token-123"))).rejects.toThrow("database unavailable");
  });
});
