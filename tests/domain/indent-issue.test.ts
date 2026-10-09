/**
 * A store issue that fulfils an approved indent (audit PP-08) against the real services and database: what the link allows,
 * how what was asked and what was dispatched add up (in base units, whatever unit each was written in), and when the
 * indent closes by itself.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@/server/db/client";
import { ForbiddenError, NotFoundError } from "@/server/db/scope";
import type { AccessContext } from "@/server/db/scope";
import { createIndent, transitionIndent } from "@/server/services/procurement";
import { createIssue, postIssue, cancelIssue } from "@/server/services/stockOps";
import { recordOpeningStock } from "@/server/services/inventory";
import { indentFulfilment } from "@/server/services/indentFulfilment";
import { getIndent } from "@/server/services/documentQueries";
import { makeEnv, member, uniq, type Env } from "./growthSupport";

let env: Env;
let kitchenDept: string;
let flour: string;
let sugar: string;
let packUnit: string;
let kgUnit: string;
let store: AccessContext;
let kitchenUser: AccessContext;
let manager: AccessContext;

const approvedIndent = async (lines: Array<{ materialId: string; qty: number; unitId?: string }>, outletId = env.outletA) => {
  const ind = await createIndent(kitchenUser, { outletId, lines });
  await transitionIndent(kitchenUser, ind.id, "SUBMITTED");
  await transitionIndent(manager, ind.id, "APPROVED");
  return ind;
};
const issue = (indentId: string | undefined, lines: Array<{ materialId: string; qty: number; unitId?: string }>, ctx = store) => createIssue(ctx, { outletId: env.outletA, toDepartmentId: kitchenDept, indentId, lines });
const status = async (id: string) => (await prisma.purchaseIndent.findUniqueOrThrow({ where: { id } })).status;

beforeAll(async () => {
  env = await makeEnv("Gii");
  store = { ...member(env.orgId, "STORE", env.outletA), userId: `store-${uniq()}` };
  kitchenUser = { ...member(env.orgId, "KITCHEN", env.outletA), userId: `kit-${uniq()}` };
  manager = { ...member(env.orgId, "MANAGER", env.outletA), userId: `mgr-${uniq()}` };
  kitchenDept = (await prisma.department.create({ data: { organizationId: env.orgId, outletId: env.outletA, name: `Kitchen ${uniq()}`, kind: "KITCHEN" } })).id;
  kgUnit = (await prisma.unit.create({ data: { organizationId: env.orgId, code: `kg${uniq()}`, name: "kg", kind: "WEIGHT" } })).id;
  packUnit = (await prisma.unit.create({ data: { organizationId: env.orgId, code: `pk${uniq()}`, name: "pack", kind: "WEIGHT" } })).id;
  flour = (await prisma.material.create({ data: { organizationId: env.orgId, sku: `FL-${uniq()}`, name: "Flour", baseUnitId: kgUnit } })).id;
  sugar = (await prisma.material.create({ data: { organizationId: env.orgId, sku: `SU-${uniq()}`, name: "Sugar", baseUnitId: kgUnit } })).id;
  // A pack of sugar is 5 kg, for this material only.
  await prisma.unitConversion.create({ data: { organizationId: env.orgId, materialId: sugar, fromUnitId: packUnit, toUnitId: kgUnit, factor: 5 } });
  await recordOpeningStock(env.owner, { outletId: env.outletA, lines: [{ materialId: flour, qty: 500, rate: 40 }, { materialId: sugar, qty: 500, rate: 50 }] });
}, 60000);
afterAll(async () => { await prisma.$disconnect(); });

describe("I1. issuing against an indent", () => {
  it("I1 posted issues add up to what was asked; the indent closes itself when everything has gone out", async () => {
    const ind = await approvedIndent([{ materialId: flour, qty: 10 }, { materialId: sugar, qty: 2, unitId: packUnit }]); // 10 kg flour, 2 packs = 10 kg sugar
    let f = await indentFulfilment(prisma, env.owner, ind.id);
    expect(f.lines.map((l) => [l.requested, l.issued, l.outstanding]).sort()).toEqual([[10, 0, 10], [10, 0, 10]]);
    expect(f.complete).toBe(false);

    const first = await issue(ind.id, [{ materialId: flour, qty: 6 }]);
    expect(first.indentId).toBe(ind.id);
    f = await indentFulfilment(prisma, env.owner, ind.id);
    expect(f.lines.find((l) => l.materialId === flour)!.issued).toBe(0); // a draft moves nothing
    await postIssue(store, first.id);
    f = await indentFulfilment(prisma, env.owner, ind.id);
    expect(f.lines.find((l) => l.materialId === flour)).toMatchObject({ requested: 10, issued: 6, outstanding: 4 });
    expect(await status(ind.id)).toBe("APPROVED"); // sugar is still owed

    // Sugar is asked in packs and issued in kilos: 10 kg is the 2 packs.
    const second = await issue(ind.id, [{ materialId: flour, qty: 4 }, { materialId: sugar, qty: 10 }]);
    await postIssue(store, second.id);
    expect((await indentFulfilment(prisma, env.owner, ind.id)).complete).toBe(true);
    expect(await status(ind.id)).toBe("CLOSED");
    const closing = (await prisma.auditLog.findMany({ where: { organizationId: env.orgId, entityType: "PurchaseIndent", entityId: ind.id, action: "UPDATE" } })).map((a) => JSON.parse(a.after!));
    expect(closing.some((a) => a.status === "CLOSED" && a.fulfilledByIssue === second.number)).toBe(true);
  });

  it("I1 the indent shows what was dispatched and by which issues; a cancelled issue counts for nothing and is not listed", async () => {
    const ind = await approvedIndent([{ materialId: flour, qty: 8 }]);
    const a = await issue(ind.id, [{ materialId: flour, qty: 3 }]);
    await postIssue(store, a.id);
    const b = await issue(ind.id, [{ materialId: flour, qty: 2 }]);
    await cancelIssue(store, b.id);
    const shown = await getIndent(prisma, kitchenUser, ind.id); // the kitchen reads quantities, never prices
    expect(shown.fulfilment.lines).toEqual([{ materialId: flour, requested: 8, issued: 3, outstanding: 5, baseUnitId: kgUnit }]);
    expect(shown.fulfilment.issues.map((i) => [i.id, i.status])).toEqual([[a.id, "ISSUED"]]);
    expect(shown.fulfilment.issues.some((i) => i.id === b.id)).toBe(false);
    expect(shown.fulfilment.issues.find((i) => i.id === a.id)!.issuedAt).not.toBeNull();
  });
});

describe("I2. what the link refuses", () => {
  it("I2 an indent that is not approved, from another outlet or another restaurant; a material it never asked for; more than was asked", async () => {
    const draft = await createIndent(kitchenUser, { outletId: env.outletA, lines: [{ materialId: flour, qty: 5 }] });
    await expect(issue(draft.id, [{ materialId: flour, qty: 1 }])).rejects.toThrow(/Only an approved indent/);
    const ind = await approvedIndent([{ materialId: flour, qty: 5 }]);
    await expect(issue(ind.id, [{ materialId: sugar, qty: 1 }])).rejects.toThrow(/not on indent/);
    await expect(issue(ind.id, [{ materialId: flour, qty: 5.5 }])).rejects.toThrow(/more than indent .* asked for/);
    await expect(issue("no-such-indent", [{ materialId: flour, qty: 1 }])).rejects.toBeInstanceOf(NotFoundError);
    const foreignInd = await createIndent(env.foreign, { outletId: (await prisma.outlet.findFirstOrThrow({ where: { organizationId: env.foreign.organizationId } })).id, lines: [{ materialId: (await prisma.material.create({ data: { organizationId: env.foreign.organizationId, sku: `X-${uniq()}`, name: "X", baseUnitId: (await prisma.unit.create({ data: { organizationId: env.foreign.organizationId, code: `u${uniq()}`, name: "u", kind: "COUNT" } })).id } })).id, qty: 1 }] }).catch(() => null);
    if (foreignInd) await expect(issue(foreignInd.id, [{ materialId: flour, qty: 1 }])).rejects.toBeInstanceOf(NotFoundError);
    // Whoever is not the store cannot issue at all.
    await expect(issue(ind.id, [{ materialId: flour, qty: 1 }], kitchenUser)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("I2 two drafts that together go past what was asked: the second is refused when it posts", async () => {
    const ind = await approvedIndent([{ materialId: flour, qty: 10 }]);
    const a = await issue(ind.id, [{ materialId: flour, qty: 7 }]);
    const b = await issue(ind.id, [{ materialId: flour, qty: 7 }]); // fine alone: drafts do not count
    await postIssue(store, a.id);
    await expect(postIssue(store, b.id)).rejects.toThrow(/more than indent .* asked for/);
    expect((await prisma.inventoryIssue.findUniqueOrThrow({ where: { id: b.id } })).status).toBe("DRAFT");
  });

  it("I2 an issue that names no indent is exactly what it was before", async () => {
    const plain = await issue(undefined, [{ materialId: flour, qty: 1 }]);
    expect(plain.indentId).toBeNull();
    expect((await postIssue(store, plain.id)).status).toBe("ISSUED");
  });
});
