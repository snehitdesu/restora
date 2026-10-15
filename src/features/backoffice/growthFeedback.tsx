"use client";

/**
 * Guest feedback: what guests said (from the link we send, from the order page, or typed in by staff), who has dealt
 * with the unhappy ones, and what keeps going wrong (by dish, time of day and server). Unhappy answers stay private:
 * only happy guests are ever sent to a public review page.
 */
import Link from "next/link";
import { useMemo, useState } from "react";
import { api } from "@/lib/api/client";
import { useQuery, usePaged } from "@/lib/hooks/useApi";
import { useShell } from "@/lib/shellContext";
import { formatDateTime, humanize, shortRef } from "@/lib/format";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { Badge } from "@/components/ui/Badge";
import { Field, FormDialog, Input, Select, Textarea, opt } from "@/components/ui/Form";
import { DataTable, Pager } from "@/components/ui/Table";
import { Card, PageHeader, Stat, Tabs } from "@/components/ui/Page";
import { FilterBar, SelectFilter } from "@/components/ui/Filters";

type FeedbackRow = {
  id: string; outletId: string | null; customerId: string | null; customerName: string | null; orderId: string | null; rating: number; comment: string | null; createdAt: string;
  source: string; status: string; routedTo: string | null; resolution: string | null; handledAt: string | null;
};
type Customer = { id: string; name: string };
type Trends = {
  lowRatingMax: number; minOrdersForRanking: number;
  overall: { answers: number; average: number | null; low: number; distribution: Array<{ rating: number; count: number }> };
  byDay: Array<{ date: string; answers: number; average: number | null; low: number }>;
  byDayPart: Array<{ key: string; label: string; answers: number; average: number | null; low: number }>;
  byStaff: Array<{ userId: string; name: string; answers: number; average: number | null; low: number }>;
  byDish: Array<{ name: string; answers: number; average: number | null; low: number; lowShare: number; ranked: boolean }>;
};

const STATUS_TONE: Record<string, "info" | "warn" | "ok"> = { NEW: "warn", ACKNOWLEDGED: "info", RESOLVED: "ok" };

export function Stars({ rating }: { rating: number }) {
  return <span aria-label={`${rating} of 5`} className="tracking-tight text-warn-500">{"★".repeat(rating)}<span className="text-ink-300">{"★".repeat(Math.max(0, 5 - rating))}</span></span>;
}

function RecordDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { outletId } = useShell();
  const [rating, setRating] = useState("5");
  const [comment, setComment] = useState("");
  const [phone, setPhone] = useState("");
  const submit = async () => {
    let customerId: string | undefined;
    if (phone.trim()) {
      const found = await api<Customer[]>("/api/customers", { query: { phone: phone.trim() } });
      if (!found[0]) throw new Error("No customer with this phone number");
      customerId = found[0].id;
    }
    return api("/api/customers/feedback", { method: "POST", body: { outletId, rating: Number(rating), comment: opt(comment), customerId } });
  };
  return (
    <FormDialog open onClose={onClose} title="Record feedback" submitLabel="Save feedback" onSubmit={submit} onDone={onDone}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Rating" name="rating" required><Select value={rating} onChange={(e) => setRating(e.target.value)}>{[5, 4, 3, 2, 1].map((n) => <option key={n} value={n}>{"★".repeat(n)} ({n})</option>)}</Select></Field>
        <Field label="Customer phone" name="customerId" hint="Optional — links to an existing customer"><Input type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} maxLength={16} /></Field>
      </div>
      <Field label="Comment" name="comment"><Textarea value={comment} onChange={(e) => setComment(e.target.value)} maxLength={2000} /></Field>
    </FormDialog>
  );
}

function HandleDialog({ row, onClose, onDone }: { row: FeedbackRow; onClose: () => void; onDone: () => void }) {
  const [status, setStatus] = useState<"ACKNOWLEDGED" | "RESOLVED">(row.status === "NEW" ? "ACKNOWLEDGED" : "RESOLVED");
  const [resolution, setResolution] = useState("");
  return (
    <FormDialog open onClose={onClose} title="Follow up" submitLabel={status === "RESOLVED" ? "Mark resolved" : "Acknowledge"}
      description={row.comment ? `“${row.comment.slice(0, 200)}”` : `${row.rating}-star rating, no comment`}
      onSubmit={() => api(`/api/growth/feedback/${row.id}/handle`, { method: "POST", body: { status, resolution: opt(resolution) } })} onDone={onDone}>
      <Field label="Status" name="status">
        <Select value={status} onChange={(e) => setStatus(e.target.value as "ACKNOWLEDGED" | "RESOLVED")}>
          {row.status === "NEW" && <option value="ACKNOWLEDGED">Acknowledged — someone is on it</option>}
          <option value="RESOLVED">Resolved</option>
        </Select>
      </Field>
      <Field label="What was done" name="resolution" required={status === "RESOLVED"} hint={status === "RESOLVED" ? "Recorded with your name, e.g. “Called the guest, refunded the dish”" : "Optional"}>
        <Textarea value={resolution} onChange={(e) => setResolution(e.target.value)} required={status === "RESOLVED"} maxLength={500} />
      </Field>
    </FormDialog>
  );
}

