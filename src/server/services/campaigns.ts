/**
 * Campaigns: a message to a segment of guests who said yes to marketing on that channel (proposal p. 17: weekend
 * specials to a segmented list; win-back; birthday).
 *
 *  - The audience is a rule set evaluated against real data at send time (consent, spend, visits, last visit, birthday /
 *    anniversary month, loyalty tier); nobody is stored in a list that can go stale.
 *  - Every recipient goes through `queueCustomerMessage`: consent, an address on the channel, quiet hours (the campaign
 *    waits for the morning), the weekly cap per guest, and a one-click unsubscribe link in the footer. Marketing is
 *    refused outright when the public base URL needed for that link is not configured.
 *  - Sending is resumable and idempotent: one recipient row per guest, the outbox key `camp:<id>:<guest>`, a guarded
 *    claim of the campaign, and a bounded batch per tick. A crash or a second worker cannot send anyone twice.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/server/db/client";
import { type AccessContext, ConflictError, NotFoundError, ValidationError } from "@/server/db/scope";
import { assertCan } from "@/server/auth/rbac";
import { systemContext } from "@/server/auth/context";
import { writeAudit } from "@/server/audit/log";
import { type Client, runInTx } from "@/server/services/_workflow";
import { messagingFor } from "@/server/services/integrations";
import { queueCustomerMessage } from "@/server/services/messaging";
import { unsubscribeToken } from "@/server/services/consent";
import { segmentFor, type Segment } from "@/server/services/crm";
import { MESSAGE_CHANNELS, normalizeEmail, normalizePhone, type MessageChannel } from "@/integrations/messaging";
import { D, money } from "@/domain/money";

export const CAMPAIGN_KINDS = ["MANUAL", "BIRTHDAY", "ANNIVERSARY", "WINBACK"] as const;
export const AUDIENCE_LIMIT = 20000;
/** Recipients sent per worker tick: a big campaign progresses over several ticks instead of one long request. */
export const CAMPAIGN_BATCH = 200;
export const PLACEHOLDERS = ["name", "code", "restaurant"] as const;

const audienceSchema = z.object({
  segment: z.enum(["NEW", "RETURNING", "VIP", "INACTIVE"]).optional(),
  minOrders: z.number().int().min(0).max(100000).optional(),
  minSpend: z.number().min(0).max(100_000_000).optional(),
  /** Last paid order older than this many days (guests with no order at all never match). */
  lastOrderBeforeDays: z.number().int().min(1).max(3650).optional(),
  lastOrderWithinDays: z.number().int().min(1).max(3650).optional(),
  birthdayMonth: z.number().int().min(1).max(12).optional(),
  anniversaryMonth: z.number().int().min(1).max(12).optional(),
  tier: z.string().trim().toUpperCase().max(20).optional(),
}).strict();
export type Audience = z.infer<typeof audienceSchema>;

const bodySchema = z.string().trim().min(5).max(600).superRefine((b, c) => {
  for (const m of b.matchAll(/\{(\w+)\}/g)) if (!(PLACEHOLDERS as readonly string[]).includes(m[1])) c.addIssue({ code: "custom", message: `Unknown placeholder {${m[1]}} (use ${PLACEHOLDERS.map((p) => `{${p}}`).join(", ")})` });
});

const campaignSchema = z.object({
  name: z.string().trim().min(2).max(80),
  channel: z.enum(MESSAGE_CHANNELS),
  kind: z.enum(CAMPAIGN_KINDS).default("MANUAL"),
  audience: audienceSchema.default({}),
  body: bodySchema,
  couponId: z.string().min(1).nullish(),
  scheduledAt: z.coerce.date().nullish(),
});

export type CampaignView = {
  id: string; name: string; channel: MessageChannel; kind: string; audience: Audience; body: string; couponId: string | null; status: string;
  scheduledAt: Date | null; startedAt: Date | null; completedAt: Date | null; recipientCount: number; createdAt: Date;
};
const view = (c: Prisma.CampaignGetPayload<object>): CampaignView => ({ id: c.id, name: c.name, channel: c.channel as MessageChannel, kind: c.kind, audience: JSON.parse(c.audience) as Audience, body: c.body, couponId: c.couponId, status: c.status, scheduledAt: c.scheduledAt, startedAt: c.startedAt, completedAt: c.completedAt, recipientCount: c.recipientCount, createdAt: c.createdAt });

