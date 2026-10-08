// @vitest-environment jsdom
/** The universal search box (audit PA-05): opens from the button and the keyboard, debounces, shows grouped results, moves and opens with the keys. */
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, within, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SearchPalette } from "@/components/layout/SearchPalette";
import { state, installFetch, teardown, fail } from "./harness";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, replace: vi.fn(), refresh: vi.fn() }), usePathname: () => "/dashboard" }));
beforeEach(() => { installFetch(); push.mockClear(); });
afterEach(teardown);

const result = {
  q: "zoya",
  groups: [
    { type: "customer", label: "Customers", items: [{ id: "c1", title: "Zoya Khan", subtitle: "9333300001", href: "/customers/c1" }, { id: "c2", title: "Zoya Rao", subtitle: null, href: "/customers/c2" }] },
    { type: "menu", label: "Menu items", items: [{ id: "m1", title: "Zoya's Wrap", subtitle: "Snacks", href: "/menu/items/m1" }] },
  ],
};

describe("SearchPalette", () => {
  it("opens with Ctrl+K, waits for two characters, shows grouped results and opens the highlighted one with Enter", async () => {
    state.routes = { "GET /api/search": () => result };
    render(<SearchPalette />);
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    const dlg = await screen.findByRole("dialog", { name: "Search" });
    const box = within(dlg).getByRole("combobox");
    expect(box).toHaveFocus();
    expect(within(dlg).getByText(/Type at least 2 characters/)).toBeInTheDocument();
    await userEvent.type(box, "z");
    await new Promise((r) => setTimeout(r, 350));
    expect(state.calls).toHaveLength(0);

    await userEvent.type(box, "oya");
    const list = await within(dlg).findByRole("listbox", { name: "Results" });
    expect(state.calls).toHaveLength(1); // one request for the finished word, not one per key
    expect(state.calls[0].query.get("q")).toBe("zoya");
    expect(within(list).getByRole("group", { name: "Customers" })).toBeInTheDocument();
    expect(within(list).getByRole("group", { name: "Menu items" })).toBeInTheDocument();
    const options = within(list).getAllByRole("option");
    expect(options).toHaveLength(3);
    expect(options[0]).toHaveAttribute("aria-selected", "true");
    expect(box).toHaveAttribute("aria-activedescendant", options[0].id);

    await userEvent.keyboard("{ArrowDown}{ArrowDown}");
    expect(options[2]).toHaveAttribute("aria-selected", "true");
    await userEvent.keyboard("{ArrowDown}"); // wraps
    expect(options[0]).toHaveAttribute("aria-selected", "true");
    await userEvent.keyboard("{ArrowUp}");
    expect(options[2]).toHaveAttribute("aria-selected", "true");
    await userEvent.keyboard("{Enter}");
    expect(push).toHaveBeenCalledWith("/menu/items/m1");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("a click opens a result; '/' opens the box only when no field is focused; Escape closes and clears", async () => {
    state.routes = { "GET /api/search": () => result };
    render(<><input aria-label="Some field" /><SearchPalette /></>);
    await userEvent.type(screen.getByLabelText("Some field"), "/");
    expect(screen.queryByRole("dialog")).toBeNull(); // typing a slash into a field is typing
    (document.activeElement as HTMLElement).blur();
    await userEvent.keyboard("/");
    const dlg = await screen.findByRole("dialog", { name: "Search" });
    await userEvent.type(within(dlg).getByRole("combobox"), "zoya");
    await userEvent.click(await within(dlg).findByRole("option", { name: /Zoya Rao/ }).then((o) => within(o).getByRole("button")));
    expect(push).toHaveBeenCalledWith("/customers/c2");

    await userEvent.click(screen.getByRole("button", { name: /Search \(Ctrl\+K\)/ }));
    const again = await screen.findByRole("dialog", { name: "Search" });
    expect(within(again).getByRole("combobox")).toHaveValue(""); // cleared when it closed
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("says when nothing matches and shows the server's error without crashing", async () => {
    state.routes = { "GET /api/search": () => ({ q: "nope", groups: [] }) };
    render(<SearchPalette />);
    await userEvent.click(screen.getByRole("button", { name: /Search \(Ctrl\+K\)/ }));
    const dlg = await screen.findByRole("dialog", { name: "Search" });
    await userEvent.type(within(dlg).getByRole("combobox"), "nope");
    expect(await within(dlg).findByText(/Nothing matches “nope”/)).toBeInTheDocument();

    state.routes = { "GET /api/search": () => fail(429, "RateLimitError", "Too many requests") };
    await userEvent.type(within(dlg).getByRole("combobox"), "x");
    expect(await within(dlg).findByRole("alert")).toHaveTextContent(/Too many requests/);
  });
});
