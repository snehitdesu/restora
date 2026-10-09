"use client";

/**
 * Procurement screens: indents, purchase orders, goods receipts (GRN), purchase
 * bills, vendor payments + dues. Every mutation is a call to the existing
 * workflow endpoints; statuses, totals, receipt quantities and ledger posting
 * are decided by the server. The selected outlet is sent as the document's
 * outlet and re-authorized server-side.
 */
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { api } from "@/lib/api/client";
import { useQuery, usePaged } from "@/lib/hooks/useApi";
import { useShell, useOutletId } from "@/lib/shellContext";
import { createKeyedSubmitter, newIdempotencyKey } from "@/lib/idempotency";
import { formatDate, formatDateTime, formatMoney, formatQty, shortRef } from "@/lib/format";
import { IndentStatus, PurchaseOrderStatus, GRNStatus, PurchaseBillStatus, VendorPaymentMethod, INDENT_TRANSITIONS, PURCHASE_ORDER_TRANSITIONS, GRN_TRANSITIONS, PURCHASE_BILL_TRANSITIONS } from "@/constants/enums";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { Field, FormDialog, Input, Select, Textarea, opt } from "@/components/ui/Form";
import { DataTable, Pager, type Column } from "@/components/ui/Table";
import { Card, Details, PageHeader, StatusBadge, Stat, SubNav } from "@/components/ui/Page";
import { LoadingState, ErrorState } from "@/components/ui/States";
import { FilterBar, SelectFilter } from "@/components/ui/Filters";
import { DocumentList, TransitionBar, cancelConfirm, type Doc } from "@/features/backoffice/documents";
import type { Fulfilment } from "@/server/services/indentFulfilment";
import { CreateIssueDialog } from "@/features/backoffice/inventory";
import { LineEditor, emptyLine, toApiLines, type LineDraft, type LineField } from "@/features/backoffice/LineEditor";
import { type MaterialRow, VendorSelect, materialLabel, unitOf, useDepartments, useMaterials, useVendors, vendorLabel } from "@/features/backoffice/lookups";

export function ProcureNav() {
  const { can } = useShell();
  return (
    <SubNav
      label="Procurement"
      items={[
        { href: "/procurement/queue", label: "Queue", hidden: !can("purchase.view") && !can("indent.create") },
        { href: "/procurement/reorder", label: "Reorder", hidden: !can("purchase.view") },
        { href: "/procurement/indents", label: "Indents", hidden: !can("purchase.view") && !can("indent.create") },
        { href: "/procurement/purchase-orders", label: "Purchase orders", hidden: !can("purchase.view") },
        { href: "/procurement/grns", label: "Goods receipts", hidden: !can("purchase.view") },
        { href: "/procurement/bills", label: "Bills", hidden: !can("purchase.view") },
        { href: "/procurement/payments", label: "Payments", hidden: !can("finance.view") },
      ]}
    />
  );
}

type IndentLine = { id: string; materialId: string; qty: string; unitId: string | null };
type Indent = Doc & { departmentId: string | null; notes: string | null; outletId: string; source?: string | null; lines?: IndentLine[]; fulfilment?: Fulfilment; _count?: { lines: number } };
type POLine = { id: string; materialId: string; qty: string; rate: string; taxPct: string; receivedQty: string; lineStatus?: string; requestedQty?: string | null };
type POApproval = { plan: "AUTO" | "SINGLE" | "DUAL"; needed: 0 | 1 | 2; done: 0 | 1 | 2; firstApprovedBy: string | null; approvedBy: string | null; autoApproved: boolean; youApprovedFirst: boolean };
type PO = Doc & { vendorId: string; outletId: string; source?: string | null; expectedDate: string | null; subtotal: string; tax: string; total: string; notes: string | null; approvedAt: string | null; approval?: POApproval; lines?: POLine[]; receipts?: Array<{ id: string; number: string; status: string; receivedAt: string }>; _count?: { lines: number; receipts: number } };
type GRNLine = { id: string; materialId: string; qty: string; rate: string; damagedQty: string; batchNo: string | null; expiryDate: string | null; fssaiLot?: string | null };
type GRN = Doc & { vendorId: string; poId: string | null; outletId: string; receivedAt: string; postedAt: string | null; notes: string | null; lines?: GRNLine[]; bills?: Array<{ id: string; number: string; status: string }>; _count?: { lines: number } };
type BillLine = { id: string; materialId: string; qty: string; rate: string; taxPct: string };
type VendorPayment = { id: string; vendorId: string; billId: string | null; amount: string; method: string; reference: string | null; paidAt: string; createdAt: string };
type Bill = Doc & { vendorId: string; grnId: string | null; outletId: string; billDate: string; dueDate: string | null; subtotal: string; tax: string; total: string; paidAmount: string; lines?: BillLine[]; payments?: VendorPayment[] };
type DueRow = { vendorId: string; vendorName: string; openBills: number; billed: number; paid: number; due: number; overdue: number };

const numberCol = <T extends Doc>(): Column<T> => ({ key: "number", header: "Number", cell: (r) => <span className="font-medium text-ink-900">{r.number}</span> });
/** Documents raised from the reorder screen carry source "REORDER". */
const sourceBadge = (source?: string | null) => (source === "REORDER" ? <Badge tone="info" className="ml-2">From reorder</Badge> : null);
const numberWithSourceCol = <T extends Doc & { source?: string | null }>(): Column<T> => ({ key: "number", header: "Number", cell: (r) => <span className="font-medium text-ink-900">{r.number}{sourceBadge(r.source)}</span> });
const statusCol = <T extends Doc>(): Column<T> => ({ key: "status", header: "Status", cell: (r) => <StatusBadge status={r.status} /> });
const createdCol = <T extends Doc>(tz?: string): Column<T> => ({ key: "createdAt", header: "Created", cell: (r) => formatDateTime(r.createdAt, tz) });

function useDoc<T>(path: string) {
  return useQuery<T>(path);
}

function DocShell<T extends Doc>({ q, children }: { q: ReturnType<typeof useDoc<T>>; children: (d: T) => React.ReactNode }) {
  if (q.loading && !q.data) return <LoadingState />;
  if (q.error) return <ErrorState error={q.error} onRetry={q.reload} />;
  if (!q.data) return null;
  return <>{children(q.data)}</>;
}

