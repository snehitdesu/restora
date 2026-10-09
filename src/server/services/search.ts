/**
 * Universal search (audit PA-05, proposal p. 12: "find anything from one box, with a keyboard shortcut").
 *
 * One query, several kinds of things, each group included only when the caller holds the permission that opens that
 * kind of thing anywhere else in the app (a cashier searching "paneer" does not learn what the vendor charges). Every read
 * is scoped to the caller's organization; things that belong to an outlet (orders, tables, purchase orders) are limited to
 * the outlets the caller can access. The text match is case-insensitive on SQLite and PostgreSQL alike.
 */
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import type { AccessContext } from "@/server/db/scope";
import { can } from "@/server/auth/rbac";
import { textContains } from "@/server/db/search";

export const SEARCH_MIN_CHARS = 2;
export const SEARCH_PER_GROUP = 5;

const inputSchema = z.object({ q: z.string().trim().min(SEARCH_MIN_CHARS).max(60), limit: z.number().int().min(1).max(10).default(SEARCH_PER_GROUP) });

export type SearchItem = { id: string; title: string; subtitle: string | null; href: string };
export type SearchGroup = { type: "customer" | "menu" | "material" | "vendor" | "recipe" | "order" | "purchase-order" | "table" | "staff"; label: string; items: SearchItem[] };

/** Outlets whose rows the caller may see (everything of the organization for org-wide roles). */
function outletFilter(ctx: AccessContext) {
  return ctx.isOrgWide || ctx.isSuperAdmin ? {} : { outletId: { in: ctx.outletIds } };
}

