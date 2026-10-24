/**
 * Approval rules for purchase orders (audit PP-07, proposal p. 5 and p. 18: "skip approval for small orders, a second approver
 * for large ones") and the line-level review an approver can do before approving (audit PP-06).
 *
 * The rules are the organization's, set by whoever holds org.manage (the owner), and both are optional:
 *   autoApproveBelow       an order whose total is at or below this is approved the moment it is submitted
 *   dualApprovalAtOrAbove  an order whose total is at or above this needs two different approvers
 * Neither set (the default): every order waits for one approver. The plan is decided from the order's total at the moment
 * somebody submits or approves it, so a line review that changes the total changes what is asked of the approvers.
 */
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { type AccessContext, ValidationError } from "@/server/db/scope";
import { assertCan } from "@/server/auth/rbac";
import { writeAudit } from "@/server/audit/log";
import { D, money, num, type Decimalish } from "@/domain/money";
import { runInTx, type Client } from "@/server/services/_workflow";
import { prisma } from "@/server/db/client";

export type ApprovalPlan = "AUTO" | "SINGLE" | "DUAL";
export type ProcurementRules = { autoApproveBelow: number | null; dualApprovalAtOrAbove: number | null };
type Limits = { autoApproveBelow: Decimalish | null; dualApprovalAtOrAbove: Decimalish | null };

/** What an order of this total needs. The dual-approval limit wins if the two ever overlap (they cannot be saved overlapping). */
export function approvalPlan(total: Decimalish, limits: Limits): ApprovalPlan {
  const t = D(total);
  if (limits.dualApprovalAtOrAbove != null && t.gte(D(limits.dualApprovalAtOrAbove))) return "DUAL";
  if (limits.autoApproveBelow != null && t.lte(D(limits.autoApproveBelow))) return "AUTO";
  return "SINGLE";
}

const amount = z.number().min(0).max(1_000_000_000).multipleOf(0.01);
const settingsSchema = z.object({ autoApproveBelow: amount.nullable().optional(), dualApprovalAtOrAbove: amount.nullable().optional() }).strict();

const view = (r: { autoApproveBelow: unknown; dualApprovalAtOrAbove: unknown } | null): ProcurementRules => ({
  autoApproveBelow: r?.autoApproveBelow == null ? null : num(money(r.autoApproveBelow as never)),
  dualApprovalAtOrAbove: r?.dualApprovalAtOrAbove == null ? null : num(money(r.dualApprovalAtOrAbove as never)),
});

export async function getProcurementRules(db: PrismaClient | Client, organizationId: string): Promise<ProcurementRules> {
  return view(await (db as PrismaClient).procurementSettings.findUnique({ where: { organizationId } }));
}

/** Anyone who buys or approves may read the rules (the screens explain what will happen); only org.manage (the owner) may change them. */
export async function saveProcurementRules(ctx: AccessContext, input: z.input<typeof settingsSchema>, db: Client = prisma): Promise<ProcurementRules> {
  assertCan(ctx, "org.manage");
  const patch = settingsSchema.parse(input);
  return runInTx(db, async (tx) => {
    const before = await tx.procurementSettings.findUnique({ where: { organizationId: ctx.organizationId } });
    const next = {
      autoApproveBelow: patch.autoApproveBelow !== undefined ? patch.autoApproveBelow : before?.autoApproveBelow == null ? null : num(money(before.autoApproveBelow)),
      dualApprovalAtOrAbove: patch.dualApprovalAtOrAbove !== undefined ? patch.dualApprovalAtOrAbove : before?.dualApprovalAtOrAbove == null ? null : num(money(before.dualApprovalAtOrAbove)),
    };
    if (next.autoApproveBelow != null && next.dualApprovalAtOrAbove != null && next.autoApproveBelow >= next.dualApprovalAtOrAbove) {
      throw new ValidationError("Orders approved automatically must be smaller than the orders that need two approvers", { fieldErrors: { autoApproveBelow: ["Must be below the two-approver limit"] } });
    }
    const data = { autoApproveBelow: next.autoApproveBelow, dualApprovalAtOrAbove: next.dualApprovalAtOrAbove, updatedById: ctx.userId === "system" ? null : ctx.userId };
    await tx.procurementSettings.upsert({ where: { organizationId: ctx.organizationId }, create: { organizationId: ctx.organizationId, ...data }, update: data });
    await writeAudit(tx, ctx, { action: "UPDATE", entityType: "ProcurementSettings", entityId: ctx.organizationId, before: view(before), after: next });
    return next;
  });
}

export type ApprovalState = {
  plan: ApprovalPlan;
  /** Approvers the order needs (0 for an order approved by the small-order rule). */
  needed: 0 | 1 | 2;
  /** Approvals it has so far. */
  done: 0 | 1 | 2;
  firstApprovedBy: string | null;
  autoApproved: boolean;
};

type ApprovalRow = { status: string; total: unknown; firstApprovedById: string | null; autoApproved: boolean };

/** Where an order stands under the rules, for the screens (the server decides again when someone approves). */
export function approvalStateOf(po: ApprovalRow, rules: ProcurementRules, nameOf: (userId: string) => string | null = () => null): ApprovalState {
  const plan = approvalPlan(po.total as never, rules);
  if (po.autoApproved) return { plan: "AUTO", needed: 0, done: 0, firstApprovedBy: null, autoApproved: true };
  const needed = plan === "DUAL" ? 2 : 1;
  const approved = !["DRAFT", "SUBMITTED", "CANCELLED"].includes(po.status);
  const done = approved ? needed : po.firstApprovedById ? 1 : 0;
  return { plan, needed, done: done as 0 | 1 | 2, firstApprovedBy: po.firstApprovedById ? nameOf(po.firstApprovedById) : null, autoApproved: false };
}

/** Names for a set of user ids (approvers), scoped to the organization. */
export async function userNames(db: PrismaClient | Client, organizationId: string, ids: Array<string | null | undefined>): Promise<Map<string, string>> {
  const want = [...new Set(ids.filter((x): x is string => Boolean(x)))];
  if (!want.length) return new Map();
  const users = await (db as PrismaClient).user.findMany({ where: { organizationId, id: { in: want } }, select: { id: true, name: true } });
  return new Map(users.map((u) => [u.id, u.name]));
}
