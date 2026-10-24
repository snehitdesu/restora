/**
 * The guest storefront prints ₹ (U+20B9) on every price. Inter's preloaded latin
 * subset has no ₹, so without a local face for it each guest page downloaded
 * Inter's latin-ext file (~86 KB) and re-laid out the whole menu when it arrived.
 * The rupee face must stay local-only (no download) and first in the sans stack.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";

const css = readFileSync(path.join(process.cwd(), "src/features/guest/storefront.css"), "utf8");
const faces = [...css.matchAll(/@font-face\s*{([^}]*)}/g)].map((m) => m[1]);

describe("storefront fonts", () => {
  it("draws ₹ from an installed font, never a downloaded one", () => {
    const rupee = faces.filter((f) => /font-family:\s*"SF Rupee"/.test(f));
    expect(rupee.length).toBeGreaterThan(0);
    for (const f of rupee) {
      expect(f).toMatch(/unicode-range:\s*U\+20B9\s*;/i);
      expect(f).not.toMatch(/url\(/);
      expect(f).toMatch(/src:\s*local\(/);
    }
    // a regular and a bold face, so prices are not faux-bolded
    expect(rupee.some((f) => /font-weight:\s*100 549/.test(f))).toBe(true);
    expect(rupee.some((f) => /font-weight:\s*550 1000/.test(f))).toBe(true);
  });

  it("puts the rupee face first in the storefront's sans stack", () => {
    expect(css).toMatch(/--sf-sans:\s*"SF Rupee",\s*var\(--font-inter/);
  });

  it("declares no other font files of its own", () => {
    expect(faces.every((f) => !/url\(/.test(f))).toBe(true);
  });
});