// ============================================================
// Indents
// ============================================================

const indentFields: LineField[] = [{ key: "qty", label: "Qty", required: true, min: 0 }];

function CreateIndentDialog({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: (id: string) => void }) {
  const outletId = useOutletId();
  const materials = useMaterials(open);
  const depts = useDepartments(open ? outletId : null);
  const [departmentId, setDepartmentId] = useState("");
  const [lines, setLines] = useState<LineDraft[]>([emptyLine(indentFields)]);
  return (
    <FormDialog open={open} onClose={onClose} title="New indent" size="lg" submitLabel="Create indent"
      onSubmit={() => api<Indent>("/api/procurement/indents", { method: "POST", body: { outletId, departmentId: opt(departmentId), lines: toApiLines(lines, indentFields) } })}
      onDone={(r) => { setLines([emptyLine(indentFields)]); onDone(r.id); }}>
      <Field label="Department" name="departmentId">
        <Select value={departmentId} onChange={(e) => setDepartmentId(e.target.value)}>
          <option value="">—</option>
          {(depts.data ?? []).filter((d) => d.active).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
        </Select>
      </Field>
      <LineEditor fields={indentFields} lines={lines} onChange={setLines} materials={materials.items} />
    </FormDialog>
  );
}

export function IndentsScreen() {
  const { can, outlet } = useShell();
  const [open, setOpen] = useState(false);
  const [rk, setRk] = useState(0);
  return (
    <>
      <PageHeader title="Indents" subtitle="Requests to the store or for purchase: the kitchen raises them, the store fulfils them" actions={can("indent.create") && <Button variant="primary" onClick={() => setOpen(true)}><Icon name="plus" /> New indent</Button>} />
      <ProcureNav />
      <DocumentList<Indent> label="Indents" endpoint="/api/procurement/indents" statuses={IndentStatus.values} reloadKey={rk} detailHref={(r) => `/procurement/indents/${r.id}`}
        columns={[numberWithSourceCol(), statusCol(), { key: "lines", header: "Lines", numeric: true, cell: (r) => r._count?.lines ?? "—" }, createdCol(outlet?.timezone)]} />
      <CreateIndentDialog open={open} onClose={() => setOpen(false)} onDone={() => setRk((k) => k + 1)} />
    </>
  );
}

export function IndentDetail({ id }: { id: string }) {
  const { can, outlet } = useShell();
  const q = useDoc<Indent>(`/api/procurement/indents/${id}`);
  const materials = useMaterials();
  const [poOpen, setPoOpen] = useState(false);
  const [issueOpen, setIssueOpen] = useState(false);
  const router = useRouter();
  const t = (to: string) => () => api(`/api/procurement/indents/${id}/transition`, { method: "POST", body: { to } });
  return (
    <DocShell q={q}>
      {(d) => (
        <>
          <PageHeader title={`Indent ${d.number}`} badge={<StatusBadge status={d.status} />} back={{ href: "/procurement/indents", label: "Indents" }}
            actions={
              <TransitionBar status={d.status as IndentStatus} table={INDENT_TRANSITIONS} onDone={q.reload}
                specs={{
                  SUBMITTED: { label: "Submit", permission: "indent.create", action: t("SUBMITTED") },
                  APPROVED: { label: "Approve", permission: "purchase.approve", action: t("APPROVED"), variant: "success" },
                  CLOSED: { label: "Close", permission: "purchase.create", action: t("CLOSED"), variant: "secondary", confirm: { title: "Close indent?", message: "Closing marks the indent fulfilled." } },
                  CANCELLED: { label: "Cancel", permission: d.status === "APPROVED" ? "purchase.create" : "indent.create", action: t("CANCELLED"), confirm: cancelConfirm("indent") },
                }}
                extra={<>
                  {d.status === "APPROVED" && can("inventory.issue") && d.fulfilment?.lines.some((l) => l.outstanding > 0) && <Button onClick={() => setIssueOpen(true)}><Icon name="box" /> Issue stock</Button>}
                  {d.status === "APPROVED" && can("purchase.create") && <Button onClick={() => setPoOpen(true)}><Icon name="cart" /> Create PO</Button>}
                </>}
              />
            } />
          <Card className="mb-4"><Details items={[["Created", formatDateTime(d.createdAt, outlet?.timezone)], ["Lines", d.lines?.length ?? 0], ["Notes", d.notes]]} /></Card>
          <DataTable label="Indent lines" rows={d.lines ?? []} rowKey={(l) => l.id}
            columns={[{ key: "m", header: "Material", cell: (l) => materialLabel(materials.byId, l.materialId) }, { key: "q", header: "Qty", numeric: true, cell: (l) => `${formatQty(l.qty)} ${unitOf(materials.byId, l.materialId)}` }]} />
          {d.fulfilment && ["APPROVED", "CLOSED"].includes(d.status) && (d.fulfilment.issues.length > 0 || d.status === "APPROVED") && (
            <Card title="Issued from stock" className="mt-4">
              <DataTable label="Indent fulfilment" rows={d.fulfilment.lines} rowKey={(l) => l.materialId}
                columns={[
                  { key: "m", header: "Material", cell: (l) => materialLabel(materials.byId, l.materialId) },
                  { key: "r", header: "Asked", numeric: true, cell: (l) => `${formatQty(l.requested)} ${unitOf(materials.byId, l.materialId)}` },
                  { key: "i", header: "Issued", numeric: true, cell: (l) => formatQty(l.issued) },
                  { key: "o", header: "Still needed", numeric: true, cell: (l) => (l.outstanding > 0 ? <span className="text-warn-600">{formatQty(l.outstanding)}</span> : <Badge tone="ok">Done</Badge>) },
                ]} />
              {d.fulfilment.issues.length > 0 && (
                <ul className="mt-3 divide-y divide-ink-100 text-sm" aria-label="Issues against this indent">
                  {d.fulfilment.issues.map((i) => (
                    <li key={i.id} className="flex items-center justify-between py-1.5">
                      <Link href={`/inventory/issues/${i.id}`} className="font-medium text-brand-600 hover:underline">{i.number}</Link>
                      <span className="flex items-center gap-2"><StatusBadge status={i.status} />{i.issuedAt ? formatDateTime(i.issuedAt, outlet?.timezone) : "not posted yet"}</span>
                    </li>
                  ))}
                </ul>
              )}
              <p className="mt-2 text-xs text-ink-500">Quantities are in each material&apos;s base unit. The indent closes by itself when everything has been issued.</p>
            </Card>
          )}
          {issueOpen && d.fulfilment && <CreateIssueDialog open onClose={() => setIssueOpen(false)} onDone={(issueId) => router.push(`/inventory/issues/${issueId}`)} indent={{ id: d.id, number: d.number, outstanding: d.fulfilment.lines.filter((l) => l.outstanding > 0).map((l) => ({ materialId: l.materialId, qty: l.outstanding })) }} />}
          <CreatePODialog open={poOpen} onClose={() => setPoOpen(false)} onDone={() => q.reload()} indentId={d.id} initialLines={(d.lines ?? []).map((l) => ({ materialId: l.materialId, qty: String(Number(l.qty)), rate: "", taxPct: "" }))} />
        </>
      )}
    </DocShell>
  );
}

// ============================================================
// Purchase orders
// ============================================================

const poFields: LineField[] = [
  { key: "qty", label: "Qty", required: true, min: 0 },
  { key: "rate", label: "Rate", required: true, min: 0 },
  { key: "taxPct", label: "Tax %", min: 0 },
];

function CreatePODialog({ open, onClose, onDone, initialLines, indentId }: { open: boolean; onClose: () => void; onDone?: (id: string) => void; initialLines?: LineDraft[]; indentId?: string }) {
  const [submitKeyed] = useState(() => createKeyedSubmitter("po"));
  const router = useRouter();
  const outletId = useOutletId();
  const materials = useMaterials(open);
  const vendors = useVendors(open);
  const [vendorId, setVendorId] = useState("");
  const [expectedDate, setExpectedDate] = useState("");
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<LineDraft[]>(initialLines?.length ? initialLines : [emptyLine(poFields)]);
  const [seeded, setSeeded] = useState(initialLines);
  if (initialLines !== seeded) {
    setSeeded(initialLines);
    if (initialLines?.length) setLines(initialLines);
  }
  return (
    <FormDialog open={open} onClose={onClose} title="New purchase order" size="lg" submitLabel="Create PO"
      onSubmit={() => {
        // Raising a PO from an approved indent closes the indent (server-side).
        const body = { outletId, vendorId, indentId, expectedDate: opt(expectedDate), notes: opt(notes), lines: toApiLines(lines, poFields) };
        return submitKeyed(body, (idempotencyKey) => api<PO>("/api/procurement/purchase-orders", { method: "POST", body, idempotencyKey }));
      }}
      onDone={(r) => { setLines([emptyLine(poFields)]); onDone ? onDone(r.id) : router.push(`/procurement/purchase-orders/${r.id}`); }}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Vendor" name="vendorId" required><VendorSelect vendors={vendors.items} value={vendorId} onChange={setVendorId} required /></Field>
        <Field label="Expected date" name="expectedDate"><Input type="date" value={expectedDate} onChange={(e) => setExpectedDate(e.target.value)} /></Field>
      </div>
      <Field label="Notes" name="notes"><Textarea value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
      <LineEditor fields={poFields} lines={lines} onChange={setLines} materials={materials.items} />
      <p className="text-xs text-ink-500">Subtotal, tax and total are calculated by the server when the PO is saved.</p>
    </FormDialog>
  );
}

export function PurchaseOrdersScreen() {
  const { can, outlet } = useShell();
  const vendors = useVendors();
  const [open, setOpen] = useState(false);
  const [rk, setRk] = useState(0);
  return (
    <>
      <PageHeader title="Purchase orders" subtitle="Orders placed with vendors" actions={can("purchase.create") && <Button variant="primary" onClick={() => setOpen(true)}><Icon name="plus" /> New PO</Button>} />
      <ProcureNav />
      <DocumentList<PO> label="Purchase orders" endpoint="/api/procurement/purchase-orders" statuses={PurchaseOrderStatus.values} vendorFilter reloadKey={rk} detailHref={(r) => `/procurement/purchase-orders/${r.id}`}
        columns={[
          numberWithSourceCol(), statusCol(),
          { key: "vendor", header: "Vendor", cell: (r) => vendorLabel(vendors.byId, r.vendorId) },
          { key: "expected", header: "Expected", cell: (r) => formatDate(r.expectedDate, outlet?.timezone) },
          { key: "receipts", header: "GRNs", numeric: true, cell: (r) => r._count?.receipts ?? 0 },
          { key: "total", header: "Total", numeric: true, cell: (r) => formatMoney(r.total) },
          createdCol(outlet?.timezone),
        ]} />
      <CreatePODialog open={open} onClose={() => setOpen(false)} onDone={() => setRk((k) => k + 1)} />
    </>
  );
}

export function PurchaseOrderDetail({ id }: { id: string }) {
  const router = useRouter();
  const { can, outlet } = useShell();
  const q = useDoc<PO>(`/api/procurement/purchase-orders/${id}`);
  const materials = useMaterials();
  const vendors = useVendors();
  const [grnOpen, setGrnOpen] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const t = (to: string) => () => api(`/api/procurement/purchase-orders/${id}/transition`, { method: "POST", body: { to } });
  return (
    <DocShell q={q}>
      {(d) => (
        <>
          <PageHeader title={`PO ${d.number}`} badge={<StatusBadge status={d.status} />} back={{ href: "/procurement/purchase-orders", label: "Purchase orders" }}
            actions={
              <TransitionBar status={d.status as PurchaseOrderStatus} table={PURCHASE_ORDER_TRANSITIONS} onDone={q.reload}
                // PARTIAL / RECEIVED / BILLED are set by posting GRNs and bills, never by hand.
                specs={{
                  SUBMITTED: { label: "Submit", permission: "purchase.create", action: t("SUBMITTED") },
                  APPROVED: {
                    label: d.approval?.needed === 2 ? `Approve (${d.approval.done + 1} of 2)` : "Approve", permission: "purchase.approve", action: t("APPROVED"), variant: "success",
                    // The second of two approvers must be somebody else.
                    hidden: Boolean(d.approval?.youApprovedFirst),
                    success: d.approval?.needed === 2 && d.approval.done === 0 ? "First approval recorded — a second approver is needed" : "Approved",
                  },
                  ORDERED: { label: "Mark ordered", permission: "purchase.create", action: t("ORDERED") },
                  CLOSED: { label: "Close", permission: "purchase.create", action: t("CLOSED"), variant: "secondary", confirm: { title: "Close purchase order?", message: "No further receipts will be expected against this PO." } },
                  CANCELLED: { label: "Cancel", permission: "purchase.create", action: t("CANCELLED"), confirm: cancelConfirm("purchase order") },
                }}
                extra={<>
                  {d.status === "SUBMITTED" && can("purchase.approve") && <Button onClick={() => setReviewing(true)}>Review lines</Button>}
                  {["APPROVED", "ORDERED", "PARTIAL"].includes(d.status) && can("grn.create") && <Button onClick={() => setGrnOpen(true)}><Icon name="inbox" /> Receive (GRN)</Button>}
                </>}
              />
            } />
          {d.approval && <ApprovalNote status={d.status} a={d.approval} />}
          <Card className="mb-4">
            <Details cols={4} items={[
              ["Vendor", vendorLabel(vendors.byId, d.vendorId)], ["Expected", formatDate(d.expectedDate, outlet?.timezone)], ["Created", formatDateTime(d.createdAt, outlet?.timezone)], ["Approved", formatDateTime(d.approvedAt, outlet?.timezone)],
              ["Subtotal", formatMoney(d.subtotal)], ["Tax", formatMoney(d.tax)], ["Total", <strong key="t">{formatMoney(d.total)}</strong>], ["Notes", d.notes],
            ]} />
          </Card>
          <DataTable label="PO lines" rows={d.lines ?? []} rowKey={(l) => l.id}
            columns={[
              { key: "m", header: "Material", cell: (l) => <span className={l.lineStatus === "REJECTED" ? "text-ink-400 line-through" : ""}>{materialLabel(materials.byId, l.materialId)}{l.lineStatus === "REJECTED" && <Badge tone="bad" className="ml-2 no-underline">Rejected</Badge>}</span> },
              { key: "q", header: "Ordered", numeric: true, cell: (l) => <span className={l.lineStatus === "REJECTED" ? "text-ink-400 line-through" : ""}>{formatQty(l.qty)} {unitOf(materials.byId, l.materialId)}{l.requestedQty && Number(l.requestedQty) !== Number(l.qty) ? <span className="block text-xs text-ink-500 no-underline">was {formatQty(l.requestedQty)}</span> : null}</span> },
              { key: "r", header: "Received", numeric: true, cell: (l) => <span className={Number(l.receivedQty) >= Number(l.qty) ? "text-ok-500" : Number(l.receivedQty) > 0 ? "text-warn-500" : ""}>{formatQty(l.receivedQty)}</span> },
              { key: "rate", header: "Rate", numeric: true, cell: (l) => formatMoney(l.rate) },
              { key: "tax", header: "Tax %", numeric: true, cell: (l) => formatQty(l.taxPct) },
            ]} />
          {!!d.receipts?.length && (
            <Card title="Goods receipts" className="mt-4">
              <ul className="divide-y divide-ink-100 text-sm">
                {d.receipts.map((g) => (
                  <li key={g.id} className="flex items-center justify-between py-1.5">
                    <Link href={`/procurement/grns/${g.id}`} className="font-medium text-brand-600 hover:underline">{g.number}</Link>
                    <span className="flex items-center gap-2"><StatusBadge status={g.status} /> {formatDateTime(g.receivedAt, outlet?.timezone)}</span>
                  </li>
                ))}
              </ul>
            </Card>
          )}
          <CreateGRNDialog open={grnOpen} onClose={() => setGrnOpen(false)} fromPo={d} onDone={(gid) => router.push(`/procurement/grns/${gid}`)} />
          {reviewing && <ReviewLinesDialog po={d} materials={materials.byId} onClose={() => setReviewing(false)} onDone={() => { setReviewing(false); q.reload(); }} />}
        </>
      )}
    </DocShell>
  );
}

/** Where the order stands under the organization's approval rules. */
function ApprovalNote({ status, a }: { status: string; a: POApproval }) {
  if (a.autoApproved) return <p className="mb-3 rounded-md border border-ok-200 bg-ok-50 px-3 py-2 text-sm text-ok-700" data-testid="approval-note">Approved automatically: a small order needs no approver.</p>;
  if (status === "SUBMITTED") {
    if (a.needed === 2) {
      return <p className="mb-3 rounded-md border border-warn-200 bg-warn-50 px-3 py-2 text-sm text-warn-700" data-testid="approval-note">
        A large order: it needs two different approvers. {a.done === 0 ? "No one has approved it yet." : `${a.firstApprovedBy ?? "Someone"} gave the first approval${a.youApprovedFirst ? " (you); a second approver has to give the other" : "; one more is needed"}.`}
      </p>;
    }
    return null;
  }
  if (a.needed === 2 && a.approvedBy && ["APPROVED", "ORDERED", "PARTIAL", "RECEIVED", "BILLED", "CLOSED"].includes(status)) {
    return <p className="mb-3 text-sm text-ink-600" data-testid="approval-note">Approved by {a.firstApprovedBy ?? "the first approver"} and {a.approvedBy}.</p>;
  }
  return null;
}

/**
 * The approver goes through a submitted order line by line (audit PP-06): change a quantity, take a line off the order,
 * put one back. Only what changed is sent; the server recomputes the totals and keeps the quantity as raised.
 */
export function ReviewLinesDialog({ po, materials, onClose, onDone }: { po: PO; materials: Map<string, MaterialRow>; onClose: () => void; onDone: () => void }) {
  const lines = po.lines ?? [];
  const [qty, setQty] = useState<Record<string, string>>(() => Object.fromEntries(lines.map((l) => [l.id, String(Number(l.qty))])));
  const [rejected, setRejected] = useState<Record<string, boolean>>(() => Object.fromEntries(lines.map((l) => [l.id, l.lineStatus === "REJECTED"])));
  const [note, setNote] = useState("");
  const changes = lines.flatMap((l): Array<{ lineId: string; action: "REJECT" | "KEEP"; qty?: number }> => {
    const wasRejected = l.lineStatus === "REJECTED";
    const nowRejected = rejected[l.id];
    const q = Number(qty[l.id]);
    if (nowRejected && !wasRejected) return [{ lineId: l.id, action: "REJECT" as const }];
    if (!nowRejected && (wasRejected || (Number.isFinite(q) && q > 0 && q !== Number(l.qty)))) return [{ lineId: l.id, action: "KEEP" as const, ...(q !== Number(l.qty) ? { qty: q } : {}) }];
    return [];
  });
  const staying = lines.filter((l) => !rejected[l.id]).length;
  const invalid = lines.some((l) => !rejected[l.id] && !(Number(qty[l.id]) > 0));
  const money = (l: POLine) => (rejected[l.id] ? 0 : (Number(qty[l.id]) || 0) * Number(l.rate) * (1 + Number(l.taxPct) / 100));
  return (
    <FormDialog open onClose={onClose} title={`Review PO ${po.number}`} description="Change a quantity, take a line off, or put one back. This does not approve the order." submitLabel="Save review" size="lg"
      onSubmit={async () => {
        if (!changes.length) throw new Error("Nothing was changed");
        if (staying === 0) throw new Error("At least one line has to stay on the order. To turn it down altogether, cancel it.");
        if (invalid) throw new Error("Every line that stays needs a quantity above zero");
        return api(`/api/procurement/purchase-orders/${po.id}/review`, { method: "POST", body: { lines: changes, note: note.trim() || undefined } });
      }}
      onDone={onDone}>
      <ul className="divide-y divide-ink-100" aria-label="Lines to review">
        {lines.map((l) => {
          const m = materials.get(l.materialId);
          const name = m?.name ?? "Material";
          return (
            <li key={l.id} className="flex flex-wrap items-center gap-2 py-2">
              <span className={`min-w-0 flex-1 text-sm ${rejected[l.id] ? "text-ink-400 line-through" : ""}`}>{name}<span className="block text-xs text-ink-500">{formatMoney(l.rate)} each{Number(l.taxPct) ? ` + ${formatQty(l.taxPct)}% tax` : ""}</span></span>
              <Input type="number" inputMode="decimal" min={0} step="any" aria-label={`Quantity of ${name}`} className="w-24" disabled={rejected[l.id]} value={qty[l.id]} onChange={(e) => setQty((x) => ({ ...x, [l.id]: e.target.value }))} />
              <span className="w-24 text-right text-sm tabular-nums">{formatMoney(money(l))}</span>
              <Button type="button" size="sm" variant={rejected[l.id] ? "secondary" : "danger"} aria-label={rejected[l.id] ? `Put ${name} back` : `Take ${name} off`} onClick={() => setRejected((x) => ({ ...x, [l.id]: !x[l.id] }))}>{rejected[l.id] ? "Put back" : "Take off"}</Button>
            </li>
          );
        })}
      </ul>
      <p className="mt-2 text-xs text-ink-500">{changes.length ? `${changes.length} change${changes.length === 1 ? "" : "s"}; ${staying} line${staying === 1 ? "" : "s"} stay${staying === 1 ? "s" : ""} on the order.` : "No changes yet."}</p>
      <div className="mt-3"><Field label="Note (optional)" name="note"><Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} /></Field></div>
    </FormDialog>
  );
}

