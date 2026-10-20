/**
 * Next 15 preloads every route at server start (experimental.preloadEntriesOnStart, default true),
 * which blocked the desktop server's event loop for 2.6-4.3 s (up to 30 s in a stalled start that
 * answered after 48.8 s; the launcher gives up at 60 s): the first health check failed with a false
 * "database ping timed out" on every start. The desktop build turns it off;
 * desktop/scripts/build.mjs also refuses a standalone server.js that does not.
 */
import { describe, it, expect, vi, afterEach } from "vitest";

async function loadConfig(standalone: boolean) {
  vi.resetModules();
  if (standalone) vi.stubEnv("AHAROS_STANDALONE", "1");
  else vi.stubEnv("AHAROS_STANDALONE", "");
  return (await import("../../next.config.mjs")).default;
}

afterEach(() => vi.unstubAllEnvs());

describe("next.config route preloading", () => {
  it("is off for the desktop (standalone) server", async () => {
    const config = await loadConfig(true);
    expect(config.output).toBe("standalone");
    expect(config.experimental?.preloadEntriesOnStart).toBe(false);
  });

  it("leaves the web build on Next's default", async () => {
    const config = await loadConfig(false);
    expect(config.output).toBeUndefined();
    expect(config.experimental?.preloadEntriesOnStart).toBeUndefined();
  });
});
