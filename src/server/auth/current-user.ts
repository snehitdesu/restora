/**
 * Current-user / current-context helpers for server components, server actions
 * and route handlers. All authorization derives from the DB-built AccessContext
 * — never from client input. This is the ONE authorization path (RBAC in rbac.ts).
 */
import { prisma } from "@/server/db/client";
import { type AccessContext, UnauthorizedError } from "@/server/db/scope";
import { buildAccessContext } from "@/server/auth/context";
import { assertCan, type Permission } from "@/server/auth/rbac";
import { validateSession, type ActiveSession } from "@/server/auth/session";
import { readSessionCookie } from "@/server/auth/cookies";

export type CurrentUser = { id: string; name: string; email: string; organizationId: string; isSuperAdmin: boolean };

export type Current = { ctx: AccessContext; user: CurrentUser; session: ActiveSession; deviceId?: string };

/** Resolve the caller from the session cookie, or null if unauthenticated. A page render counts as activity. */
export async function getCurrentContext(): Promise<Current | null> {
  const token = await readSessionCookie();
  return resolveFromToken(token);
}

/**
 * Resolve from an explicit raw token (used by middleware-free route handlers / tests).
 * `activity: false` for background polling, which must not extend the idle timeout.
 */
export async function resolveFromToken(token: string | undefined | null, opts: { activity?: boolean } = {}): Promise<Current | null> {
  const session = await validateSession(prisma, token, { activity: opts.activity ?? true });
  if (!session) return null;
  const user = await prisma.user.findUnique({ where: { id: session.userId } });
  if (!user || !user.active) return null;
  const ctx = await buildAccessContext(prisma, session.userId);
  return {
    ctx,
    user: { id: user.id, name: user.name, email: user.email, organizationId: user.organizationId, isSuperAdmin: user.isSuperAdmin },
    session,
  };
}

/**
 * Kitchen-display idle exemption: a dedicated kitchen account (every role it
 * holds is KITCHEN) keeps its session alive by polling the KDS ticket board,
 * so a wall-mounted screen is not signed out mid-service. Anyone holding any
 * other role (manager, cashier, owner, …) gets no exemption: their KDS poll is
 * background polling like any other.
 */
export function isKitchenDisplayUser(ctx: AccessContext): boolean {
  return !ctx.isSuperAdmin && ctx.roles.length > 0 && ctx.roles.every((r) => r === "KITCHEN") && ctx.orgRoles.every((r) => r === "KITCHEN");
}

/** Require an authenticated caller; throws UnauthorizedError (401) otherwise. */
export async function requireContext(): Promise<Current> {
  const current = await getCurrentContext();
  if (!current) throw new UnauthorizedError();
  return current;
}

/** Require authentication AND a permission (optionally at an outlet). */
export async function requirePermission(permission: Permission, outletId?: string): Promise<Current> {
  const current = await requireContext();
  assertCan(current.ctx, permission, outletId); // throws ForbiddenError (403)
  return current;
}