// ============================================================
// GRNs
// ============================================================

const grnFields: LineField[] = [
  { key: "qty", label: "Qty received", required: true, min: 0 },
  { key: "rate", label: "Rate", required: true, min: 0 },
  { key: "damagedQty", label: "Damaged", min: 0 },
  { key: "batchNo", label: "Batch", type: "text" },
  { key: "expiryDate", label: "Expiry", type: "date" },
  { key: "fssaiLot", label: "FSSAI lot", type: "text" },
];

function CreateGRNDialog({ open, onClose, onDone, fromPo }: { open: boolean; onClose: () => void; onDone: (id: string) => void; fromPo?: PO }) {
  const [submitKeyed] = useState(() => createKeyedSubmitter("grn"));
  const outletId = useOutletId();
  const materials = useMaterials(open);
  const vendors = useVendors(open);
  const [vendorId, setVendorId] = useState(fromPo?.vendorId ?? "");
  const [notes, setNotes] = useState("");
  // Prefill with what is still outstanding on the PO (display convenience; the server validates).
  const initial = useMemo<LineDraft[]>(
    () => (fromPo?.lines ?? []).filter((l) => l.lineStatus !== "REJECTED").map((l) => ({ ...emptyLine(grnFields), materialId: l.materialId, qty: String(Math.max(0, Number(l.qty) - Number(l.receivedQty))), rate: String(Number(l.rate)) })).filter((l) => Number(l.qty) > 0),
    [fromPo]
  );
  const [lines, setLines] = useState<LineDraft[]>(initial.length ? initial : [emptyLine(grnFields)]);
  return (
    <FormDialog open={open} onClose={onClose} title={fromPo ? `Receive against PO ${fromPo.number}` : "New goods receipt"} size="lg" submitLabel="Create GRN (draft)"
      description="The GRN is saved as a draft; stock enters the ledger only when it is posted."
      onSubmit={() => {
        const body = { outletId, vendorId, poId: fromPo?.id, notes: opt(notes), lines: toApiLines(lines, grnFields) };
        return submitKeyed(body, (idempotencyKey) => api<GRN>("/api/procurement/grns", { method: "POST", body, idempotencyKey }));
      }}
      onDone={(r) => onDone(r.id)}>
      <Field label="Vendor" name="vendorId" required>{fromPo ? <Input value={vendorLabel(vendors.byId, vendorId)} disabled /> : <VendorSelect vendors={vendors.items} value={vendorId} onChange={setVendorId} required />}</Field>
      <Field label="Notes" name="notes"><Textarea value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
      <LineEditor fields={grnFields} lines={lines} onChange={setLines} materials={materials.items} />
    </FormDialog>
  );
}

