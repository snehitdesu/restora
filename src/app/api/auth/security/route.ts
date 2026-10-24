import type { NextRequest } from "next/server";
import { prisma } from "@/server/db/client";
import { SESSION_COOKIE } from "@/constants/auth";
import { resolveFromToken } from "@/server/auth/current-user";
import { recoveryStatus } from "@/server/auth/recoveryCodes";
import { emailDeliveryStatus } from "@/server/auth/securityMail";
import { ok, fail } from "@/server/api/respond";
import { UnauthorizedError } from "@/server/db/scope";

export const runtime = "nodejs";

/** The signed-in user's recovery set-up: verified email, email delivery, recovery codes, owner count. */
export async function GET(req: NextRequest) {
  try {
    const current = await resolveFromToken(req.cookies.get(SESSION_COOKIE)?.value);
    if (!current) throw new UnauthorizedError();
    const user = await prisma.user.findUniqueOrThrow({ where: { id: current.user.id }, select: { email: true, emailVerifiedAt: true } });
    const recovery = await recoveryStatus(prisma, current.user.id);
    return ok({ email: user.email, emailVerifiedAt: user.emailVerifiedAt, emailDelivery: emailDeliveryStatus(), recovery }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return fail(e);
  }
}