export async function universalSearch(db: PrismaClient, ctx: AccessContext, input: z.input<typeof inputSchema>): Promise<{ q: string; groups: SearchGroup[] }> {
  const { q, limit } = inputSchema.parse(input);
  const org = ctx.organizationId;
  const like = textContains(q);
  // LIKE treats % and _ as wildcards (Prisma does not escape them): a query that contains one reads wider rows and keeps only
  // those that really contain the typed text, so "50%" finds "50%" and not everything.
  const wild = /[%_]/.test(q);
  const take = wild ? limit * 20 : limit;
  const ql = q.toLowerCase();
  const literal = (...values: Array<string | null | undefined>) => !wild || values.some((v) => (v ?? "").toLowerCase().includes(ql));
  const groups: SearchGroup[] = [];
  const add = (type: SearchGroup["type"], label: string, items: SearchItem[]) => { if (items.length) groups.push({ type, label, items: items.slice(0, limit) }); };
  const orderAccess = outletFilter(ctx);

  const jobs: Array<Promise<void>> = [];
  if (can(ctx, "customer.view")) {
    jobs.push(db.customer.findMany({ where: { organizationId: org, OR: [{ name: like }, { phone: { contains: q.replace(/[\s()+-]/g, "") || q } }, { email: like }] }, orderBy: { name: "asc" }, take, select: { id: true, name: true, phone: true, email: true } })
      .then((rows) => add("customer", "Customers", rows.filter((c) => literal(c.name, c.phone, c.email)).map((c) => ({ id: c.id, title: c.name, subtitle: [c.phone, c.email].filter(Boolean).join(" · ") || null, href: `/customers/${c.id}` })))));
  }
  if (can(ctx, "menu.view")) {
    jobs.push(db.menuItem.findMany({ where: { organizationId: org, name: like }, orderBy: { name: "asc" }, take, select: { id: true, name: true, active: true, category: { select: { name: true } } } })
      .then((rows) => add("menu", "Menu items", rows.filter((m) => literal(m.name)).map((m) => ({ id: m.id, title: m.name, subtitle: [m.category?.name, m.active ? null : "inactive"].filter(Boolean).join(" · ") || null, href: `/menu/items/${m.id}` })))));
  }
  if (can(ctx, "master.view")) {
    jobs.push(db.material.findMany({ where: { organizationId: org, OR: [{ name: like }, { sku: like }] }, orderBy: { name: "asc" }, take, select: { id: true, name: true, sku: true } })
      .then((rows) => add("material", "Materials", rows.filter((m) => literal(m.name, m.sku)).map((m) => ({ id: m.id, title: m.name, subtitle: m.sku, href: `/master/materials/${m.id}` })))));
  }
  if (can(ctx, "vendor.view")) {
    jobs.push(db.vendor.findMany({ where: { organizationId: org, OR: [{ name: like }, { companyName: like }] }, orderBy: { name: "asc" }, take, select: { id: true, name: true, companyName: true } })
      .then((rows) => add("vendor", "Vendors", rows.filter((v) => literal(v.name, v.companyName)).map((v) => ({ id: v.id, title: v.name, subtitle: v.companyName && v.companyName !== v.name ? v.companyName : null, href: `/master/vendors/${v.id}` })))));
  }
  if (can(ctx, "recipe.view")) {
    jobs.push(db.recipe.findMany({ where: { organizationId: org, name: like }, orderBy: { name: "asc" }, take, select: { id: true, name: true, outputType: true } })
      .then((rows) => add("recipe", "Recipes", rows.filter((r) => literal(r.name)).map((r) => ({ id: r.id, title: r.name, subtitle: r.outputType === "SUB_RECIPE" ? "sub-recipe" : null, href: `/recipes/${r.id}` })))));
  }
  if (can(ctx, "order.view")) {
    // An invoice number, or the reference printed on KOTs and bills (the last characters of the id).
    jobs.push(db.order.findMany({
      where: { organizationId: org, ...orderAccess, OR: [{ invoiceNo: like }, ...(q.length >= 4 ? [{ id: { endsWith: q.toLowerCase() } }] : [])] },
      orderBy: { createdAt: "desc" }, take, select: { id: true, invoiceNo: true, status: true, channel: true, total: true, table: { select: { code: true } } },
    }).then((rows) => add("order", "Orders", rows.filter((o) => literal(o.invoiceNo)).map((o) => ({ id: o.id, title: o.invoiceNo ? `Invoice ${o.invoiceNo}` : `Order #${o.id.slice(-6).toUpperCase()}`, subtitle: [o.table ? `Table ${o.table.code}` : o.channel.toLowerCase(), o.status.toLowerCase(), `₹${Number(o.total).toFixed(2)}`].join(" · "), href: `/pos/bill/${o.id}` })))));
    jobs.push(db.restaurantTable.findMany({ where: { organizationId: org, ...orderAccess, code: like }, orderBy: { code: "asc" }, take, select: { id: true, code: true, status: true } })
      .then((rows) => add("table", "Tables", rows.filter((t) => literal(t.code)).map((t) => ({ id: t.id, title: `Table ${t.code}`, subtitle: t.status.toLowerCase().replace(/_/g, " "), href: "/tables" })))));
  }
  if (can(ctx, "purchase.view")) {
    jobs.push(db.purchaseOrder.findMany({ where: { organizationId: org, ...orderAccess, number: like }, orderBy: { createdAt: "desc" }, take, select: { id: true, number: true, status: true } })
      .then((rows) => add("purchase-order", "Purchase orders", rows.filter((p) => literal(p.number)).map((p) => ({ id: p.id, title: p.number, subtitle: p.status.toLowerCase(), href: `/procurement/purchase-orders/${p.id}` })))));
  }
  if (can(ctx, "staff.manage")) {
    jobs.push(db.user.findMany({ where: { organizationId: org, OR: [{ name: like }, { email: like }] }, orderBy: { name: "asc" }, take, select: { id: true, name: true, email: true, active: true } })
      .then((rows) => add("staff", "Staff", rows.filter((u) => literal(u.name, u.email)).map((u) => ({ id: u.id, title: u.name, subtitle: [u.email, u.active ? null : "inactive"].filter(Boolean).join(" · "), href: "/staff" })))));
  }
  await Promise.all(jobs);
  const order: SearchGroup["type"][] = ["order", "customer", "menu", "table", "material", "vendor", "recipe", "purchase-order", "staff"];
  groups.sort((a, b) => order.indexOf(a.type) - order.indexOf(b.type));
  return { q, groups };
}
