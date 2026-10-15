/**
 * Desktop side: mirror one cloud order (as delivered by /api/sync) into the local SQLite cache, idempotently.
 *
 * The local copy is a CACHE of the cloud order, not a competing record of it:
 *   - every mirrored record carries a deterministic local id (lib/sync/ids.ts) and a CloudRecordMap row;
 *   - the order's status, lines, tickets and payments are copied exactly as the cloud has them — totals are the
 *     cloud's snapshot, nothing is re-priced, no stock is consumed (stockConsumed = true), no invoice is issued;
 *   - re-mirroring the same revision is a no-op, an older state never replaces a newer one, and a crash half way
 *     rolls the whole transaction back;
 *   - tables, dishes and add-ons are matched to the local menu by their natural keys (table code, dish name, add-on
 *     name). Whatever cannot be matched is recorded as an "issue": the order is still shown (nothing is lost) but
 *     it cannot be accepted on this desktop until the menu / floor plan is fixed.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import { mirrorId } from "@/lib/sync/ids";
import type { WireOrder } from "@/lib/sync/wire";
import { systemContext } from "@/server/auth/context";
import { writeAudit } from "@/server/audit/log";
import { createNotificationTx } from "@/server/services/notifications";
import { nextKotNumber } from "@/server/services/kot";
import { runInTx } from "@/server/services/_workflow";

type Tx = Prisma.TransactionClient;
export type MirrorTarget = { organizationId: string; localOutletId: string; cloudOutletId: string };
export type MirrorResult = { action: "created" | "updated" | "unchanged" | "stale"; localOrderId: string; issues: string[] };

const isUnique = (e: unknown) => (e as { code?: string })?.code === "P2002";

/** Stored as "<cloud updatedAt>|<revision>": lets a late, older page be recognised and ignored. */
const packRevision = (o: WireOrder) => `${o.updatedAt}|${o.revision}`;

function guestNote(o: WireOrder): string | null {
  const parts = [o.guestName ? `Guest: ${o.guestName}` : null, o.notes].filter(Boolean);
  return parts.length ? parts.join(" · ").slice(0, 600) : null;
}

async function findIssues(tx: Tx, t: MirrorTarget, o: WireOrder): Promise<{ issues: string[]; tableId: string | null; itemIds: Map<string, string | null> }> {
  const issues: string[] = [];
  let tableId: string | null = null;
  if (o.tableCode) {
    const table = await tx.restaurantTable.findUnique({ where: { outletId_code: { outletId: t.localOutletId, code: o.tableCode } }, select: { id: true } });
    if (table) tableId = table.id;
    else issues.push(`Table ${o.tableCode} is not on this desktop's floor plan`);
  }
  const names = [...new Set(o.items.map((i) => i.menuItemName).filter((n): n is string => Boolean(n)))];
  const menu = names.length
    ? await tx.menuItem.findMany({
        where: { organizationId: t.organizationId, name: { in: names } },
        select: { id: true, name: true, modifierGroups: { select: { group: { select: { name: true, options: { where: { active: true }, select: { name: true } } } } } } },
      })
    : [];
  const byName = new Map(menu.map((m) => [m.name, m]));
  const itemIds = new Map<string, string | null>();
  for (const i of o.items) {
    const local = i.menuItemName ? byName.get(i.menuItemName) : undefined;
    itemIds.set(i.id, local?.id ?? null);
    if (!local) {
      issues.push(`"${i.menuItemName ?? i.name}" is not on this desktop's menu`);
      continue;
    }
    // An order line stores an add-on as "<group>: <option>".
    const options = new Set(local.modifierGroups.flatMap((g) => g.group.options.map((x) => `${g.group.name}: ${x.name}`)));
    for (const m of i.modifiers) if (!options.has(m.name)) issues.push(`Add-on "${m.name}" of "${i.name}" is not on this desktop's menu`);
  }
  return { issues, tableId, itemIds };
}