// ---------------------------------------------------------------- audience

export type AudienceMember = { customerId: string; name: string };

/** Who matches right now: consented on the channel, reachable on it, and the rules. Bounded to AUDIENCE_LIMIT. */
export async function resolveAudience(db: PrismaClient, organizationId: string, channel: MessageChannel, audience: Audience, now = new Date()): Promise<AudienceMember[]> {
  const consents = await db.customerConsent.findMany({ where: { organizationId, channel, marketing: true }, select: { customerId: true }, take: AUDIENCE_LIMIT });
  if (!consents.length) return [];
  const ids = consents.map((c) => c.customerId);
  const customers: Array<{ id: string; name: string; phone: string | null; email: string | null; birthday: Date | null; anniversary: Date | null }> = [];
  for (let i = 0; i < ids.length; i += 500) customers.push(...(await db.customer.findMany({ where: { organizationId, id: { in: ids.slice(i, i + 500) } }, select: { id: true, name: true, phone: true, email: true, birthday: true, anniversary: true } })));
  const reachable = customers.filter((c) => (channel === "EMAIL" ? normalizeEmail(c.email) : normalizePhone(c.phone)));
  const needStats = audience.segment || audience.minOrders !== undefined || audience.minSpend !== undefined || audience.lastOrderBeforeDays !== undefined || audience.lastOrderWithinDays !== undefined;
  const stats = new Map<string, { orders: number; spend: number; last: Date | null }>();
  if (needStats) {
    for (let i = 0; i < reachable.length; i += 500) {
      const g = await db.order.groupBy({ by: ["customerId"], where: { organizationId, status: "PAID", customerId: { in: reachable.slice(i, i + 500).map((c) => c.id) } }, _count: true, _sum: { total: true }, _max: { paidAt: true, createdAt: true } });
      for (const r of g) if (r.customerId) stats.set(r.customerId, { orders: r._count, spend: money(D(r._sum.total ?? 0)).toNumber(), last: r._max.paidAt ?? r._max.createdAt ?? null });
    }
  }
  const tiers = audience.tier ? new Map((await db.loyaltyAccount.findMany({ where: { organizationId, customerId: { in: reachable.map((c) => c.id) } }, select: { customerId: true, tier: true } })).map((a) => [a.customerId, a.tier])) : null;
  const month = (d: Date | null) => (d ? d.getUTCMonth() + 1 : null);
  const out: AudienceMember[] = [];
  for (const c of reachable) {
    const s = stats.get(c.id) ?? { orders: 0, spend: 0, last: null };
    if (audience.segment && (segmentFor(s.orders, s.spend, s.last, now.getTime()) as Segment) !== audience.segment) continue;
    if (audience.minOrders !== undefined && s.orders < audience.minOrders) continue;
    if (audience.minSpend !== undefined && s.spend < audience.minSpend) continue;
    if (audience.lastOrderBeforeDays !== undefined && !(s.last && now.getTime() - s.last.getTime() > audience.lastOrderBeforeDays * 86400_000)) continue;
    if (audience.lastOrderWithinDays !== undefined && !(s.last && now.getTime() - s.last.getTime() <= audience.lastOrderWithinDays * 86400_000)) continue;
    if (audience.birthdayMonth !== undefined && month(c.birthday) !== audience.birthdayMonth) continue;
    if (audience.anniversaryMonth !== undefined && month(c.anniversary) !== audience.anniversaryMonth) continue;
    if (tiers && tiers.get(c.id) !== audience.tier) continue;
    out.push({ customerId: c.id, name: c.name });
  }
  return out;
}

/** The first name, then the rest of the template. */
export function renderBody(body: string, v: { name: string; code?: string | null; restaurant: string }): string {
  return body.replace(/\{(\w+)\}/g, (_m, k: string) => (k === "name" ? v.name.split(" ")[0] || "there" : k === "code" ? v.code ?? "" : k === "restaurant" ? v.restaurant : ""));
}

