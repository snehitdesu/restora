// @vitest-environment jsdom
/**
 * Back-office list → detail navigation watchdog: when Next's client navigation
 * never commits (the URL stays put), the browser loads the page itself; a
 * navigation that completes, or a page that unmounts, cancels it.
 */
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
import { useRouterWithWatchdog, NAVIGATION_WATCHDOG_MS } from "@/lib/navigation";

beforeEach(() => {
  vi.useFakeTimers();
  push.mockReset();
  window.history.replaceState(null, "", "/menu");
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("useRouterWithWatchdog", () => {
  it("a navigation that never commits falls back to loading the page", () => {
    const hard = vi.fn();
    const { result } = renderHook(() => useRouterWithWatchdog(hard));
    result.current.push("/menu/items/abc");
    expect(push).toHaveBeenCalledWith("/menu/items/abc");
    vi.advanceTimersByTime(NAVIGATION_WATCHDOG_MS - 1);
    expect(hard).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(hard).toHaveBeenCalledWith(`${window.location.origin}/menu/items/abc`);
  });

  it("does nothing when the URL already changed (navigation committed)", () => {
    const hard = vi.fn();
    const { result } = renderHook(() => useRouterWithWatchdog(hard));
    result.current.push("/menu/items/abc?tab=price");
    window.history.replaceState(null, "", "/menu/items/abc?tab=price");
    vi.advanceTimersByTime(NAVIGATION_WATCHDOG_MS + 10);
    expect(hard).not.toHaveBeenCalled();
  });

  it("is cancelled when the page unmounts (the usual successful navigation)", () => {
    const hard = vi.fn();
    const { result, unmount } = renderHook(() => useRouterWithWatchdog(hard));
    result.current.push("/recipes/r1");
    unmount();
    vi.advanceTimersByTime(NAVIGATION_WATCHDOG_MS * 2);
    expect(hard).not.toHaveBeenCalled();
  });

  it("a second push restarts the watchdog for the newest target only", () => {
    const hard = vi.fn();
    const { result } = renderHook(() => useRouterWithWatchdog(hard));
    result.current.push("/customers/c1");
    vi.advanceTimersByTime(NAVIGATION_WATCHDOG_MS / 2);
    result.current.push("/customers/c2");
    vi.advanceTimersByTime(NAVIGATION_WATCHDOG_MS);
    expect(hard).toHaveBeenCalledTimes(1);
    expect(hard.mock.calls[0][0]).toMatch(/\/customers\/c2$/);
  });
});
