"use client";

/**
 * Kitchen prep times: how long dishes really take, measured from the KOT lifecycle (reached the kitchen -> marked READY).
 * The KDS uses the same numbers to flag a ticket as late before the guest complains.
 */
import { useState } from "react";
import { useQuery } from "@/lib/hooks/useApi";
import { useShell } from "@/lib/shellContext";
import { DataTable } from "@/components/ui/Table";
import { Card, PageHeader, Stat } from "@/components/ui/Page";
import { Badge } from "@/components/ui/Badge";
import { FilterBar, SelectFilter } from "@/components/ui/Filters";

type PrepNumbers = { tickets: number; averageMinutes: number; medianMinutes: number; p90Minutes: number; cookMedianMinutes: number | null };
type Result = {
  days: number; minSamples: number; truncated: boolean; overall: PrepNumbers;
  dishes: Array<PrepNumbers & { key: string; name: string; reliable: boolean }>;
  stations: Array<PrepNumbers & { stationId: string | null; name: string }>;
};
const min = (n: number | null) => (n === null ? "—" : `${n.toFixed(1)} min`);

export function PrepTimesScreen() {
  const { outletId, outlet } = useShell();
  const [days, setDays] = useState("30");
  const q = useQuery<Result>(outletId ? "/api/kitchen/prep-times" : null, { outletId: outletId ?? undefined, days });
  const r = q.data;
  return (
    <>
      <PageHeader title="Kitchen prep times" subtitle={`Measured at ${outlet?.name ?? "this outlet"}: from the moment a ticket reaches the kitchen to the moment it is marked ready`} />
      <FilterBar><SelectFilter label="Period" value={days} onChange={setDays} anyLabel="Last 30 days" options={[{ value: "7", label: "Last 7 days" }, { value: "14", label: "Last 14 days" }, { value: "90", label: "Last 90 days" }, { value: "365", label: "Last year" }]} /></FilterBar>
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Tickets measured" value={r ? r.overall.tickets : "…"} />
        <Stat label="Typical ticket (median)" value={r ? min(r.overall.medianMinutes) : "…"} />
        <Stat label="Slow ticket (90th percentile)" value={r ? min(r.overall.p90Minutes) : "…"} hint="9 in 10 tickets are ready sooner than this" />
        <Stat label="Cooking only (median)" value={r ? min(r.overall.cookMedianMinutes) : "…"} hint="From Start to ready" />
      </div>
      <div className="grid gap-4 lg:grid-cols-[1fr_24rem]">
        <Card title="By dish" bodyClassName="p-0">
          <DataTable label="Preparation time by dish" rows={r?.dishes ?? []} rowKey={(d) => d.key} loading={q.loading} error={q.error} onRetry={q.reload}
            empty="No finished tickets in this period" emptyHint="Times appear once the kitchen marks tickets ready on the KDS."
            columns={[
              { key: "n", header: "Dish", cell: (d) => <span className="font-medium text-ink-900">{d.name}</span> },
              { key: "t", header: "Tickets", numeric: true, cell: (d) => d.tickets },
              { key: "m", header: "Median", numeric: true, cell: (d) => min(d.medianMinutes) },
              { key: "a", header: "Average", numeric: true, cell: (d) => min(d.averageMinutes) },
              { key: "p", header: "90th", numeric: true, cell: (d) => min(d.p90Minutes) },
              { key: "u", header: "KDS expects", cell: (d) => (d.reliable ? <Badge tone="ok">~{Math.round(d.medianMinutes)} min</Badge> : <span className="text-ink-500" title={`Needs ${r?.minSamples ?? 3} tickets`}>too few tickets</span>) },
            ]} />
        </Card>
        <Card title="By station" bodyClassName="p-0">
          <DataTable label="Preparation time by station" rows={r?.stations ?? []} rowKey={(s) => s.stationId ?? "none"} loading={q.loading} empty="No data yet"
            columns={[
              { key: "n", header: "Station", cell: (s) => s.name },
              { key: "t", header: "Tickets", numeric: true, cell: (s) => s.tickets },
              { key: "m", header: "Median", numeric: true, cell: (s) => min(s.medianMinutes) },
              { key: "p", header: "90th", numeric: true, cell: (s) => min(s.p90Minutes) },
            ]} />
        </Card>
      </div>
      <p className="mt-3 text-xs text-ink-500">A ticket holds several dishes cooked together, so each dish is credited with its ticket&apos;s time. Cancelled tickets and tickets never marked ready are not counted.{r?.truncated ? " Only the most recent 5,000 tickets are used." : ""}</p>
    </>
  );
}
