import type { NextRequest } from "next/server";
import { prisma } from "@/server/db/client";
import { confirmEmailVerification } from "@/server/auth/emailVerification";
import { ok, fail } from "@/server/api/respond";
import { readAuthJson } from "@/server/api/authBody";
import { clientIp, enforceRateLimit, RATE_POLICIES } from "@/server/api/rateLimit";

export const runtime = "nodejs";

/** Consume an emailed verification token (the /verify-email page posts it from the URL fragment). */
export async function POST(req: NextRequest) {
  try {
    const body = await readAuthJson(req);
    const ip = clientIp(req);
    await enforceRateLimit(RATE_POLICIES.emailVerifyPerIp, ip);
    return ok(await confirmEmailVerification(prisma, body as never, { ip, userAgent: req.headers.get("user-agent") ?? undefined }));
  } catch (e) {
    return fail(e);
  }
}
