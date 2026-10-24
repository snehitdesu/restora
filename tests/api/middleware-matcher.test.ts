import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { config, middleware, PROTECTED_PAGES } from "@/middleware";
import { SESSION_COOKIE } from "@/constants/auth";

describe("middleware matcher", () => {
  it("runs on every protected page (a missing entry loses the post-login return path)", () => {
    for (const page of PROTECTED_PAGES) expect(config.matcher, page).toContain(`${page}/:path*`);
  });
});

/** The edge only pre-filters: is the request carrying ANY credential? The route handlers authenticate it. */
describe("middleware API pre-filter", () => {
  const run = (path: string, headers: Record<string, string> = {}) => middleware(new NextRequest(`https://restora.example${path}`, { method: "POST", headers }));
  const passed = (res: Response) => res.headers.get("x-middleware-next") === "1";

  it("refuses a protected API call with no credential at all", async () => {
    const res = run("/api/payments");
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ ok: false, error: { code: "UnauthorizedError" } });
  });

  it("lets a staff session cookie through to the route", () => {
    expect(passed(run("/api/payments", { cookie: `${SESSION_COOKIE}=x` }))).toBe(true);
  });

  // 2026-10-19: a linked desktop settles a cloud order with POST /api/payments (and /verify) using its device
  // token as a Bearer header and no cookie (src/server/sync/mirrorGuard.ts). The edge answered 401, the desktop
  // reported "The cloud sign-in has ended", and the counter could not take payment for a cloud order.
  it("lets a linked desktop's Bearer device token through to the route (the router validates it)", () => {
    expect(passed(run("/api/payments", { authorization: "Bearer device-token" }))).toBe(true);
    expect(passed(run("/api/payments/abc/verify", { authorization: "Bearer device-token" }))).toBe(true);
  });

  it("does not treat a malformed Authorization header as a credential", () => {
    for (const authorization of ["Bearer", "Bearer ", "Basic dXNlcjpwYXNz", "token abc"]) expect(run("/api/payments", { authorization }).status, authorization).toBe(401);
  });
});
