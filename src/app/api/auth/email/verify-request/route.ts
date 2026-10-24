import type { NextRequest } from "next/server";
import { prisma } from "@/server/db/client";
import { SESSION_COOKIE } from "@/constants/auth";
import { resolveFromToken } from "@/server/auth/current-user";
import { requestEmailVerification } from "@/server/auth/emailVerification";
import { ok, fail } from "@/server/api/respond";
import { readAuthJson } from "@/server/api/authBody";
import { clientIp, enforceRateLimit, RATE_POLICIES } from "@/server/api/rateLimit";
import { UnauthorizedError } from "@/server/db/scope";

export const runtime = "nodejs";

/** Email the signed-in user a link that confirms their sign-in address. Fails loudly when email is not set up. */
export async function POST(req: NextRequest) {
  try {
    await readAuthJson(req);
    const current = await resolveFromToken(req.cookies.get(SESSION_COOKIE)?.value);
    if (!current) throw new UnauthorizedError();
    await enforceRateLimit(RATE_POLICIES.emailVerifyRequestPerUser, current.user.id);
    return ok(await requestEmailVerification(prisma, current.user.id, { ip: clientIp(req), userAgent: req.headers.get("user-agent") ?? undefined }));
  } catch (e) {
    return fail(e);
  }
}
