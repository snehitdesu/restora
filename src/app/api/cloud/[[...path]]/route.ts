import { z } from "zod";
import { prisma } from "@/server/db/client";
import { createRouter } from "@/server/api/router";
import { RATE_POLICIES } from "@/server/api/rateLimit";
import { assertCan } from "@/server/auth/rbac";
import { NotFoundError } from "@/server/db/scope";
import { connectCloud, disconnectCloud, syncStatus } from "@/server/sync/link";
import { dismissOperation, listOperations, retryNow } from "@/server/sync/runner";
import { desktopGuestQr } from "@/server/sync/guestQr";

export const runtime = "nodejs";

/** Cloud link management exists only in the installed desktop app; on the hosted deployment these endpoints do not exist. */
function desktopOnly() {
  if (process.env.AHAROS_DESKTOP !== "1") throw new NotFoundError("Unknown endpoint");
}

export const { GET, POST } = createRouter([
  { method: "GET", path: "status", handler: ({ ctx }) => { desktopOnly(); return syncStatus(prisma, ctx.organizationId); } },
  // Table QR codes for the hosted guest menu (cloud address + cloud table tokens); LOCAL when not linked.
  { method: "GET", path: "qr", handler: ({ ctx, query }) => { desktopOnly(); return desktopGuestQr(prisma, ctx, z.object({ outletId: z.string().min(1) }).parse(query).outletId); } },
  { method: "GET", path: "operations", handler: ({ ctx, query }) => { desktopOnly(); return listOperations(prisma, ctx.organizationId, { attention: query.attention === "1" }); } },
  { method: "POST", path: "connect", rateLimit: RATE_POLICIES.integrationAction, handler: ({ ctx, body }) => { desktopOnly(); return connectCloud(ctx, body as never, prisma); } },
  { method: "POST", path: "disconnect", rateLimit: RATE_POLICIES.integrationAction, handler: ({ ctx, body }) => { desktopOnly(); return disconnectCloud(ctx, prisma, { discardPending: z.object({ discardPending: z.boolean().optional() }).parse(body).discardPending }); } },
  // "Retry now": runs a cycle immediately and answers with its outcome.
  { method: "POST", path: "sync", rateLimit: RATE_POLICIES.integrationAction, handler: async ({ ctx }) => { desktopOnly(); assertCan(ctx, "order.view"); const cycle = await retryNow(prisma, ctx.organizationId); return { cycle, status: await syncStatus(prisma, ctx.organizationId) }; } },
  { method: "POST", path: "operations/:id/dismiss", handler: async ({ ctx, params }) => { desktopOnly(); assertCan(ctx, "order.modify"); await dismissOperation(prisma, ctx.organizationId, params.id); return { dismissed: true }; } },
]);