export function GRNsScreen() {
  const router = useRouter();
  const { can, outlet } = useShell();
  const vendors = useVendors();
  const [open, setOpen] = useState(false);
  return (
    <>
      <PageHeader title="Goods receipts" subtitle="Posting a GRN writes PURCHASE_RECEIPT rows to the inventory ledger" actions={can("grn.create") && <Button variant="primary" onClick={() => setOpen(true)}><Icon name="plus" /> New GRN</Button>} />
      <ProcureNav />
      <DocumentList<GRN> label="Goods receipts" endpoint="/api/procurement/grns" statuses={GRNStatus.values} vendorFilter detailHref={(r) => `/procurement/grns/${r.id}`}
        columns={[numberCol(), statusCol(), { key: "vendor", header: "Vendor", cell: (r) => vendorLabel(vendors.byId, r.vendorId) }, { key: "po", header: "PO", cell: (r) => (r.poId ? `#${shortRef(r.poId)}` : "—") }, { key: "lines", header: "Lines", numeric: true, cell: (r) => r._count?.lines ?? "—" }, createdCol(outlet?.timezone)]} />
      <CreateGRNDialog open={open} onClose={() => setOpen(false)} onDone={(id) => router.push(`/procurement/grns/${id}`)} />
    </>
  );
}