/** What every marketing message ends with: the one-click unsubscribe link. Throws without a public base URL. */
export function marketingFooter(customerId: string, channel: MessageChannel): string {
  const base = (process.env.PUBLIC_BASE_URL ?? "").replace(/\/+$/, "");
  if (!base) throw new ValidationError("PUBLIC_BASE_URL must be set so every marketing message can carry an unsubscribe link");
  return `\n\nUnsubscribe: ${base}/u/${unsubscribeToken(customerId, channel)}`;
}

// ---------------------------------------------------------------- commands

async function checkCampaign(db: PrismaClient | Prisma.TransactionClient, ctx: AccessContext, d: z.output<typeof campaignSchema>) {
  if (d.couponId) {
    const c = await db.coupon.findUnique({ where: { id: d.couponId }, select: { organizationId: true, active: true } });
    if (!c || c.organizationId !== ctx.organizationId || !c.active) throw new ValidationError("Choose an active coupon of this restaurant", { fieldErrors: { couponId: ["Unknown or inactive coupon"] } });
  } else if (/\{code\}/.test(d.body)) throw new ValidationError("The message uses {code} but no coupon is chosen", { fieldErrors: { couponId: ["Choose the coupon whose code to send"] } });
  if (d.audience.tier && !(await db.loyaltyTier.findFirst({ where: { organizationId: ctx.organizationId, code: d.audience.tier } }))) throw new ValidationError("That tier does not exist", { fieldErrors: { audience: ["Unknown tier"] } });
}

export async function createCampaign(ctx: AccessContext, input: z.input<typeof campaignSchema>, db: Client = prisma): Promise<CampaignView> {
  assertCan(ctx, "growth.manage");
  const d = campaignSchema.parse(input);
  return runInTx(db, async (tx) => {
    await checkCampaign(tx, ctx, d);
    const row = await tx.campaign.create({ data: { organizationId: ctx.organizationId, name: d.name, channel: d.channel, kind: d.kind, audience: JSON.stringify(d.audience), body: d.body, couponId: d.couponId ?? null, scheduledAt: d.scheduledAt ?? null, createdById: ctx.userId === "system" ? null : ctx.userId } });
    await writeAudit(tx, ctx, { action: "CREATE", entityType: "Campaign", entityId: row.id, after: { name: d.name, channel: d.channel, kind: d.kind, audience: d.audience } });
    return view(row);
  });
}

/** Edit a DRAFT. Once scheduled or sent a campaign is a record, not a form. */
export async function updateCampaign(ctx: AccessContext, id: string, patch: Partial<z.input<typeof campaignSchema>>, db: Client = prisma): Promise<CampaignView> {
  assertCan(ctx, "growth.manage");
  return runInTx(db, async (tx) => {
    const c = await tx.campaign.findUnique({ where: { id } });
    if (!c || c.organizationId !== ctx.organizationId) throw new NotFoundError("Campaign not found");
    if (c.status !== "DRAFT") throw new ConflictError("Only a draft can be edited");
    const v = view(c);
    const d = campaignSchema.parse({ name: v.name, channel: v.channel, kind: v.kind, audience: v.audience, body: v.body, couponId: v.couponId, scheduledAt: v.scheduledAt, ...patch });
    await checkCampaign(tx, ctx, d);
    const row = await tx.campaign.update({ where: { id }, data: { name: d.name, channel: d.channel, kind: d.kind, audience: JSON.stringify(d.audience), body: d.body, couponId: d.couponId ?? null, scheduledAt: d.scheduledAt ?? null } });
    await writeAudit(tx, ctx, { action: "UPDATE", entityType: "Campaign", entityId: id, before: v, after: view(row) });
    return view(row);
  });
}

export async function previewAudience(db: PrismaClient, ctx: AccessContext, input: { channel: MessageChannel; audience: unknown }) {
  assertCan(ctx, "growth.view");
  const channel = z.enum(MESSAGE_CHANNELS).parse(input.channel);
  const audience = audienceSchema.parse(input.audience ?? {});
  const members = await resolveAudience(db, ctx.organizationId, channel, audience);
  const optedIn = await db.customerConsent.count({ where: { organizationId: ctx.organizationId, channel, marketing: true } });
  return { matching: members.length, optedInOnChannel: optedIn, sample: members.slice(0, 8).map((m) => m.name) };
}

