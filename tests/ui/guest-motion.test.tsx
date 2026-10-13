// @vitest-environment jsdom
/**
 * Storefront scroll motion (motion.ts): reveals never hide content without an
 * IntersectionObserver, a block already on screen is shown as is, an off-screen
 * block is marked and revealed once when it intersects; the landing root gets
 * data-motion and data-past-hero once the hero is under the header.
 */
import "@testing-library/jest-dom/vitest";
import { useRef } from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, act } from "@testing-library/react";
import { useLandingMotion, useReveal } from "@/features/guest/motion";

type Entry = { target: Element; isIntersecting: boolean };
let observers: Array<{ cb: (e: Entry[], io: unknown) => void; targets: Set<Element>; io: { observe: (el: Element) => void; unobserve: (el: Element) => void; disconnect: () => void } }> = [];

function installObserver() {
  observers = [];
  class FakeIO {
    targets = new Set<Element>();
    constructor(public cb: (e: Entry[], io: unknown) => void) {
      observers.push({ cb, targets: this.targets, io: this });
    }
    observe(el: Element) {
      this.targets.add(el);
    }
    unobserve(el: Element) {
      this.targets.delete(el);
    }
    disconnect() {
      this.targets.clear();
    }
  }
  vi.stubGlobal("IntersectionObserver", FakeIO);
}

function placeAt(el: Element, top: number) {
  el.getBoundingClientRect = () => ({ top, bottom: top + 200, left: 0, right: 100, width: 100, height: 200, x: 0, y: top, toJSON() {} }) as DOMRect;
}

/** Blocks are sorted in a microtask after the commit (still before the browser paints). */
const settle = () => act(async () => {});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function Block({ top }: { top: number }) {
  const reveal = useReveal(true);
  return (
    <section
      data-testid="b"
      ref={(el) => {
        if (el) placeAt(el, top);
        return reveal(el);
      }}
    />
  );
}

describe("useReveal", () => {
  it("shows everything at once when IntersectionObserver is missing", () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    const { getByTestId } = render(<Block top={5000} />);
    expect(getByTestId("b")).toHaveAttribute("data-revealed");
  });

  it("shows a block that is already on screen without waiting for the observer", async () => {
    installObserver();
    const { getByTestId } = render(<Block top={100} />);
    await settle();
    expect(getByTestId("b")).toHaveAttribute("data-revealed");
    expect(getByTestId("b")).not.toHaveAttribute("data-reveal");
  });

  it("marks an off-screen block, reveals it once when it intersects, then stops watching it", async () => {
    installObserver();
    const { getByTestId } = render(<Block top={5000} />);
    await settle();
    const el = getByTestId("b");
    expect(el).toHaveAttribute("data-reveal");
    expect(el).not.toHaveAttribute("data-revealed");
    // the reveal observer is shared (module singleton): find the one watching this block
    const o = observers.find((x) => x.targets.has(el))!;
    act(() => o.cb([{ target: el, isIntersecting: false }], o.io));
    expect(el).not.toHaveAttribute("data-revealed");
    act(() => o.cb([{ target: el, isIntersecting: true }], o.io));
    expect(el).toHaveAttribute("data-revealed");
    expect(o.targets.has(el)).toBe(false);
  });

  it("sorts the blocks of one commit in a single pass: every position is read before any attribute is written", async () => {
    installObserver();
    const log: string[] = [];
    function Logged({ id, top }: { id: string; top: number }) {
      const reveal = useReveal(true);
      return (
        <section
          data-testid={id}
          ref={(el) => {
            if (el) {
              el.getBoundingClientRect = () => {
                log.push(`read ${id}`);
                return { top, bottom: top + 200, left: 0, right: 100, width: 100, height: 200, x: 0, y: top, toJSON() {} } as DOMRect;
              };
              const set = el.setAttribute.bind(el);
              el.setAttribute = (n: string, v: string) => {
                log.push(`write ${id}`);
                set(n, v);
              };
            }
            return reveal(el);
          }}
        />
      );
    }
    const { getByTestId } = render(
      <>
        <Logged id="a" top={100} />
        <Logged id="b" top={5000} />
        <Logged id="c" top={300} />
      </>
    );
    await settle();
    expect(log).toEqual(["read a", "read b", "read c", "write a", "write b", "write c"]);
    expect(getByTestId("a")).toHaveAttribute("data-revealed");
    expect(getByTestId("b")).toHaveAttribute("data-reveal");
    expect(getByTestId("c")).toHaveAttribute("data-revealed");
  });

  it("forgets a block that unmounts before it was sorted", async () => {
    installObserver();
    const { getByTestId, unmount } = render(<Block top={5000} />);
    const el = getByTestId("b");
    unmount();
    await settle();
    expect(el).not.toHaveAttribute("data-reveal");
    expect(observers.some((o) => o.targets.has(el))).toBe(false);
  });
});

function Landing({ enabled }: { enabled: boolean }) {
  const root = useRef<HTMLDivElement>(null);
  const hero = useRef<HTMLElement>(null);
  useLandingMotion(root, hero, enabled);
  return (
    <div data-testid="root" ref={root}>
      <section ref={hero} />
    </div>
  );
}

describe("useLandingMotion", () => {
  it("turns motion on and flags the root once the hero has scrolled under the header", () => {
    installObserver();
    const { getByTestId, unmount } = render(<Landing enabled />);
    const root = getByTestId("root");
    expect(root).toHaveAttribute("data-motion");
    const o = observers[observers.length - 1];
    const hero = [...o.targets][0];
    act(() => o.cb([{ target: hero, isIntersecting: false }], o.io));
    expect(root).toHaveAttribute("data-past-hero");
    act(() => o.cb([{ target: hero, isIntersecting: true }], o.io));
    expect(root).not.toHaveAttribute("data-past-hero");
    unmount();
    expect(o.targets.size).toBe(0);
  });

  it("does nothing for a storefront without the immersive landing", () => {
    installObserver();
    const { getByTestId } = render(<Landing enabled={false} />);
    expect(getByTestId("root")).not.toHaveAttribute("data-motion");
  });
});
