import type { NextRequest } from "next/server";
import { prisma } from "@/server/db/client";
import { requestPasswordReset, resetRequestOutcome, resetRequestSchema } from "@/server/auth/account";
import { ok, fail } from "@/server/api/respond";
import { readAuthJson } from "@/server/api/authBody";
import { runAfterResponse } from "@/server/api/afterResponse";
import { clientIp, enforceRateLimit, RATE_POLICIES } from "@/server/api/rateLimit";

export const runtime = "nodejs";

/**
 * Self-service reset request. Validation and rate limits answer at once; the
 * account lookup, link and email run after the response, so an existing
 * account (and a sent email) takes exactly as long as an unknown one.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await readAuthJson(req);
    const ip = clientIp(req);
    await enforceRateLimit(RATE_POLICIES.passwordResetPerIp, ip);
    const email = typeof body.email === "string" ? body.email.toLowerCase().trim().slice(0, 200) : "";
    if (email) await enforceRateLimit(RATE_POLICIES.passwordResetPerEmail, email);
    const input = resetRequestSchema.parse(body);
    const meta = { ip, userAgent: req.headers.get("user-agent") ?? undefined };
    runAfterResponse("password-reset-request", () => requestPasswordReset(prisma, input, meta));
    return ok(resetRequestOutcome(), 202);
  } catch (e) {
    return fail(e);
  }
}
