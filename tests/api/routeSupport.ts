/** Shared helpers for route tests: call a catch-all route handler as a role, and sign roles in without the login page. */
import { NextRequest } from "next/server";
import { prisma } from "@/server/db/client";
import { createSession } from "@/server/auth/session";
import { SESSION_COOKIE } from "@/constants/auth";

type Handler = (req: NextRequest, c: { params: Promise<{ path?: string[] }> }) => Promise<Response>;
export type Routes = Record<string, Handler>;

export const ORIGIN = "http://localhost";
const RUN = Date.now().toString(36);

export async function call(module: object, method: string, path: string, opts: { session?: string; body?: unknown; origin?: string | null; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { host: "localhost", "x-forwarded-for": `203.0.113.${(RUN.length % 200) + 1}`, ...(opts.headers ?? {}) };
  if (opts.session) headers.cookie = `${SESSION_COOKIE}=${opts.session}`;
  if (opts.origin !== null && method !== "GET") headers.origin = opts.origin ?? ORIGIN;
  const req = new NextRequest(new URL(`http://localhost/api/x/${path}`), { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
  const segments = path.split("?")[0];
  const res = await (module as Routes)[method](req, { params: Promise.resolve({ path: segments ? segments.split("/") : undefined }) });
  return { status: res.status, json: await res.json().catch(() => null), headers: res.headers };
}

/** A real session token for a new user holding `role` at `outlet` (null: organization-wide). */
export async function sessionFor(orgId: string, role: string, outlet: string | null) {
  const u = await prisma.user.create({ data: { organizationId: orgId, email: `${role.toLowerCase()}-${RUN}-${Math.random().toString(36).slice(2, 8)}@route.test`, name: role, passwordHash: "x" } });
  await prisma.membership.create({ data: { organizationId: orgId, userId: u.id, outletId: outlet, role } });
  return (await createSession(prisma, u.id)).token;
}
