/**
 * Next infers its workspace root from the nearest lockfile it finds above the project when
 * outputFileTracingRoot is unset. A stray package-lock.json in the user's home folder made it pick
 * that folder: the desktop build's standalone server landed in
 * .next-desktop/standalone/Downloads/food/server.js and `npm run desktop:pack` failed with
 * "No standalone build found". The root must be this checkout, whatever lies above it.
 */
import path from "node:path";
import { describe, it, expect } from "vitest";
import nextConfig from "../../next.config.mjs";

describe("next.config file tracing root", () => {
  it("is pinned to the project directory", () => {
    expect(nextConfig.outputFileTracingRoot).toBeDefined();
    expect(path.resolve(nextConfig.outputFileTracingRoot!)).toBe(path.resolve(process.cwd()));
  });
});
