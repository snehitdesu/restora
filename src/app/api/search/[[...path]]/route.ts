import { z } from "zod";
import { prisma } from "@/server/db/client";
import { createRouter } from "@/server/api/router";
import { universalSearch } from "@/server/services/search";
import { RATE_POLICIES } from "@/server/api/rateLimit";

export const runtime = "nodejs";

// One box for the whole back office. Each kind of result appears only if the caller may open that kind of thing.
export const { GET } = createRouter([
  { method: "GET", path: "", rateLimit: RATE_POLICIES.search, handler: ({ ctx, query }) => universalSearch(prisma, ctx, z.object({ q: z.string(), limit: z.coerce.number().int().min(1).max(10).optional() }).parse(query)) },
]);
