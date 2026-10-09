"use client";

/**
 * The procurement queue (audit PP-04): purchase orders and indents in one list, with the tabs that matter. "Needs approval"
 * comes first and carries a count; whoever holds purchase.approve can approve a submitted document from the row. The server
 * decides what each login may see (a kitchen login sees indents only, with no amounts).
 */
import Link from "next/link";
import { useState } from "react";
import { api } from "@/lib/api/client";
import { useQuery } from "@/lib/hooks/useApi";
import { useShell } from "@/lib/shellContext";
import { formatDateTime, formatElapsed, formatMoney } from "@/lib/format";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { ActionButton } from "@/components/ui/Confirm";
import { DataTable, Pager } from "@/components/ui/Table";
import { PageHeader, StatusBadge, Tabs } from "@/components/ui/Page";
import { FilterBar, SelectFilter } from "@/components/ui/Filters";
import { ProcureNav } from "@/features/backoffice/procurement";
import { useVendors, vendorLabel } from "@/features/backoffice/lookups";
import type { QueueItem, QueueResult, QueueTab } from "@/server/services/procurementQueue";

const KIND_LABEL = { PURCHASE_ORDER: "Purchase order", INDENT: "Indent" } as const;

export function ProcurementQueueScreen() {
  const { can, outlet } = useShell();
  const vendors = useVendors();
  const [tab, setTab] = useState<QueueTab>("needs-approval");
  const [kind, setKind] = useState<"all" | "purchase-order" | "indent">("all");
  const [cursors, setCursors] = useState<Array<string | undefined>>([undefined]);
  const reset = () => setCursors([undefined]);
  const q = useQuery<QueueResult>("/api/procurement/queue", { outletId: outlet?.id, tab, kind: kind === "all" ? undefined : kind, take: 25, cursor: cursors.at(-1) });
  const counts = q.data?.counts;
  const label = (name: string, n?: number) => (n === undefined ? name : `${name} · ${n}`);
  const approve = (r: QueueItem) => () => api(`/api/procurement/${r.kind === "PURCHASE_ORDER" ? "purchase-orders" : "indents"}/${r.id}/transition`, { method: "POST", body: { to: "APPROVED" } });

  return (
    <>
      <PageHeader title="Procurement queue" subtitle="Purchase orders and indents in one list: what is waiting for a decision, what is on its way, what is done" />
      <ProcureNav />
      <Tabs label="Queue" value={tab} onChange={(t) => { setTab(t); reset(); }} options={[
        { value: "needs-approval", label: label("Needs approval", counts?.["needs-approval"]) },
        { value: "in-progress", label: label("In progress", counts?.["in-progress"]) },
        { value: "done", label: label("Done", counts?.done) },
        { value: "all", label: "All" },
      ]} />
      {q.data?.includesPurchaseOrders !== false && (
        <FilterBar>
          <SelectFilter label="Show" value={kind === "all" ? "" : kind} onChange={(v) => { setKind((v || "all") as typeof kind); reset(); }} anyLabel="Orders and indents" options={[{ value: "purchase-order", label: "Purchase orders only" }, { value: "indent", label: "Indents only" }]} />
        </FilterBar>
      )}
      <DataTable<QueueItem> label="Procurement queue" rows={q.data?.items ?? []} rowKey={(r) => `${r.kind}:${r.id}`} loading={q.loading} error={q.error} onRetry={q.reload}
        empty={tab === "needs-approval" ? "Nothing is waiting for approval" : "Nothing here"}
        columns={[
          { key: "kind", header: "Type", cell: (r) => <Badge tone={r.kind === "PURCHASE_ORDER" ? "info" : "neutral"}>{KIND_LABEL[r.kind]}</Badge> },
          { key: "number", header: "Number", cell: (r) => <span><Link href={r.href} className="font-medium text-brand-700 hover:underline">{r.number}</Link>{r.source === "REORDER" && <Badge tone="neutral" className="ml-2">Reorder</Badge>}</span> },
          { key: "status", header: "Status", cell: (r) => (
            <span><StatusBadge status={r.status} />
              {r.status === "SUBMITTED" && r.approval?.needed === 2 && <span className="mt-0.5 block text-xs text-warn-700" data-testid={`steps-${r.number}`}>{r.approval.done} of 2 approvals</span>}
              {r.approval?.autoApproved && <span className="mt-0.5 block text-xs text-ink-500">approved automatically</span>}
            </span>
          ) },
          { key: "vendor", header: "Vendor", cell: (r) => (r.vendorId ? vendorLabel(vendors.byId, r.vendorId) : "—") },
          { key: "lines", header: "Lines", numeric: true, cell: (r) => r.lines },
          { key: "total", header: "Total", numeric: true, cell: (r) => (r.total === null ? "—" : formatMoney(r.total)) },
          { key: "age", header: "Raised", cell: (r) => <span title={formatDateTime(r.createdAt, outlet?.timezone)}>{formatElapsed(r.createdAt)} ago</span> },
          {
            key: "act", header: "", cell: (r) => (
              <div className="flex justify-end gap-1">
                {r.status === "SUBMITTED" && can("purchase.approve") && (
                  <ActionButton size="sm" variant="success" action={approve(r)} onDone={q.reload} success="Approved"
                    confirm={{ title: `Approve ${r.number}?`, message: r.total === null ? "The store can then act on it." : r.approval?.needed === 2 ? `${formatMoney(r.total)} — approval ${r.approval.done + 1} of 2.` : `${formatMoney(r.total)} — purchasing can then send it to the vendor.`, confirmLabel: "Approve" }}>
                    {r.approval?.needed === 2 ? `Approve (${r.approval.done + 1} of 2)` : "Approve"}
                  </ActionButton>
                )}
                <Link href={r.href} className="inline-flex h-8 items-center rounded-md border border-ink-300 px-2.5 text-sm font-medium hover:bg-ink-100" aria-label={`Open ${r.number}`}>Open</Link>
              </div>
            ),
          },
        ]} />
      <Pager page={cursors.length} hasPrev={cursors.length > 1 && !q.loading} hasNext={Boolean(q.data?.nextCursor) && !q.loading} prev={() => setCursors((c) => c.slice(0, -1))} next={() => q.data?.nextCursor && setCursors((c) => [...c, q.data!.nextCursor!])} />
      <p className="mt-3 text-xs text-ink-500"><Icon name="clock" /> Newest first. Approving here is the same approval as on the document: the server checks your permission and the outlet.</p>
    </>
  );
}