export function GRNDetail({ id }: { id: string }) {
  const router = useRouter();
  const { can, outlet } = useShell();
  const q = useDoc<GRN>(`/api/procurement/grns/${id}`);
  const materials = useMaterials();
  const vendors = useVendors();
  const [billOpen, setBillOpen] = useState(false);
  return (
    <DocShell q={q}>
      {(d) => (
        <>
          <PageHeader title={`GRN ${d.number}`} badge={<StatusBadge status={d.status} />} back={{ href: "/procurement/grns", label: "Goods receipts" }}
            actions={
              <TransitionBar status={d.status as GRNStatus} table={GRN_TRANSITIONS} onDone={q.reload}
                specs={{ POSTED: { label: "Post to inventory", permission: "grn.create", variant: "success", action: () => api(`/api/procurement/grns/${id}/post`, { method: "POST" }), confirm: { title: "Post this GRN?", message: "Good quantities (received − damaged) are added to stock through the inventory ledger. Posted GRNs cannot be edited." }, success: "GRN posted to the ledger" } }}
                extra={d.status === "POSTED" && !d.bills?.length && can("bill.manage") && <Button onClick={() => setBillOpen(true)}><Icon name="receipt" /> Create bill</Button>}
              />
            } />
          <Card className="mb-4">
            <Details cols={4} items={[
              ["Vendor", vendorLabel(vendors.byId, d.vendorId)], ["Purchase order", d.poId ? <Link key="po" className="text-brand-600 hover:underline" href={`/procurement/purchase-orders/${d.poId}`}>View PO</Link> : "—"],
              ["Received", formatDateTime(d.receivedAt, outlet?.timezone)], ["Posted", formatDateTime(d.postedAt, outlet?.timezone)],
              ["Bills", d.bills?.length ? d.bills.map((b) => <Link key={b.id} className="mr-2 text-brand-600 hover:underline" href={`/procurement/bills/${b.id}`}>{b.number}</Link>) : "—"], ["Notes", d.notes],
            ]} />
          </Card>
          <DataTable label="GRN lines" rows={d.lines ?? []} rowKey={(l) => l.id}
            columns={[
              { key: "m", header: "Material", cell: (l) => materialLabel(materials.byId, l.materialId) },
              { key: "q", header: "Received", numeric: true, cell: (l) => `${formatQty(l.qty)} ${unitOf(materials.byId, l.materialId)}` },
              { key: "d", header: "Damaged", numeric: true, cell: (l) => formatQty(l.damagedQty) },
              { key: "rate", header: "Rate", numeric: true, cell: (l) => formatMoney(l.rate) },
              { key: "b", header: "Batch", cell: (l) => l.batchNo ?? "—" },
              { key: "lot", header: "FSSAI lot", cell: (l) => l.fssaiLot ?? "—" },
              { key: "e", header: "Expiry", cell: (l) => formatDate(l.expiryDate, outlet?.timezone) },
            ]} />
          <CreateBillDialog open={billOpen} onClose={() => setBillOpen(false)} fromGrn={d} onDone={(bid) => router.push(`/procurement/bills/${bid}`)} />
        </>
      )}
    </DocShell>
  );
}

