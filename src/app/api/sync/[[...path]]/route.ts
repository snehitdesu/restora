import { z } from "zod";
import { prisma } from "@/server/db/client";
import { createRouter } from "@/server/api/router";
import { RATE_POLICIES, clientIp, enforceRateLimit } from "@/server/api/rateLimit";
import { getSyncOrder, listOrderFeed, listSyncGuestQr, listSyncOutlets, applySyncOp } from "@/server/sync/cloudFeed";
import { completePairing, createPairing, createPairingSchema, enrollSchema, enrollWithPassword, listDevices, revokeDevice, revokeSelf } from "@/server/sync/device";
import { syncOpSchema } from "@/lib/sync/wire";

export const runtime = "nodejs";

const feedQuery = z.object({
  outletId: z.string().min(1),
  cursor: z.string().max(100).optional(),
  take: z.coerce.number().int().positive().max(100).optional(),
  backfillHours: z.coerce.number().int().positive().max(24 * 14).optional(),
  includeActive: z.enum(["0", "1"]).optional(),
  rewindSeconds: z.coerce.number().int().min(0).max(300).optional(),
});

/** Desktop sync API: pairing/enrollment, scoped feed of online orders, idempotent actions. */
export const { GET, POST, PATCH, DELETE } = createRouter([
  { method: "POST", path: "pair", rateLimit: RATE_POLICIES.integrationAction, handler: ({ ctx, body }) => createPairing(prisma, ctx, createPairingSchema.parse(body)) },
  {
    method: "POST",
    path: "pair/complete",
    public: true,
    rateLimit: RATE_POLICIES.loginPerIp,
    rateLimitByIp: true,
    handler: ({ body, req }) => completePairing(prisma, body as never, { ip: clientIp(req), userAgent: req.headers.get("user-agent") ?? undefined }),
  },
  {
    method: "POST",
    path: "enroll",
    public: true,
    rateLimit: RATE_POLICIES.loginPerIp,
    rateLimitByIp: true,
    handler: async ({ body, req }) => {
      const data = enrollSchema.parse(body);
      await enforceRateLimit(RATE_POLICIES.loginPerEmail, data.email.toLowerCase());
      return enrollWithPassword(prisma, data, { ip: clientIp(req), userAgent: req.headers.get("user-agent") ?? undefined });
    },
  },
  { method: "GET", path: "devices", rateLimit: RATE_POLICIES.syncPerUser, handler: ({ ctx }) => listDevices(prisma, ctx) },
  { method: "POST", path: "device/revoke", rateLimit: RATE_POLICIES.syncPerUser, handler: ({ ctx, deviceId }) => revokeSelf(prisma, ctx, deviceId) },
  { method: "POST", path: "devices/:id/revoke", rateLimit: RATE_POLICIES.integrationAction, handler: ({ ctx, params }) => revokeDevice(prisma, ctx, params.id) },
  { method: "GET", path: "outlets", rateLimit: RATE_POLICIES.syncPerUser, handler: ({ ctx }) => listSyncOutlets(prisma, ctx) },
  { method: "GET", path: "qr", rateLimit: RATE_POLICIES.syncPerUser, handler: ({ ctx, query }) => listSyncGuestQr(prisma, ctx, z.object({ outletId: z.string().min(1) }).parse(query).outletId) },
  { method: "GET", path: "orders", rateLimit: RATE_POLICIES.syncPerUser, handler: ({ ctx, query }) => { const q = feedQuery.parse(query); return listOrderFeed(prisma, ctx, { ...q, includeActive: q.includeActive === "1" }); } },
  { method: "GET", path: "orders/:id", rateLimit: RATE_POLICIES.syncPerUser, handler: ({ ctx, params }) => getSyncOrder(prisma, ctx, params.id) },
  { method: "POST", path: "ops", rateLimit: RATE_POLICIES.syncPerUser, handler: ({ ctx, body }) => applySyncOp(ctx, syncOpSchema.parse(body)) },
]);
