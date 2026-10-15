// @vitest-environment jsdom
/**
 * The suggestion strip (audit ME-04): asks the server for hints about what is on the order, shows the reason in words,
 * hands a tapped dish back to the caller, and stays silent when there is nothing to say or anything goes wrong.
 */
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { UpsellStrip, type UpsellHint } from "@/features/pos/components/UpsellStrip";
import { state, installFetch, teardown, fail } from "./harness";

beforeEach(installFetch);
afterEach(teardown);

const hint = (over: Partial<UpsellHint> = {}): UpsellHint => ({ menuItemId: "m-coffee", name: "Filter Coffee", price: 40, reason: "PAIRS_WITH", with: "Masala Dosa", text: "Guests often add it to Masala Dosa", ...over });

describe("UpsellStrip", () => {
  it("asks about the dishes on the order (deduplicated, stable), shows each hint with its reason, and hands a tapped dish back", async () => {
    const onAdd = vi.fn();
    state.routes = { "GET /api/menu/upsell": () => [hint(), hint({ menuItemId: "m-special", name: "Chef Special", price: 300, reason: "FEATURED", with: undefined, text: "Worth recommending: guests who try it like it, few do" })] };
    render(<UpsellStrip outletId="out-a" menuItemIds={["m-dosa", "m-dosa", "m-chai"]} onAdd={onAdd} />);
    const region = await screen.findByRole("region", { name: "Suggestions" });
    const call = state.calls.find((c) => c.path === "/api/menu/upsell")!;
    expect(call.query.get("outletId")).toBe("out-a");
    expect(call.query.get("items")).toBe("m-chai,m-dosa");
    expect(call.query.get("limit")).toBe("3");
    expect(region).toHaveTextContent("Guests often add it to Masala Dosa");
    expect(region).toHaveTextContent("₹40.00");
    await userEvent.click(screen.getByRole("button", { name: /Add Chef Special/ }));
    expect(onAdd).toHaveBeenCalledWith(expect.objectContaining({ menuItemId: "m-special" }));
  });

  it("shows nothing for an empty order, a disabled strip, no hints, or any error; and re-asks when the order changes", async () => {
    state.routes = { "GET /api/menu/upsell": () => [] };
    const { rerender, container } = render(<UpsellStrip outletId="out-a" menuItemIds={[]} onAdd={() => undefined} />);
    await new Promise((r) => setTimeout(r, 500));
    expect(state.calls).toHaveLength(0);
    expect(container).toBeEmptyDOMElement();

    rerender(<UpsellStrip outletId="out-a" menuItemIds={["m-dosa"]} onAdd={() => undefined} />);
    await waitFor(() => expect(state.calls).toHaveLength(1));
    expect(screen.queryByRole("region", { name: "Suggestions" })).toBeNull();

    state.routes = { "GET /api/menu/upsell": () => [hint()] };
    rerender(<UpsellStrip outletId="out-a" menuItemIds={["m-dosa", "m-chai"]} onAdd={() => undefined} />);
    expect(await screen.findByRole("region", { name: "Suggestions" })).toBeInTheDocument();
    expect(state.calls).toHaveLength(2);

    rerender(<UpsellStrip outletId="out-a" menuItemIds={["m-dosa", "m-chai"]} onAdd={() => undefined} disabled />);
    await waitFor(() => expect(screen.queryByRole("region", { name: "Suggestions" })).toBeNull());

    cleanup();
    state.routes = { "GET /api/menu/upsell": () => fail(403, "ForbiddenError", "Missing permission") };
    render(<UpsellStrip outletId="out-a" menuItemIds={["m-dosa"]} onAdd={() => undefined} />);
    await waitFor(() => expect(state.calls.filter((c) => c.path === "/api/menu/upsell").length).toBeGreaterThan(2));
    expect(screen.queryByRole("region", { name: "Suggestions" })).toBeNull();
  });
});