// ============================================================
// Bills
// ============================================================

const billFields: LineField[] = [
  { key: "qty", label: "Qty", required: true, min: 0 },
  { key: "rate", label: "Rate", required: true, min: 0 },
  { key: "taxPct", label: "Tax %", min: 0 },
];

function CreateBillDialog({ open, onClose, onDone, fromGrn }: { open: boolean; onClose: () => void; onDone: (id: string) => void; fromGrn?: GRN }) {
  const [submitKeyed] = useState(() => createKeyedSubmitter("bill"));
  const outletId = useOutletId();
  const materials = useMaterials(open);
  const vendors = useVendors(open);
  const [vendorId, setVendorId] = useState(fromGrn?.vendorId ?? "");
  const [number, setNumber] = useState("");
  const [dueDate, setDueDate] = useState("");
  const initial = useMemo<LineDraft[]>(() => (fromGrn?.lines ?? []).map((l) => ({ ...emptyLine(billFields), materialId: l.materialId, qty: String(Number(l.qty) - Number(l.damagedQty)), rate: String(Number(l.rate)) })).filter((l) => Number(l.qty) > 0), [fromGrn]);
  const [lines, setLines] = useState<LineDraft[]>(initial.length ? initial : [emptyLine(billFields)]);
  return (
    <FormDialog open={open} onClose={onClose} title={fromGrn ? `Bill for GRN ${fromGrn.number}` : "New purchase bill"} size="lg" submitLabel="Create bill"
      onSubmit={() => {
        // The vendor's invoice number: the server refuses a second bill for the same vendor invoice.
        const body = { outletId, vendorId, grnId: fromGrn?.id, vendorInvoiceNo: opt(number), dueDate: opt(dueDate), lines: toApiLines(lines, billFields) };
        return submitKeyed(body, (idempotencyKey) => api<Bill>("/api/procurement/bills", { method: "POST", body, idempotencyKey }));
      }}
      onDone={(r) => onDone(r.id)}>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Vendor" name="vendorId" required>{fromGrn ? <Input value={vendorLabel(vendors.byId, vendorId)} disabled /> : <VendorSelect vendors={vendors.items} value={vendorId} onChange={setVendorId} required />}</Field>
        <Field label="Vendor invoice no." name="vendorInvoiceNo" hint="Recorded once per vendor"><Input value={number} onChange={(e) => setNumber(e.target.value)} maxLength={64} /></Field>
        <Field label="Due date" name="dueDate"><Input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} /></Field>
      </div>
      <LineEditor fields={billFields} lines={lines} onChange={setLines} materials={materials.items} />
    </FormDialog>
  );
}