export async function mirrorOrder(db: PrismaClient, t: MirrorTarget, wire: WireOrder): Promise<MirrorResult> {
  if (wire.outletId !== t.cloudOutletId) throw new Error("Order belongs to a different cloud outlet than this link");
  const localId = mirrorId("ORDER", wire.id, t.organizationId);
  try {
    return await runInTx(db, (tx) => mirrorTx(tx, t, wire, localId));
  } catch (e) {
    // Two cycles raced on the same new order: the loser's insert hit the unique index. The winner's row is complete.
    if (isUnique(e)) {
      const map = await db.cloudRecordMap.findUnique({ where: { organizationId_kind_cloudId: { organizationId: t.organizationId, kind: "ORDER", cloudId: wire.id } } });
      if (map?.revision === packRevision(wire)) return { action: "unchanged", localOrderId: localId, issues: JSON.parse(map.issues ?? "[]") };
      return runInTx(db, (tx) => mirrorTx(tx, t, wire, localId));
    }
    throw e;
  }
}

async function mirrorTx(tx: Tx, t: MirrorTarget, wire: WireOrder, localId: string): Promise<MirrorResult> {
  const map = await tx.cloudRecordMap.findUnique({ where: { organizationId_kind_cloudId: { organizationId: t.organizationId, kind: "ORDER", cloudId: wire.id } } });
  const incoming = packRevision(wire);
  if (map?.revision === incoming) return { action: "unchanged", localOrderId: map.localId, issues: JSON.parse(map.issues ?? "[]") };
  if (map?.revision && map.revision.split("|")[0] > wire.updatedAt) return { action: "stale", localOrderId: map.localId, issues: JSON.parse(map.issues ?? "[]") };

  const { issues, tableId, itemIds } = await findIssues(tx, t, wire);
  const orderData = {
    channel: wire.channel,
    source: wire.source,
    tableId,
    status: wire.status,
    covers: wire.covers,
    notes: guestNote(wire),
    subtotal: wire.subtotal,
    discount: wire.discount,
    tax: wire.tax,
    total: wire.total,
    paidAt: wire.paidAt ? new Date(wire.paidAt) : null,
  };

  if (!map) {
    await tx.order.create({
      data: { id: localId, organizationId: t.organizationId, outletId: t.localOutletId, externalRef: wire.id, stockConsumed: true, createdAt: new Date(wire.createdAt), ...orderData },
    });
  } else {
    await tx.order.update({ where: { id: map.localId }, data: orderData });
  }

  // ----- lines (the cloud's set wins wholesale: a mirrored order cannot be edited on the desktop) -----
  const wantedItems = new Set(wire.items.map((i) => mirrorId("ORDER_ITEM", i.id, t.organizationId)));
  const existingItems = await tx.orderItem.findMany({ where: { orderId: localId }, select: { id: true } });
  const stale = existingItems.filter((i) => !wantedItems.has(i.id)).map((i) => i.id);
  if (stale.length) {
    await tx.kotItem.deleteMany({ where: { orderItemId: { in: stale } } });
    await tx.orderItem.deleteMany({ where: { id: { in: stale } } });
    await tx.cloudRecordMap.deleteMany({ where: { organizationId: t.organizationId, kind: "ORDER_ITEM", localId: { in: stale } } });
  }
  const knownItems = new Set(existingItems.map((i) => i.id));
  for (const i of wire.items) {
    const id = mirrorId("ORDER_ITEM", i.id, t.organizationId);
    const data = {
      menuItemId: itemIds.get(i.id) ?? null,
      posItemCode: itemIds.get(i.id) ? null : i.menuItemName ?? i.id,
      name: i.name,
      qty: i.qty,
      unitPrice: i.unitPrice,
      discount: i.discount,
      taxPct: i.taxPct,
      lineTotal: i.lineTotal,
      hsnSac: i.hsnSac,
      station: i.station,
      notes: i.notes,
    };
    if (knownItems.has(id)) {
      await tx.orderItem.update({ where: { id }, data });
      await tx.orderItemModifier.deleteMany({ where: { orderItemId: id } });
    } else {
      await tx.orderItem.create({ data: { id, organizationId: t.organizationId, outletId: t.localOutletId, orderId: localId, ...data } });
    }
    if (i.modifiers.length) await tx.orderItemModifier.createMany({ data: i.modifiers.map((m) => ({ orderItemId: id, name: m.name, priceDelta: m.priceDelta })) });
  }

  // ----- kitchen tickets -----
  for (const k of wire.kots) {
    const id = mirrorId("KOT", k.id, t.organizationId);
    const stamps = { acceptedAt: k.acceptedAt ? new Date(k.acceptedAt) : null, startedAt: k.startedAt ? new Date(k.startedAt) : null, readyAt: k.readyAt ? new Date(k.readyAt) : null, servedAt: k.servedAt ? new Date(k.servedAt) : null };
    const existing = await tx.kot.findUnique({ where: { id }, select: { id: true } });
    if (existing) {
      await tx.kot.update({ where: { id }, data: { status: k.status, ...stamps } });
      await tx.kotItem.updateMany({ where: { kotId: id }, data: { status: k.status } });
      continue;
    }
    const station = k.station ? await tx.kitchenStation.findFirst({ where: { outletId: t.localOutletId, name: k.station }, select: { id: true } }) : null;
    await tx.kot.create({
      data: {
        id,
        organizationId: t.organizationId,
        outletId: t.localOutletId,
        orderId: localId,
        stationId: station?.id ?? null,
        // Local ticket numbers stay a gap-free local series; the cloud's number is kept in the mapping's traceability, not reused.
        number: await nextKotNumber(tx, t.localOutletId),
        status: k.status,
        // Already shown at the pass by the cloud workflow: the desktop must not auto-print it as if newly sent.
        printedAt: new Date(k.createdAt),
        createdAt: new Date(k.createdAt),
        ...stamps,
        items: { create: k.items.map((ki) => ({ orderItemId: ki.orderItemId ? mirrorId("ORDER_ITEM", ki.orderItemId, t.organizationId) : null, name: ki.name, qty: ki.qty, status: ki.status })) },
      },
    });
  }

  // ----- payments (copied as verified by the cloud; the desktop never decides a payment's success) -----
  for (const p of wire.payments) {
    const id = mirrorId("PAYMENT", p.id, t.organizationId);
    const data = { method: p.method, status: p.status, amount: p.amount, verifiedAt: p.verifiedAt ? new Date(p.verifiedAt) : null };
    const existing = await tx.payment.findUnique({ where: { id }, select: { id: true } });
    if (existing) await tx.payment.update({ where: { id }, data });
    else await tx.payment.create({ data: { id, organizationId: t.organizationId, outletId: t.localOutletId, orderId: localId, provider: "cloud", providerRef: p.id, createdAt: new Date(p.createdAt), ...data } });
  }

  // ----- mappings -----
  const mappings: Array<[string, string, string]> = [
    ...wire.items.map((i) => ["ORDER_ITEM", i.id, mirrorId("ORDER_ITEM", i.id, t.organizationId)] as [string, string, string]),
    ...wire.kots.map((k) => ["KOT", k.id, mirrorId("KOT", k.id, t.organizationId)] as [string, string, string]),
    ...wire.payments.map((p) => ["PAYMENT", p.id, mirrorId("PAYMENT", p.id, t.organizationId)] as [string, string, string]),
  ];
  for (const [kind, cloudId, mapped] of mappings) {
    await tx.cloudRecordMap.upsert({
      where: { organizationId_kind_cloudId: { organizationId: t.organizationId, kind, cloudId } },
      create: { organizationId: t.organizationId, kind, cloudId, localId: mapped },
      update: {},
    });
  }
  await tx.cloudRecordMap.upsert({
    where: { organizationId_kind_cloudId: { organizationId: t.organizationId, kind: "ORDER", cloudId: wire.id } },
    create: { organizationId: t.organizationId, kind: "ORDER", cloudId: wire.id, localId, revision: incoming, issues: JSON.stringify(issues) },
    update: { revision: incoming, issues: JSON.stringify(issues) },
  });

  if (!map) {
    const ctx = systemContext(t.organizationId, [t.localOutletId]);
    await writeAudit(tx, ctx, { action: "CREATE", entityType: "Order", entityId: localId, outletId: t.localOutletId, after: { via: "cloud-sync", cloudOrder: wire.ref, source: wire.source, total: wire.total } });
    // The desktop's alert centre rings for a QR order just as the hosted POS's does.
    if (wire.status === "OPEN") {
      await createNotificationTx(tx, ctx, { outletId: t.localOutletId, type: "NEW_ORDER", title: `New QR order · table ${wire.tableCode ?? "?"}`, body: `${wire.ref} · ₹${Number(wire.total).toFixed(2)} — waiting to be accepted` });
    }
  }
  return { action: map ? "updated" : "created", localOrderId: localId, issues };
}