/** Schedule a draft (now, or at a time). Refuses what could never be sent: no provider, no base URL, nobody to send to. */
export async function scheduleCampaign(ctx: AccessContext, id: string, at?: Date | string | null, db: Client = prisma): Promise<CampaignView> {
  assertCan(ctx, "growth.manage");
  const when = at ? z.coerce.date().parse(at) : new Date();
  return runInTx(db, async (tx) => {
    const c = await tx.campaign.findUnique({ where: { id } });
    if (!c || c.organizationId !== ctx.organizationId) throw new NotFoundError("Campaign not found");
    if (c.status !== "DRAFT") throw new ConflictError("Only a draft can be scheduled");
    if (!(await messagingFor(tx as unknown as PrismaClient, ctx.organizationId, c.channel as MessageChannel))) throw new ValidationError(`Connect a ${c.channel} provider first (Integrations)`);
    if (!(process.env.PUBLIC_BASE_URL ?? "").trim()) throw new ValidationError("PUBLIC_BASE_URL must be set so every marketing message can carry an unsubscribe link");
    const matching = (await resolveAudience(tx as unknown as PrismaClient, ctx.organizationId, c.channel as MessageChannel, JSON.parse(c.audience) as Audience)).length;
    if (matching === 0) throw new ValidationError("Nobody matches this audience (guests must have agreed to offers on this channel)");
    const row = await tx.campaign.update({ where: { id }, data: { status: "SCHEDULED", scheduledAt: when } });
    await writeAudit(tx, ctx, { action: "UPDATE", entityType: "Campaign", entityId: id, before: { status: "DRAFT" }, after: { status: "SCHEDULED", scheduledAt: when, matching } });
    return view(row);
  });
}

export async function cancelCampaign(ctx: AccessContext, id: string, db: Client = prisma): Promise<CampaignView> {
  assertCan(ctx, "growth.manage");
  return runInTx(db, async (tx) => {
    const c = await tx.campaign.findUnique({ where: { id } });
    if (!c || c.organizationId !== ctx.organizationId) throw new NotFoundError("Campaign not found");
    if (!["DRAFT", "SCHEDULED", "SENDING"].includes(c.status)) throw new ConflictError(`A ${c.status.toLowerCase()} campaign cannot be cancelled`);
    // Whoever is still QUEUED is dropped; what was already sent stays sent.
    await tx.campaignRecipient.updateMany({ where: { campaignId: id, status: "QUEUED" }, data: { status: "SKIPPED", skipReason: "Campaign cancelled" } });
    const row = await tx.campaign.update({ where: { id }, data: { status: "CANCELLED", completedAt: new Date() } });
    await writeAudit(tx, ctx, { action: "VOID", entityType: "Campaign", entityId: id, before: { status: c.status }, after: { status: "CANCELLED" } });
    return view(row);
  });
}

export async function listCampaigns(db: PrismaClient, ctx: AccessContext, filter: { status?: string; take?: number } = {}) {
  assertCan(ctx, "growth.view");
  const rows = await db.campaign.findMany({ where: { organizationId: ctx.organizationId, ...(filter.status ? { status: filter.status } : {}) }, orderBy: { createdAt: "desc" }, take: Math.min(filter.take ?? 50, 200) });
  return rows.map(view);
}

export async function campaignDetail(db: PrismaClient, ctx: AccessContext, id: string) {
  assertCan(ctx, "growth.view");
  const c = await db.campaign.findUnique({ where: { id } });
  if (!c || c.organizationId !== ctx.organizationId) throw new NotFoundError("Campaign not found");
  const g = await db.campaignRecipient.groupBy({ by: ["status"], where: { campaignId: id }, _count: { _all: true } });
  const skips = await db.campaignRecipient.groupBy({ by: ["skipReason"], where: { campaignId: id, status: "SKIPPED" }, _count: { _all: true } });
  const delivered = await db.integrationDelivery.groupBy({ by: ["status"], where: { organizationId: ctx.organizationId, batchId: id, kind: "MESSAGE" }, _count: { _all: true } });
  return {
    campaign: view(c),
    recipients: Object.fromEntries(g.map((x) => [x.status, x._count._all])),
    skippedBecause: skips.map((x) => ({ reason: x.skipReason ?? "", count: x._count._all })),
    deliveries: Object.fromEntries(delivered.map((x) => [x.status, x._count._all])),
  };
}