export function BillsScreen() {
  const router = useRouter();
  const { can, outlet } = useShell();
  const vendors = useVendors();
  const [open, setOpen] = useState(false);
  return (
    <>
      <PageHeader title="Purchase bills" subtitle="Vendor invoices; payments reduce the outstanding balance" actions={can("bill.manage") && <Button variant="primary" onClick={() => setOpen(true)}><Icon name="plus" /> New bill</Button>} />
      <ProcureNav />
      <DocumentList<Bill> label="Purchase bills" endpoint="/api/procurement/bills" statuses={PurchaseBillStatus.values} vendorFilter detailHref={(r) => `/procurement/bills/${r.id}`}
        columns={[
          numberCol(), statusCol(),
          { key: "vendor", header: "Vendor", cell: (r) => vendorLabel(vendors.byId, r.vendorId) },
          { key: "due", header: "Due", cell: (r) => formatDate(r.dueDate, outlet?.timezone) },
          { key: "total", header: "Total", numeric: true, cell: (r) => formatMoney(r.total) },
          { key: "paid", header: "Paid", numeric: true, cell: (r) => formatMoney(r.paidAmount) },
          createdCol(outlet?.timezone),
        ]} />
      <CreateBillDialog open={open} onClose={() => setOpen(false)} onDone={(id) => router.push(`/procurement/bills/${id}`)} />
    </>
  );
}

export function BillDetail({ id }: { id: string }) {
  const { can, outlet } = useShell();
  const q = useDoc<Bill>(`/api/procurement/bills/${id}`);
  const materials = useMaterials();
  const vendors = useVendors();
  const [payOpen, setPayOpen] = useState(false);
  return (
    <DocShell q={q}>
      {(d) => (
        <>
          <PageHeader title={`Bill ${d.number}`} badge={<StatusBadge status={d.status} />} back={{ href: "/procurement/bills", label: "Purchase bills" }}
            actions={
              <TransitionBar status={d.status as PurchaseBillStatus} table={PURCHASE_BILL_TRANSITIONS} onDone={q.reload}
                // PARTIAL / PAID follow from payments; only cancellation is manual (and only without payments).
                specs={d.payments?.length ? {} : { CANCELLED: { label: "Cancel bill", permission: "bill.manage", action: () => api(`/api/procurement/bills/${id}/cancel`, { method: "POST" }), confirm: cancelConfirm("bill") } }}
                extra={["OPEN", "PARTIAL"].includes(d.status) && can("vendor.pay") && <Button variant="primary" onClick={() => setPayOpen(true)}><Icon name="cash" /> Record payment</Button>}
              />
            } />
          <Card className="mb-4">
            <Details cols={4} items={[
              ["Vendor", vendorLabel(vendors.byId, d.vendorId)], ["Bill date", formatDate(d.billDate, outlet?.timezone)], ["Due", formatDate(d.dueDate, outlet?.timezone)], ["GRN", d.grnId ? <Link key="g" className="text-brand-600 hover:underline" href={`/procurement/grns/${d.grnId}`}>View GRN</Link> : "—"],
              ["Subtotal", formatMoney(d.subtotal)], ["Tax", formatMoney(d.tax)], ["Total", <strong key="t">{formatMoney(d.total)}</strong>], ["Paid", formatMoney(d.paidAmount)],
            ]} />
          </Card>
          <DataTable label="Bill lines" rows={d.lines ?? []} rowKey={(l) => l.id}
            columns={[
              { key: "m", header: "Material", cell: (l) => materialLabel(materials.byId, l.materialId) },
              { key: "q", header: "Qty", numeric: true, cell: (l) => `${formatQty(l.qty)} ${unitOf(materials.byId, l.materialId)}` },
              { key: "rate", header: "Rate", numeric: true, cell: (l) => formatMoney(l.rate) },
              { key: "tax", header: "Tax %", numeric: true, cell: (l) => formatQty(l.taxPct) },
            ]} />
          <Card title="Payments" className="mt-4">
            <PaymentsTable rows={d.payments ?? []} vendors={vendors.byId} tz={outlet?.timezone} />
          </Card>
          <PayVendorDialog open={payOpen} onClose={() => setPayOpen(false)} vendorId={d.vendorId} bill={d} onDone={q.reload} />
        </>
      )}
    </DocShell>
  );
}

// ============================================================
// Vendor payments + dues
// ============================================================

