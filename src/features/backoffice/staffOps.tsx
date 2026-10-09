"use client";

/**
 * The roster (who works which shift on which day) and checklists (opening / closing / training duty lists that become the
 * day's tasks). The staff service enforces everything; the screens only show what the actor may do.
 */
import { useState } from "react";
import { api } from "@/lib/api/client";
import { useQuery } from "@/lib/hooks/useApi";
import { useShell } from "@/lib/shellContext";
import { humanize, isoDay } from "@/lib/format";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { Badge } from "@/components/ui/Badge";
import { Field, FormDialog, Input, Select, Textarea } from "@/components/ui/Form";
import { Card, PageHeader } from "@/components/ui/Page";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/States";
import { ActionButton } from "@/components/ui/Confirm";
import { DataTable } from "@/components/ui/Table";
import { ScrollRegion } from "@/components/ui/ScrollRegion";
import { PeopleNav } from "@/features/backoffice/staff";
import type { RosterView } from "@/server/services/staffOps";

const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
/** The Monday on or before a calendar day. */
const mondayOf = (day: string) => addDays(day, -((new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7));
const dayLabel = (day: string) => new Intl.DateTimeFormat("en-IN", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(`${day}T00:00:00Z`));

// ============================================================
// Roster
// ============================================================

type Cell = { shiftId: string; shiftName: string; date: string };

function AssignDialog({ cell, people, onClose, onDone }: { cell: Cell; people: RosterView["people"]; onClose: () => void; onDone: () => void }) {
  const [userId, setUserId] = useState("");
  return (
    <FormDialog open onClose={onClose} title={`${cell.shiftName} · ${dayLabel(cell.date)}`} submitLabel="Put on shift" description="A person cannot be on two overlapping shifts, or on a day of approved leave."
      onSubmit={() => api("/api/staff/roster", { method: "POST", body: { shiftId: cell.shiftId, userId, date: cell.date } })} onDone={onDone}>
      <Field label="Who" name="userId" required>
        <Select value={userId} onChange={(e) => setUserId(e.target.value)} required>
          <option value="">Choose a person…</option>
          {people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </Select>
      </Field>
    </FormDialog>
  );
}

function ShiftDialog({ outletId, onClose, onDone }: { outletId: string; onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState("");
  const [startTime, setStart] = useState("09:00");
  const [endTime, setEnd] = useState("17:00");
  return (
    <FormDialog open onClose={onClose} title="New shift" submitLabel="Add shift" description="A shift is a time of day (for example Lunch, 11:00 to 15:00). A shift that ends before it starts runs into the next morning."
      onSubmit={() => api("/api/staff/shifts", { method: "POST", body: { outletId, name: name.trim(), startTime, endTime } })} onDone={onDone}>
      <Field label="Name" name="name" required><Input value={name} onChange={(e) => setName(e.target.value)} required maxLength={60} /></Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Starts" name="startTime" required><Input type="time" value={startTime} onChange={(e) => setStart(e.target.value)} required /></Field>
        <Field label="Ends" name="endTime" required><Input type="time" value={endTime} onChange={(e) => setEnd(e.target.value)} required /></Field>
      </div>
    </FormDialog>
  );
}

type MyShift = { id: string; date: string; outletId: string; outlet: string; shift: string; startTime: string; endTime: string };

function MyShifts({ from }: { from: string }) {
  const mine = useQuery<MyShift[]>("/api/staff/my-shifts", { from, days: 14 });
  return (
    <Card title="My shifts" className="mt-6" bodyClassName="p-0">
      {mine.error ? <ErrorState error={mine.error} onRetry={mine.reload} /> : !mine.data ? <LoadingState /> : mine.data.length === 0 ? <EmptyState title="Nothing rostered for you in the next two weeks" /> : (
        <ul className="divide-y divide-ink-100 text-sm" aria-label="My upcoming shifts">
          {mine.data.map((m) => (
            <li key={m.id} className="flex items-center justify-between gap-3 px-4 py-2">
              <span className="font-medium text-ink-900">{dayLabel(m.date)}</span>
              <span className="text-ink-700">{m.shift} · {m.startTime}–{m.endTime}</span>
              <span className="text-xs text-ink-500">{m.outlet}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

export function RosterScreen() {
  const { can, outletId, outlet } = useShell();
  const manage = can("staff.manage");
  const today = isoDay(new Date(), outlet?.timezone);
  const [from, setFrom] = useState(() => mondayOf(today));
  const [assigning, setAssigning] = useState<Cell | null>(null);
  const [addingShift, setAddingShift] = useState(false);
  const grid = useQuery<RosterView>(manage && outletId ? "/api/staff/roster" : null, { outletId: outletId ?? undefined, from, days: 7 });
  const g = grid.data;
  return (
    <>
      <PageHeader title="Roster" subtitle={manage ? `Who works which shift at ${outlet?.name ?? "this outlet"}` : "Your upcoming shifts"}
        actions={manage && <Button variant="primary" onClick={() => setAddingShift(true)}><Icon name="plus" /> New shift</Button>} />
      <PeopleNav />
      {manage && (
        <>
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <Button size="sm" onClick={() => setFrom(addDays(from, -7))} aria-label="Previous week">Previous week</Button>
            <Button size="sm" onClick={() => setFrom(mondayOf(today))} disabled={from === mondayOf(today)}>This week</Button>
            <Button size="sm" onClick={() => setFrom(addDays(from, 7))} aria-label="Next week">Next week</Button>
            <span className="text-sm text-ink-600" aria-live="polite">{dayLabel(from)} to {dayLabel(addDays(from, 6))}</span>
          </div>
          {grid.error ? <ErrorState error={grid.error} onRetry={grid.reload} /> : !g ? <LoadingState /> : g.days[0].shifts.length === 0 ? (
            <EmptyState title="No shifts yet" hint="Add the shifts this outlet runs (for example Lunch and Dinner), then put people on them." icon="clock" />
          ) : (
            <ScrollRegion label="Roster (scrolls sideways)" className="rounded-lg border border-ink-200 bg-paper">
              <table className="w-full min-w-[56rem] border-collapse text-left text-sm">
                <caption className="sr-only">Roster for the week starting {from}</caption>
                <thead className="bg-ink-50 text-xs text-ink-600">
                  <tr>
                    <th scope="col" className="px-3 py-2">Shift</th>
                    {g.days.map((d) => <th key={d.date} scope="col" className={`px-3 py-2 ${d.date === today ? "text-brand-700" : ""}`}>{dayLabel(d.date)}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {g.days[0].shifts.map((s, row) => (
                    <tr key={s.shiftId} className="border-t border-ink-100 align-top">
                      <th scope="row" className="whitespace-nowrap px-3 py-2 font-medium text-ink-900">{s.name}<span className="block text-xs font-normal text-ink-500">{s.startTime}–{s.endTime}</span></th>
                      {g.days.map((d) => {
                        const cell = d.shifts[row];
                        return (
                          <td key={d.date} className="px-2 py-2">
                            <ul className="flex flex-col gap-1">
                              {cell.people.map((p) => (
                                <li key={p.assignmentId} className="flex items-center justify-between gap-1 rounded bg-paper-warm px-2 py-0.5">
                                  <span className="truncate">{p.name}{p.onLeave && <Badge tone="warn" className="ml-1">On leave</Badge>}</span>
                                  <ActionButton size="sm" variant="danger" aria-label={`Remove ${p.name} from ${s.name} on ${d.date}`} action={() => api(`/api/staff/roster/${p.assignmentId}`, { method: "DELETE" })} success="Taken off the shift" onDone={grid.reload}
                                    confirm={{ title: `Take ${p.name} off ${s.name}?`, message: dayLabel(d.date), danger: true, confirmLabel: "Remove" }}>×</ActionButton>
                                </li>
                              ))}
                            </ul>
                            <Button size="sm" className="mt-1" aria-label={`Put someone on ${s.name} on ${d.date}`} onClick={() => setAssigning({ shiftId: s.shiftId, shiftName: s.name, date: d.date })}><Icon name="plus" /></Button>
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </ScrollRegion>
          )}
        </>
      )}
      <MyShifts from={today} />
      {assigning && g && <AssignDialog cell={assigning} people={g.people} onClose={() => setAssigning(null)} onDone={grid.reload} />}
      {addingShift && outletId && <ShiftDialog outletId={outletId} onClose={() => setAddingShift(false)} onDone={grid.reload} />}
    </>
  );
}

// ============================================================
// Checklists
// ============================================================

type Template = { id: string; name: string; kind: string; active: boolean; items: Array<{ id: string; title: string; description: string | null; priority: string }>; run: { total: number; open: number; inProgress: number; done: number; verified: number } | null };
const KINDS = ["OPENING", "CLOSING", "TRAINING", "OTHER"];
type Row = { id?: string; title: string; priority: string };

function ChecklistDialog({ outletId, template, onClose, onDone }: { outletId: string; template?: Template; onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState(template?.name ?? "");
  const [kind, setKind] = useState(template?.kind ?? "OPENING");
  const [rows, setRows] = useState<Row[]>(template ? template.items.map((i) => ({ id: i.id, title: i.title, priority: i.priority })) : [{ title: "", priority: "MEDIUM" }]);
  const [pasted, setPasted] = useState("");
  const items = rows.map((r) => ({ ...(r.id ? { id: r.id } : {}), title: r.title.trim(), priority: r.priority })).filter((r) => r.title);
  const set = (i: number, patch: Partial<Row>) => setRows((x) => x.map((r, n) => (n === i ? { ...r, ...patch } : r)));
  const addPasted = () => {
    const lines = pasted.split("\n").map((l) => l.trim()).filter(Boolean);
    if (!lines.length) return;
    setRows((x) => [...x.filter((r) => r.title.trim() || r.id), ...lines.map((title) => ({ title, priority: "MEDIUM" }))]);
    setPasted("");
  };
  return (
    <FormDialog open onClose={onClose} title={template ? `Edit ${template.name}` : "New checklist"} size="lg" submitLabel={template ? "Save" : "Create checklist"}
      description="Each item becomes one task when the checklist is started for a day."
      onSubmit={() => (template
        ? api(`/api/staff/checklists/${template.id}`, { method: "PATCH", body: { name: name.trim(), kind, items } })
        : api("/api/staff/checklists", { method: "POST", body: { outletId, name: name.trim(), kind, items } }))}
      onDone={onDone}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name" name="name" required><Input value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} /></Field>
        <Field label="Kind" name="kind"><Select value={kind} onChange={(e) => setKind(e.target.value)}>{KINDS.map((k) => <option key={k} value={k}>{humanize(k)}</option>)}</Select></Field>
      </div>
      <ul className="flex flex-col gap-2" aria-label="Checklist items">
        {rows.map((r, i) => (
          <li key={r.id ?? `new-${i}`} className="flex items-center gap-2">
            <Input aria-label={`Item ${i + 1}`} value={r.title} onChange={(e) => set(i, { title: e.target.value })} maxLength={160} placeholder="What has to be done" />
            <Select aria-label={`Priority of item ${i + 1}`} className="w-28" value={r.priority} onChange={(e) => set(i, { priority: e.target.value })}>
              {["LOW", "MEDIUM", "HIGH"].map((p) => <option key={p} value={p}>{humanize(p)}</option>)}
            </Select>
            <Button type="button" size="sm" variant="danger" aria-label={`Remove item ${i + 1}`} onClick={() => setRows((x) => x.filter((_, n) => n !== i))} disabled={rows.length === 1}>×</Button>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" onClick={() => setRows((x) => [...x, { title: "", priority: "MEDIUM" }])}><Icon name="plus" /> Add item</Button>
      </div>
      <Field label="Or paste several items, one per line" name="pasted">
        <Textarea rows={3} value={pasted} onChange={(e) => setPasted(e.target.value)} onBlur={addPasted} />
      </Field>
    </FormDialog>
  );
}

export function ChecklistsScreen() {
  const { can, outletId, outlet } = useShell();
  const manage = can("task.manage");
  const today = isoDay(new Date(), outlet?.timezone);
  const [dialog, setDialog] = useState<null | "new" | Template>(null);
  const list = useQuery<Template[]>(outletId ? "/api/staff/checklists" : null, { outletId: outletId ?? undefined, date: today });
  return (
    <>
      <PageHeader title="Checklists" subtitle="Opening, closing and training duty lists" actions={manage && <Button variant="primary" onClick={() => setDialog("new")}><Icon name="plus" /> New checklist</Button>} />
      <PeopleNav />
      <DataTable label="Checklists" rows={list.data ?? []} rowKey={(t) => t.id} loading={list.loading} error={list.error} onRetry={list.reload} empty="No checklists yet"
        columns={[
          { key: "n", header: "Checklist", cell: (t) => <span><span className="font-medium text-ink-900">{t.name}</span><span className="block text-xs text-ink-500">{t.items.length} {t.items.length === 1 ? "item" : "items"}</span></span> },
          { key: "k", header: "Kind", cell: (t) => <Badge>{humanize(t.kind)}</Badge> },
          {
            key: "p", header: "Today", cell: (t) => (t.run && t.run.total > 0
              ? <span aria-label={`${t.run.done + t.run.verified} of ${t.run.total} done today`}><strong>{t.run.done + t.run.verified}</strong> of {t.run.total} done{t.run.verified > 0 && <span className="text-xs text-ink-500"> · {t.run.verified} checked</span>}</span>
              : <span className="text-ink-500">Not started</span>),
          },
          {
            key: "a", header: "", cell: (t) => manage && (
              <div className="flex justify-end gap-1">
                <ActionButton size="sm" variant="primary" aria-label={`Start ${t.name} for today`} action={() => api<{ created: number; existing: number }>(`/api/staff/checklists/${t.id}/start`, { method: "POST", body: {} })} onDone={list.reload}
                  success="Today's tasks are ready">{t.run && t.run.total > 0 ? "Add missing tasks" : "Start for today"}</ActionButton>
                <Button size="sm" onClick={() => setDialog(t)} aria-label={`Edit ${t.name}`}>Edit</Button>
                <ActionButton size="sm" variant="danger" action={() => api(`/api/staff/checklists/${t.id}`, { method: "PATCH", body: { active: false } })} onDone={list.reload} success="Checklist retired"
                  confirm={{ title: `Retire ${t.name}?`, message: "It can no longer be started. Tasks already made from it stay.", danger: true, confirmLabel: "Retire" }}>Retire</ActionButton>
              </div>
            ),
          },
        ]} />
      <p className="mt-3 text-xs text-ink-500">Starting a checklist makes one task per item on the Tasks screen, once per day: starting it again only adds items that were added since.</p>
      {dialog && outletId && <ChecklistDialog outletId={outletId} template={dialog === "new" ? undefined : dialog} onClose={() => setDialog(null)} onDone={list.reload} />}
    </>
  );
}