function Inbox() {
  const { can, outlet, outletId } = useShell();
  const [status, setStatus] = useState("");
  const [rating, setRating] = useState("");
  const [source, setSource] = useState("");
  const list = usePaged<FeedbackRow>(outletId ? "/api/growth/feedback" : null, { outletId: outletId ?? undefined, status: status || undefined, maxRating: rating || undefined, source: source || undefined }, 25);
  const [handling, setHandling] = useState<FeedbackRow | null>(null);
  const attention = useQuery<{ new: number; acknowledged: number }>(can("growth.view") ? "/api/growth/feedback/attention" : null);
  const manage = can("growth.manage");
  const avg = list.items.length ? list.items.reduce((a, r) => a + r.rating, 0) / list.items.length : 0;
  return (
    <>
      {attention.data && (attention.data.new > 0 || attention.data.acknowledged > 0) && (
        <p role="status" className="mb-3 rounded-md border border-warn-100 bg-warn-50 px-3 py-2 text-sm text-warn-700">
          {attention.data.new > 0 && <><strong>{attention.data.new}</strong> unhappy {attention.data.new === 1 ? "answer is" : "answers are"} waiting for someone. </>}
          {attention.data.acknowledged > 0 && <><strong>{attention.data.acknowledged}</strong> {attention.data.acknowledged === 1 ? "is" : "are"} being handled.</>}
        </p>
      )}
      {list.items.length > 0 && (
        <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat label="Average rating" value={avg.toFixed(1)} hint="On this page" />
          <Stat label="Low ratings (≤ 2)" value={list.items.filter((r) => r.rating <= 2).length} tone={list.items.some((r) => r.rating <= 2) ? "bad" : undefined} hint="On this page" />
        </div>
      )}
      <FilterBar>
        <SelectFilter label="Status" value={status} onChange={setStatus} options={["NEW", "ACKNOWLEDGED", "RESOLVED"].map((s) => ({ value: s, label: humanize(s) }))} />
        <SelectFilter label="Rating" value={rating} onChange={setRating} anyLabel="Any rating" options={[1, 2, 3, 4].map((n) => ({ value: String(n), label: `${n} ★ or less` }))} />
        <SelectFilter label="From" value={source} onChange={setSource} anyLabel="Anyone" options={[{ value: "GUEST", label: "Guests (link or order page)" }, { value: "STAFF", label: "Entered by staff" }]} />
      </FilterBar>
      <DataTable label="Feedback" rows={list.items} rowKey={(r) => r.id} loading={list.loading} error={list.error} onRetry={list.reload} empty={status || rating || source ? "Nothing matches" : "No feedback yet"}
        columns={[
          { key: "d", header: "Date", cell: (r) => formatDateTime(r.createdAt, outlet?.timezone) },
          { key: "r", header: "Rating", cell: (r) => <Stars rating={r.rating} /> },
          { key: "c", header: "Comment", cell: (r) => (
            <div className="max-w-md">
              <p>{r.comment ?? "—"}</p>
              {r.resolution && r.status === "RESOLVED" && r.rating <= 3 ? <p className="mt-0.5 text-xs text-ink-500">Done: {r.resolution}</p> : null}
            </div>
          ) },
          { key: "so", header: "From", cell: (r) => <span className="text-ink-500">{r.source === "GUEST" ? "Guest" : "Staff"}{r.routedTo === "GOOGLE" ? " · sent to review page" : ""}</span> },
          { key: "st", header: "Status", cell: (r) => <Badge tone={STATUS_TONE[r.status] ?? "neutral"}>{humanize(r.status)}</Badge> },
          { key: "cu", header: "Customer", cell: (r) => (r.customerId ? <Link className="text-brand-600 hover:underline" href={`/customers/${r.customerId}`}>{r.customerName ?? "View"}</Link> : "—") },
          { key: "o", header: "Order", cell: (r) => (r.orderId ? `#${shortRef(r.orderId)}` : "—") },
          { key: "a", header: "", cell: (r) => (manage && r.status !== "RESOLVED" ? <div className="flex justify-end"><Button size="sm" onClick={() => setHandling(r)}>Follow up</Button></div> : null) },
        ]} />
      <Pager {...list} />
      {handling && <HandleDialog row={handling} onClose={() => setHandling(null)} onDone={() => { list.reload(); attention.reload(); }} />}
    </>
  );
}

