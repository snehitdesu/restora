"use client";

/**
 * Stock that is about to expire (audit IN-14): the batches to use first, with their batch number and FSSAI lot code.
 * What is left of each batch is derived from the stock on hand assuming earliest-expiry-first use; the screen says so.
 */
import { useState } from "react";
import { useQuery } from "@/lib/hooks/useApi";
import { useShell } from "@/lib/shellContext";
import { formatDate, formatQty } from "@/lib/format";
import { Badge } from "@/components/ui/Badge";
import { DataTable } from "@/components/ui/Table";
import { PageHeader, Stat } from "@/components/ui/Page";
import { FilterBar, SelectFilter } from "@/components/ui/Filters";
import type { ExpiryReport, ExpiryRow } from "@/server/services/expiry";

const WINDOWS = [{ value: "3", label: "3 days" }, { value: "7", label: "7 days" }, { value: "14", label: "14 days" }, { value: "30", label: "30 days" }, { value: "60", label: "60 days" }] as const;

const when = (r: ExpiryRow) => (r.status === "EXPIRED" ? `expired ${-r.daysLeft} day${r.daysLeft === -1 ? "" : "s"} ago` : r.status === "TODAY" ? "today" : `in ${r.daysLeft} day${r.daysLeft === 1 ? "" : "s"}`);

export function ExpiryScreen() {
  const { outlet } = useShell();
  const [days, setDays] = useState("7");
  const q = useQuery<ExpiryReport>(outlet ? "/api/inventory/expiring" : null, { outletId: outlet?.id, days });
  const r = q.data;
  return (
    <>
      <PageHeader title="Expiry" subtitle="Batches that expire soon, or already have: use the earliest first" />
      <FilterBar>
        <SelectFilter label="Look ahead" value={days} onChange={(v) => setDays(v || "7")} options={WINDOWS} anyLabel="7 days" />
      </FilterBar>
      <div className="mb-4 grid grid-cols-3 gap-3">
        <Stat label="Expired" value={r?.counts.expired ?? "—"} tone={r?.counts.expired ? "bad" : undefined} hint="still on the shelf" />
        <Stat label="Today" value={r?.counts.today ?? "—"} hint="expire today" />
        <Stat label="Soon" value={r?.counts.soon ?? "—"} hint={`within ${days} days`} />
      </div>
      <DataTable<ExpiryRow> label="Expiring batches" rows={r?.rows ?? []} rowKey={(x) => `${x.materialId}:${x.batchNo}:${x.fssaiLot}:${x.expiryDate}`} loading={q.loading} error={q.error} onRetry={q.reload}
        empty="Nothing expires in this period"
        columns={[
          { key: "m", header: "Material", cell: (x) => <span><span className="font-medium text-ink-900">{x.name}</span><span className="block text-xs text-ink-500">{x.sku}</span></span> },
          { key: "b", header: "Batch", cell: (x) => x.batchNo ?? "—" },
          { key: "l", header: "FSSAI lot", cell: (x) => x.fssaiLot ?? "—" },
          { key: "e", header: "Expires", cell: (x) => <span><span className="tabular-nums">{formatDate(x.expiryDate)}</span><Badge tone={x.status === "EXPIRED" ? "bad" : x.status === "TODAY" ? "warn" : "info"} className="ml-2">{when(x)}</Badge></span> },
          { key: "q", header: "Left", numeric: true, cell: (x) => `${formatQty(x.remaining)} ${x.unit ?? ""}` },
          { key: "u", header: "", cell: (x) => (x.useFirst ? <Badge tone="ok">Use first</Badge> : null) },
        ]} />
      <p className="mt-3 text-xs text-ink-500">{r?.basis}</p>
    </>
  );
}
