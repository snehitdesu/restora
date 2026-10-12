/**
 * Upsell hints for the person taking the order (audit ME-04, proposal p. 10: "brief staff to recommend it").
 *
 * For the dishes already on the order, suggest up to a few more that:
 *  - guests at this outlet really ordered together with them (paid orders in the last 60 days, at least 2 of them), or
 *  - menu engineering marks as a PUZZLE (high margin, rarely ordered: the proposal's advice is to recommend it) or a
 *    STAR (popular and profitable).
 * Never a dish that is sold out, switched off at this outlet or already on the order. A dish that is only profitable (no
 * pairing evidence) is suggested after the ones guests actually pair.
 *
 * The hint carries a reason in words and the menu price, never a margin or a cost: a captain does not hold recipe access,
 * and the classification is computed here with system authority only to rank, then dropped.
 */
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { type AccessContext, assertOutletAccess } from "@/server/db/scope";
import { assertCan } from "@/server/auth/rbac";
import { systemContext } from "@/server/auth/context";
import { menuEngineering, type MenuClass } from "@/server/services/menuEngineering";
import { listMenu } from "@/server/services/menu";

export const UPSELL_WINDOW_DAYS = 60;
export const UPSELL_MIN_PAIRS = 2;
export const UPSELL_MAX_ORDERS = 3000;
const CLASS_TTL_MS = 10 * 60_000;

const inputSchema = z.object({
  outletId: z.string().min(1),
  menuItemIds: z.array(z.string().min(1)).max(40).default([]),
  limit: z.number().int().min(1).max(5).default(3),
});

export type UpsellHint = {
  menuItemId: string;
  name: string;
  price: number;
  reason: "PAIRS_WITH" | "FEATURED" | "POPULAR";
  /** The dish on the order it goes with (PAIRS_WITH only). */
  with?: string;
  text: string;
};

// Menu engineering is the heavy part (it costs every recipe): the classes of an outlet change slowly, keep them 10 minutes.
const classCache = new Map<string, { at: number; classes: Map<string, MenuClass> }>();

export function clearUpsellCache() {
  classCache.clear();
}

async function classesFor(db: PrismaClient, organizationId: string, outletId: string, now: Date): Promise<Map<string, MenuClass>> {
  const key = `${organizationId}:${outletId}`;
  const hit = classCache.get(key);
  if (hit && now.getTime() - hit.at < CLASS_TTL_MS && now.getTime() >= hit.at) return hit.classes;
  const classes = new Map<string, MenuClass>();
  try {
    const r = await menuEngineering(db, systemContext(organizationId, [outletId]), { outletId, from: new Date(now.getTime() - UPSELL_WINDOW_DAYS * 86400_000), to: now });
    for (const row of r.rows) if (row.class) classes.set(row.menuItemId, row.class);
  } catch {
    /* no classification (no recipes / sales yet): pairing evidence alone is still useful */
  }
  classCache.set(key, { at: now.getTime(), classes });
  return classes;
}

export async function upsellSuggestions(db: PrismaClient, ctx: AccessContext, input: z.input<typeof inputSchema>, now = new Date(), opts: { classes?: Map<string, MenuClass> } = {}): Promise<UpsellHint[]> {
  const q = inputSchema.parse(input);
  assertOutletAccess(ctx, q.outletId);
  assertCan(ctx, "order.create", q.outletId);
  const inCart = new Set(q.menuItemIds);
  const menu = (await listMenu(db, ctx, { outletId: q.outletId, activeOnly: true })) as unknown as Array<{ id: string; name: string; effectivePrice: number; effectiveSoldOut: boolean }>;
  const byId = new Map(menu.map((m) => [m.id, m]));
  const cartNames = new Map([...inCart].filter((id) => byId.has(id)).map((id) => [id, byId.get(id)!.name]));
  if (!cartNames.size) return []; // nothing on the order yet: nothing to add to

  // Pairing evidence: paid orders at this outlet that contain at least one dish from the order.
  const pairs = new Map<string, { orders: number; withItem: Map<string, number> }>();
  if (cartNames.size) {
    const since = new Date(now.getTime() - UPSELL_WINDOW_DAYS * 86400_000);
    const seed = await db.orderItem.findMany({
      where: { organizationId: ctx.organizationId, outletId: q.outletId, menuItemId: { in: [...cartNames.keys()] }, order: { status: "PAID", createdAt: { gte: since } } },
      select: { orderId: true }, distinct: ["orderId"], take: UPSELL_MAX_ORDERS,
    });
    if (seed.length) {
      const lines = await db.orderItem.findMany({
        where: { organizationId: ctx.organizationId, orderId: { in: seed.map((s) => s.orderId) }, menuItemId: { not: null } },
        select: { orderId: true, menuItemId: true },
      });
      const perOrder = new Map<string, Set<string>>();
      for (const l of lines) (perOrder.get(l.orderId) ?? perOrder.set(l.orderId, new Set()).get(l.orderId)!).add(l.menuItemId!);
      for (const dishes of perOrder.values()) {
        const mine = [...dishes].filter((d) => cartNames.has(d));
        for (const other of dishes) {
          if (cartNames.has(other)) continue;
          const p = pairs.get(other) ?? pairs.set(other, { orders: 0, withItem: new Map() }).get(other)!;
          p.orders++;
          for (const m of mine) p.withItem.set(m, (p.withItem.get(m) ?? 0) + 1);
        }
      }
    }
  }

  const classes = opts.classes ?? (await classesFor(db, ctx.organizationId, q.outletId, now));
  const scored: Array<UpsellHint & { score: number }> = [];
  for (const m of menu) {
    if (inCart.has(m.id) || m.effectiveSoldOut) continue;
    const pair = pairs.get(m.id);
    const cls = classes.get(m.id);
    const paired = pair && pair.orders >= UPSELL_MIN_PAIRS;
    const profitable = cls === "PUZZLE" || cls === "STAR";
    if (!paired && !profitable) continue;
    const base = { menuItemId: m.id, name: m.name, price: m.effectivePrice };
    // Pairing is what guests do; profitability only breaks ties and fills the gaps.
    const score = (paired ? 10 + pair!.orders : 0) + (cls === "PUZZLE" ? 4 : cls === "STAR" ? 2 : 0);
    if (paired) {
      const [withId] = [...pair!.withItem.entries()].sort((a, b) => b[1] - a[1])[0];
      const withName = cartNames.get(withId)!;
      scored.push({ ...base, reason: "PAIRS_WITH", with: withName, text: `Guests often add it to ${withName}`, score });
    } else if (cls === "PUZZLE") scored.push({ ...base, reason: "FEATURED", text: "Worth recommending: guests who try it like it, few do", score });
    else scored.push({ ...base, reason: "POPULAR", text: "A house favourite", score });
  }
  return scored
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, q.limit)
    .map(({ score: _s, ...hint }) => { void _s; return hint; });
}