function TrendTable<T>({ label, rows, rowKey, columns }: { label: string; rows: T[]; rowKey: (r: T) => string; columns: Array<{ key: string; header: string; cell: (r: T) => React.ReactNode; numeric?: boolean }> }) {
  return <DataTable label={label} rows={rows} rowKey={rowKey} empty="Not enough answers yet" columns={columns} />;
}

function TrendsView() {
  const { outletId, outlet } = useShell();
  const [days, setDays] = useState("30");
  const range = useMemo(() => {
    const to = new Date();
    return { from: new Date(to.getTime() - Number(days) * 86400_000).toISOString(), to: to.toISOString() };
  }, [days]);
  const trends = useQuery<Trends>(outletId ? "/api/growth/feedback/trends" : null, { outletId: outletId ?? undefined, ...range });
  const t = trends.data;
  return (
    <>
      <FilterBar><SelectFilter label="Period" value={days} onChange={setDays} anyLabel="Last 30 days" options={[{ value: "7", label: "Last 7 days" }, { value: "90", label: "Last 90 days" }, { value: "365", label: "Last year" }]} /></FilterBar>
      {trends.error ? <DataTable label="Trends" rows={[]} rowKey={() => "x"} columns={[]} error={trends.error} onRetry={trends.reload} /> : (
        <>
          <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Answers" value={t ? t.overall.answers : "…"} />
            <Stat label="Average rating" value={t ? (t.overall.average ?? "—") : "…"} />
            <Stat label={`Unhappy (≤ ${t?.lowRatingMax ?? 3} stars)`} value={t ? t.overall.low : "…"} tone={t?.overall.low ? "bad" : undefined} />
            <Stat label="5 stars" value={t ? (t.overall.distribution.find((d) => d.rating === 5)?.count ?? 0) : "…"} tone="ok" />
          </div>
          {t && t.overall.answers > 0 ? (
            <div className="grid gap-4 lg:grid-cols-2">
              <Card title="Dishes on unhappy orders" bodyClassName="p-0">
                <TrendTable label="Feedback by dish" rows={t.byDish} rowKey={(r) => r.name} columns={[
                  { key: "n", header: "Dish", cell: (r) => <span className="font-medium text-ink-900">{r.name}</span> },
                  { key: "a", header: "Orders rated", numeric: true, cell: (r) => r.answers },
                  { key: "avg", header: "Average", numeric: true, cell: (r) => (r.average ?? "—") },
                  { key: "l", header: "Unhappy", numeric: true, cell: (r) => (r.ranked ? `${r.lowShare}%` : <span className="text-ink-500" title={`Needs ${t.minOrdersForRanking} rated orders`}>too few</span>) },
                ]} />
              </Card>
              <div className="space-y-4">
                <Card title="By time of day" bodyClassName="p-0">
                  <TrendTable label="Feedback by day part" rows={t.byDayPart} rowKey={(r) => r.key} columns={[
                    { key: "n", header: "Part of day", cell: (r) => r.label }, { key: "a", header: "Answers", numeric: true, cell: (r) => r.answers },
                    { key: "avg", header: "Average", numeric: true, cell: (r) => (r.average ?? "—") }, { key: "l", header: "Unhappy", numeric: true, cell: (r) => r.low },
                  ]} />
                </Card>
                <Card title="By server" bodyClassName="p-0">
                  <TrendTable label="Feedback by staff member" rows={t.byStaff} rowKey={(r) => r.userId} columns={[
                    { key: "n", header: "Taken by", cell: (r) => r.name }, { key: "a", header: "Answers", numeric: true, cell: (r) => r.answers },
                    { key: "avg", header: "Average", numeric: true, cell: (r) => (r.average ?? "—") }, { key: "l", header: "Unhappy", numeric: true, cell: (r) => r.low },
                  ]} />
                </Card>
              </div>
            </div>
          ) : t ? <p className="text-sm text-ink-500">No answers in this period at {outlet?.name ?? "this outlet"} yet. Turn on “Ask guests how it was” in Growth settings.</p> : null}
        </>
      )}
    </>
  );
}

export function FeedbackScreen() {
  const { can } = useShell();
  const [tab, setTab] = useState<"inbox" | "trends">("inbox");
  const [recording, setRecording] = useState(false);
  const [version, setVersion] = useState(0);
  return (
    <>
      <PageHeader title="Guest feedback" subtitle="What guests say, who followed up, and what keeps going wrong"
        actions={can("customer.manage") && <Button variant="primary" onClick={() => setRecording(true)}><Icon name="plus" /> Record feedback</Button>} />
      <Tabs label="Feedback views" value={tab} onChange={setTab} options={[{ value: "inbox", label: "Inbox" }, { value: "trends", label: "Trends", hidden: !can("growth.view") }]} />
      {tab === "inbox" ? <Inbox key={version} /> : <TrendsView />}
      {recording && <RecordDialog onClose={() => setRecording(false)} onDone={() => setVersion((v) => v + 1)} />}
    </>
  );
}
