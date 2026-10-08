/**
 * No route-level loading boundary under the back-office routes.
 *
 * A `loading.tsx` there wraps every page in a Suspense boundary that Next streams. With Next 15.5 and
 * a fast server, a client navigation into that boundary (router.push after a create dialog saved, the
 * redirect after sign-in) sometimes never committed: the router's transition update was queued with its
 * promise already settled but React never rendered it and nothing woke the root. Reproduced with a bare
 * `router.push` and no application code involved (11 stalls in 105 runs); with the file removed, 0 in 105
 * (docs/stabilization-report.md section 4, e2e/nav-after-save.spec.ts). Pages show their own loading
 * states, so nothing is lost. Do not add one back without re-running that spec 100+ times.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

function find(dir: string, name: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...find(p, name));
    else if (e.name === name) out.push(path.relative(process.cwd(), p));
  }
  return out;
}

describe("back-office routes", () => {
  it("have no loading.tsx boundary (it strands router.push on Next 15.5)", () => {
    expect(find(path.join(process.cwd(), "src", "app", "(app)"), "loading.tsx")).toEqual([]);
    expect(find(path.join(process.cwd(), "src", "app", "(app)"), "loading.js")).toEqual([]);
  });
});
