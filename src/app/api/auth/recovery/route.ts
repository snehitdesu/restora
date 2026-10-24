import type { NextRequest } from "next/server";
import { prisma } from "@/server/db/client";
import { redeemRecoveryCode } from "@/server/auth/recoveryCodes";
import { ok, fail } from "@/server/api/respond";
import { readAuthJson } from "@/server/api/authBody";
import { clientIp, enforceRateLimit, RATE_POLICIES } from "@/server/api/rateLimit";

export const runtime = "nodejs";

/**
 * Owner recovery with a single-use offline code (no session). Rate limits run
 * before any lookup, per IP and per submitted email, so guessing is bounded
 * whether or not the account exists. Every session of the account is revoked;
 * the owner then signs in with the new password.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await readAuthJson(req);
    const ip = clientIp(req);
    await enforceRateLimit(RATE_POLICIES.recoveryRedeemPerIp, ip);
    const email = typeof body.email === "string" ? body.email.toLowerCase().trim().slice(0, 200) : "";
    if (email) await enforceRateLimit(RATE_POLICIES.recoveryRedeemPerEmail, email);
    const result = await redeemRecoveryCode(prisma, body as never, { ip, userAgent: req.headers.get("user-agent") ?? undefined });
    return ok(result);
  } catch (e) {
    return fail(e);
  }
}