// ---------------------------------------------------------------- sending (scheduled job)

export type CampaignRunResult = { campaigns: number; sent: number; skipped: number; deferred: number; completed: number };

/** Advance every campaign that is due. Safe to run from several workers and repeatedly. */
export async function runCampaigns(db: PrismaClient = prisma, now = new Date(), organizationId?: string): Promise<CampaignRunResult> {
  const res: CampaignRunResult = { campaigns: 0, sent: 0, skipped: 0, deferred: 0, completed: 0 };
  const due = await db.campaign.findMany({ where: { status: { in: ["SCHEDULED", "SENDING"] }, scheduledAt: { lte: now }, ...(organizationId ? { organizationId } : {}) }, orderBy: { scheduledAt: "asc" }, take: 20 });
  for (const c of due) {
    // Claim: a scheduled campaign starts exactly once; a SENDING one is resumed by whoever gets here.
    if (c.status === "SCHEDULED") {
      const claimed = await db.campaign.updateMany({ where: { id: c.id, status: "SCHEDULED" }, data: { status: "SENDING", startedAt: now } });
      if (claimed.count !== 1) continue;
      const members = await resolveAudience(db, c.organizationId, c.channel as MessageChannel, JSON.parse(c.audience) as Audience, now);
      for (let i = 0; i < members.length; i += 500) await db.campaignRecipient.createMany({ data: members.slice(i, i + 500).map((m) => ({ organizationId: c.organizationId, campaignId: c.id, customerId: m.customerId })) });
      await db.campaign.update({ where: { id: c.id }, data: { recipientCount: members.length } });
    }
    res.campaigns++;
    const ctx = systemContext(c.organizationId);
    const coupon = c.couponId ? await db.coupon.findUnique({ where: { id: c.couponId }, select: { code: true, active: true } }) : null;
    const org = await db.organization.findUnique({ where: { id: c.organizationId }, select: { name: true } });
    const batch = await db.campaignRecipient.findMany({ where: { campaignId: c.id, status: "QUEUED" }, orderBy: { id: "asc" }, take: CAMPAIGN_BATCH });
    let deferred = false;
    for (const r of batch) {
      const cust = await db.customer.findUnique({ where: { id: r.customerId }, select: { name: true } });
      let body: string;
      try {
        body = renderBody(c.body, { name: cust?.name ?? "", code: coupon?.active ? coupon.code : "", restaurant: org?.name ?? "" }) + marketingFooter(r.customerId, c.channel as MessageChannel);
      } catch (e) {
        await db.campaignRecipient.update({ where: { id: r.id }, data: { status: "SKIPPED", skipReason: e instanceof Error ? e.message : "Could not build the message" } });
        res.skipped++;
        continue;
      }
      const q = await queueCustomerMessage(ctx, { customerId: r.customerId, channel: c.channel as MessageChannel, purpose: "MARKETING", key: `camp:${c.id}:${r.customerId}`, template: `CAMPAIGN_${c.kind}`, subject: c.name, body, batchId: c.id, now }, db);
      if (q.status === "DEFERRED") { res.deferred++; deferred = true; break; }
      if (q.status === "QUEUED" || q.status === "DUPLICATE") {
        await db.campaignRecipient.update({ where: { id: r.id }, data: { status: "SENT", deliveryId: q.deliveryId ?? null } });
        res.sent++;
      } else {
        await db.campaignRecipient.update({ where: { id: r.id }, data: { status: "SKIPPED", skipReason: q.reason ?? "Skipped" } });
        res.skipped++;
      }
    }
    if (!deferred && (await db.campaignRecipient.count({ where: { campaignId: c.id, status: "QUEUED" } })) === 0) {
      await db.campaign.updateMany({ where: { id: c.id, status: "SENDING" }, data: { status: "SENT", completedAt: now } });
      await db.$transaction((tx) => writeAudit(tx, ctx, { action: "UPDATE", entityType: "Campaign", entityId: c.id, before: { status: "SENDING" }, after: { status: "SENT" } }));
      res.completed++;
    }
  }
  return res;
}
