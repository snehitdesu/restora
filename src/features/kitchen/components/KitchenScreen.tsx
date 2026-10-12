"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, describeError } from "@/lib/api/client";
import { createPoller, type Poller } from "@/lib/polling";
import { KDS_COLUMNS, NO_EXPECTATIONS, expectationsFrom, groupTickets, lateSummary, type KdsTicket, type PrepExpectations } from "@/features/kitchen/kds";
import type { KOTStatus } from "@/constants/enums";
import { TicketCard } from "@/features/kitchen/components/TicketCard";
import { BACKGROUND_HEADER } from "@/constants/auth";
import { LoadingState, ErrorState } from "@/components/ui/States";
import { useToast } from "@/components/ui/Toast";

type Station = { id: string; name: string; kind: string };
const INTERVALS = [5, 10, 20, 30];

/**
 * Kitchen display. Transport: polling (the backend has no push channel yet) via
 * createPoller — no overlapping requests, pauses while the tab is hidden,
 * refreshes on return and after every action. Station filtering is applied by
 * the server (GET /api/kitchen/kots?stationId=…), which also enforces kot.view.
 */
export function KitchenScreen({ outletId, canUpdate }: { outletId: string; canUpdate: boolean }) {
  const toast = useToast();
  const [stations, setStations] = useState<Station[]>([]);
  const [stationId, setStationId] = useState<string>("all");
  const [intervalSec, setIntervalSec] = useState(5);
  const [tickets, setTickets] = useState<KdsTicket[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const [pending, setPending] = useState<Set<string>>(new Set());
  const [now, setNow] = useState(() => Date.now());
  const [expectations, setExpectations] = useState<PrepExpectations>(NO_EXPECTATIONS);
  const poller = useRef<Poller | null>(null);

  useEffect(() => {
    api<Station[]>("/api/kitchen/stations", { query: { outletId } }).then(setStations).catch(() => setStations([]));
  }, [outletId]);

  // What each dish usually takes at this outlet (measured from the last two weeks of tickets). If it cannot be loaded the
  // board falls back to the fixed 10 / 20 minute lines; it never blocks the kitchen.
  useEffect(() => {
    let alive = true;
    const load = () =>
      api<{ dishes: Array<{ menuItemId: string | null; name: string; medianMinutes: number; reliable: boolean }> }>("/api/kitchen/prep-times", { query: { outletId, days: 14 }, headers: { [BACKGROUND_HEADER]: "1" } })
        .then((r) => alive && setExpectations(expectationsFrom(r.dishes)))
        .catch(() => undefined);
    void load();
    const t = setInterval(load, 10 * 60_000);
    return () => { alive = false; clearInterval(t); };
  }, [outletId]);

  useEffect(() => {
    setTickets(null);
    const p = createPoller<KdsTicket[]>({
      intervalMs: intervalSec * 1000,
      fetch: (signal) => api<KdsTicket[]>("/api/kitchen/kots", { query: { outletId, stationId: stationId === "all" ? undefined : stationId }, signal }),
      onData: (data) => {
        setTickets(data);
        setError(null);
        setLastUpdated(Date.now());
      },
      onError: (e) => setError(e),
    });
    poller.current = p;
    p.start();
    return () => p.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- interval changes are applied below without restarting
  }, [outletId, stationId]);

  useEffect(() => poller.current?.setInterval(intervalSec * 1000), [intervalSec]);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15_000); // ticket age display only
    return () => clearInterval(t);
  }, []);

  const columns = useMemo(() => groupTickets(tickets ?? []), [tickets]);
  const lateness = useMemo(() => lateSummary(tickets ?? [], now, expectations), [tickets, now, expectations]);

  async function act(ticket: KdsTicket, to: KOTStatus) {
    if (pending.has(ticket.id)) return;
    setPending((s) => new Set(s).add(ticket.id));
    try {
      await api(`/api/kitchen/kots/${ticket.id}/status`, { method: "POST", body: { status: to } });
      await poller.current?.refresh(); // show the server's state, not an assumed one
    } catch (e) {
      if (e instanceof ApiError && e.kind === "unauthorized") window.location.href = "/login?next=/kitchen";
      toast.show(`KOT ${ticket.number}: ${describeError(e)}`, "bad");
      await poller.current?.refresh();
    } finally {
      setPending((s) => {
        const n = new Set(s);
        n.delete(ticket.id);
        return n;
      });
    }
  }

  const stale = error !== null && tickets !== null;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-3 border-b border-ink-200 bg-paper px-3 py-2">
        <label className="flex items-center gap-2 text-sm">
          Station
          <select id="kds-station" name="station" value={stationId} onChange={(e) => setStationId(e.target.value)} className="h-9 rounded-md border border-ink-300 bg-paper px-2 text-sm">
            <option value="all">All stations</option>
            {stations.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2 text-sm">
          Refresh
          <select id="kds-refresh" name="refresh" value={intervalSec} onChange={(e) => setIntervalSec(Number(e.target.value))} className="h-9 rounded-md border border-ink-300 bg-paper px-2 text-sm">
            {INTERVALS.map((s) => (
              <option key={s} value={s}>every {s}s</option>
            ))}
          </select>
        </label>
        {(lateness.late > 0 || lateness.due > 0) && (
          <p role="status" aria-live="polite" data-testid="kds-late-banner" className={`rounded-md px-2.5 py-1 text-sm font-bold ${lateness.late > 0 ? "bg-bad-500 text-white" : "bg-warn-50 text-warn-700"}`}>
            {lateness.late > 0 ? `${lateness.late} ${lateness.late === 1 ? "ticket is" : "tickets are"} running late` : null}
            {lateness.late > 0 && lateness.due > 0 ? " · " : null}
            {lateness.due > 0 ? `${lateness.due} at their usual time` : null}
          </p>
        )}
        <p className="ml-auto text-xs text-ink-500" aria-live="polite">
          {stale ? <span className="font-semibold text-bad-500">Connection problem — showing last known tickets. {describeError(error)}</span> : lastUpdated ? `Updated ${new Date(lastUpdated).toLocaleTimeString()}` : "Connecting…"}
        </p>
      </div>

      {tickets === null ? (
        error ? <ErrorState error={error} onRetry={() => void poller.current?.refresh()} /> : <LoadingState label="Loading tickets…" />
      ) : (
        <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 overflow-hidden p-3 md:grid-cols-3">
          {KDS_COLUMNS.map((col) => (
            <section key={col.id} aria-labelledby={`col-${col.id}`} className={`flex min-h-0 flex-col rounded-xl border bg-ink-50 ${col.id === "ready" ? "border-ok-100" : col.id === "new" ? "border-brand-100" : "border-ink-200"}`}>
              <h2 id={`col-${col.id}`} className="flex items-center justify-between px-3 py-2 text-sm font-bold uppercase tracking-wide text-ink-700">
                {col.title}
                <span className="rounded-full bg-paper px-2 text-xs tabular-nums shadow-xs">{columns[col.id].length}</span>
              </h2>
              <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-2 pb-2">
                {columns[col.id].length === 0 ? (
                  <p className="p-4 text-center text-sm text-ink-500">No tickets</p>
                ) : (
                  columns[col.id].map((t) => <TicketCard key={t.id} ticket={t} now={now} expectations={expectations} pending={pending.has(t.id)} canUpdate={canUpdate} onAction={(to) => void act(t, to)} />)
                )}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