function PaymentsTable({ rows, vendors, tz, loading, error, onRetry }: { rows: VendorPayment[]; vendors: Map<string, { name: string }>; tz?: string; loading?: boolean; error?: unknown; onRetry?: () => void }) {
  return (
    <DataTable label="Vendor payments" rows={rows} rowKey={(r) => r.id} loading={loading} error={error} onRetry={onRetry} empty="No payments"
      columns={[
        { key: "paid", header: "Paid", cell: (r) => formatDateTime(r.paidAt, tz) },
        { key: "v", header: "Vendor", cell: (r) => vendors.get(r.vendorId)?.name ?? `#${shortRef(r.vendorId)}` },
        { key: "bill", header: "Bill", cell: (r) => (r.billId ? <Link className="text-brand-600 hover:underline" href={`/procurement/bills/${r.billId}`}>#{shortRef(r.billId)}</Link> : "On account") },
        { key: "m", header: "Method", cell: (r) => r.method },
        { key: "ref", header: "Reference", cell: (r) => r.reference ?? "—" },
        { key: "a", header: "Amount", numeric: true, cell: (r) => formatMoney(r.amount) },
      ]} />
  );
}

function PayVendorDialog({ open, onClose, onDone, vendorId: initialVendor, bill }: { open: boolean; onClose: () => void; onDone: () => void; vendorId?: string; bill?: Bill }) {
  const outletId = useOutletId();
  const vendors = useVendors(open && !bill);
  const [vendorId, setVendorId] = useState(initialVendor ?? "");
  const [billId, setBillId] = useState(bill?.id ?? "");
  const [amount, setAmount] = useState(bill ? String(Number(bill.total) - Number(bill.paidAmount)) : "");
  const [method, setMethod] = useState<string>("BANK");
  const [reference, setReference] = useState("");
  // One key per dialog opening: a retried submit cannot pay twice.
  const [key, setKey] = useState(() => newIdempotencyKey("vpay"));
  const openBills = useQuery<{ items: Bill[] }>(open && !bill && vendorId ? "/api/procurement/bills" : null, { outletId, vendorId, take: 100 });
  const payable = (openBills.data?.items ?? []).filter((b) => b.status === "OPEN" || b.status === "PARTIAL");
  return (
    <FormDialog open={open} onClose={onClose} title={bill ? `Pay bill ${bill.number}` : "Record vendor payment"} submitLabel="Record payment"
      onSubmit={() => api("/api/procurement/vendor-payments", { method: "POST", body: { outletId, vendorId, billId: opt(billId), amount: Number(amount), method, reference: opt(reference), idempotencyKey: key } })}
      onDone={() => { setKey(newIdempotencyKey("vpay")); onDone(); }}>
      {!bill && (
        <>
          <Field label="Vendor" name="vendorId" required><VendorSelect vendors={vendors.items} value={vendorId} onChange={(v) => { setVendorId(v); setBillId(""); }} required /></Field>
          <Field label="Against bill" name="billId" hint="Leave empty to pay on account">
            <Select value={billId} onChange={(e) => { setBillId(e.target.value); const b = payable.find((x) => x.id === e.target.value); if (b) setAmount(String(Number(b.total) - Number(b.paidAmount))); }}>
              <option value="">On account</option>
              {payable.map((b) => <option key={b.id} value={b.id}>{b.number} — outstanding {formatMoney(Number(b.total) - Number(b.paidAmount))}</option>)}
            </Select>
          </Field>
        </>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Amount" name="amount" required hint={bill ? `Outstanding ${formatMoney(Number(bill.total) - Number(bill.paidAmount))}` : undefined}><Input type="number" inputMode="decimal" step="0.01" min="0.01" required value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
        <Field label="Method" name="method"><Select value={method} onChange={(e) => setMethod(e.target.value)}>{VendorPaymentMethod.values.map((m) => <option key={m} value={m}>{m}</option>)}</Select></Field>
      </div>
      <Field label="Reference" name="reference" hint="UTR / cheque no."><Input value={reference} onChange={(e) => setReference(e.target.value)} maxLength={100} /></Field>
    </FormDialog>
  );
}

export function VendorPaymentsScreen() {
  const { can, outletId, outlet } = useShell();
  const vendors = useVendors();
  const [vendorId, setVendorId] = useState("");
  const [open, setOpen] = useState(false);
  const list = usePaged<VendorPayment>("/api/procurement/vendor-payments", { outletId: outletId ?? undefined, vendorId: vendorId || undefined });
  const dues = useQuery<DueRow[]>("/api/procurement/vendor-dues", { outletId: outletId ?? undefined });
  const totalDue = (dues.data ?? []).reduce((a, r) => a + r.due, 0);
  const totalOverdue = (dues.data ?? []).reduce((a, r) => a + r.overdue, 0);
  return (
    <>
      <PageHeader title="Vendor payments" subtitle="Payments made and what is still owed" actions={can("vendor.pay") && <Button variant="primary" onClick={() => setOpen(true)}><Icon name="plus" /> Record payment</Button>} />
      <ProcureNav />
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Outstanding" value={dues.data ? formatMoney(totalDue) : "…"} hint="Open + partially paid bills" />
        <Stat label="Overdue" value={dues.data ? formatMoney(totalOverdue) : "…"} tone={totalOverdue > 0 ? "bad" : undefined} />
      </div>
      <Card title="Vendor dues" className="mb-4">
        <DataTable label="Vendor dues" rows={dues.data ?? []} rowKey={(r) => r.vendorId} loading={dues.loading} error={dues.error} onRetry={dues.reload} empty="Nothing owed"
          columns={[
            { key: "v", header: "Vendor", cell: (r) => r.vendorName },
            { key: "b", header: "Open bills", numeric: true, cell: (r) => r.openBills },
            { key: "billed", header: "Billed", numeric: true, cell: (r) => formatMoney(r.billed) },
            { key: "paid", header: "Paid", numeric: true, cell: (r) => formatMoney(r.paid) },
            { key: "due", header: "Due", numeric: true, cell: (r) => <strong>{formatMoney(r.due)}</strong> },
            { key: "od", header: "Overdue", numeric: true, cell: (r) => <span className={r.overdue > 0 ? "text-bad-500" : ""}>{formatMoney(r.overdue)}</span> },
          ]} />
      </Card>
      <FilterBar><SelectFilter label="Vendor" value={vendorId} onChange={setVendorId} options={vendors.items.map((v) => ({ value: v.id, label: v.name }))} /></FilterBar>
      <PaymentsTable rows={list.items} vendors={vendors.byId} tz={outlet?.timezone} loading={list.loading} error={list.error} onRetry={list.reload} />
      <Pager {...list} />
      <PayVendorDialog open={open} onClose={() => setOpen(false)} onDone={() => { list.reload(); dues.reload(); }} />
    </>
  );
}
