import type { NextRequest } from "next/server";
import { prisma } from "@/server/db/client";
import { SESSION_COOKIE } from "@/constants/auth";
import { resolveFromToken } from "@/server/auth/current-user";
import { requireFreshAuth } from "@/server/auth/reauth";
import { generateRecoveryCodes, isRecoveryEligible } from "@/server/auth/recoveryCodes";
import { ok, fail } from "@/server/api/respond";
import { readAuthJson } from "@/server/api/authBody";
import { clientIp, enforceRateLimit, RATE_POLICIES } from "@/server/api/rateLimit";
import { ForbiddenError, UnauthorizedError } from "@/server/db/scope";

export const runtime = "nodejs";

/**
 * Generate a new set of owner recovery codes (replaces the old set). Needs a
 * fresh password confirmation for "security.manage" on THIS session. The codes
 * are in this response only; it must never be cached.
 */
export async function POST(req: NextRequest) {
  try {
    await readAuthJson(req);
    const current = await resolveFromToken(req.cookies.get(SESSION_COOKIE)?.value);
    if (!current) throw new UnauthorizedError();
    if (!(await isRecoveryEligible(prisma, current.user.id))) throw new ForbiddenError("Only an active organization owner can generate recovery codes");
    const meta = { ip: clientIp(req), userAgent: req.headers.get("user-agent") ?? undefined };
    await requireFreshAuth(prisma, { session: current.session, organizationId: current.user.organizationId }, "security.manage", { ...meta, method: "POST", path: "/api/auth/recovery-codes" });
    await enforceRateLimit(RATE_POLICIES.recoveryGeneratePerUser, current.user.id);
    const result = await generateRecoveryCodes(prisma, current.user.id, meta);
    return ok(result, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return fail(e);
  }
}
