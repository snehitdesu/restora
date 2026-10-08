"use client";

/**
 * Accounting mapping and direct sync (Tally gateway, Zoho Books) and Google
 * Sheets sync, on the integrations screen (group 5). The browser sends what the
 * person chose and shows what the server did, row by row; mapping, idempotency,
 * retries and conflicts are all decided on the server.
 */
import { useState } from "react";
import { api } from "@/lib/api/client";
import { useQuery } from "@/lib/hooks/useApi";
import { useShell } from "@/lib/shellContext";
import { formatDateTime, humanize, isoDay } from "@/lib/format";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { Card } from "@/components/ui/Page";
import { DataTable } from "@/components/ui/Table";
import { ActionButton } from "@/components/ui/Confirm";
import { Checkbox, Field, FormAlert, Input, Select, formError } from "@/components/ui/Form";
import { ErrorState, LoadingState } from "@/components/ui/States";
import { useToast } from "@/components/ui/Toast";

type Conn = { id: string; kind: string; provider: string; status: string; mode: string; configured: boolean };
type Mapping = { ledgers: Record<string, string>; parties: Record<string, string>; updatedAt: string | null; standardLedgers: string[] };
type Row = { from: string; to: string };

const toRows = (map: Record<string, string>, base: string[] = []): Row[] => {
  const rows = base.map((from) => ({ from, to: map[from] ?? "" }));
  for (const [from, to] of Object.entries(map)) if (!base.includes(from)) rows.push({ from, to });
  return rows;
};
const fromRows = (rows: Row[]) => Object.fromEntries(rows.filter((r) => r.from.trim() && r.to.trim() && r.from.trim() !== r.to.trim()).map((r) => [r.from.trim(), r.to.trim()]));

function MapEditor({ title, hint, rows, setRows, fixed }: { title: string; hint: string; rows: Row[]; setRows: (r: Row[]) => void; fixed: number }) {
  const set = (i: number, patch: Partial<Row>) => setRows(rows.map((r, ix) => (ix === i ? { ...r, ...patch } : r)));
  return (
    <fieldset className="rounded-md border border-ink-200 p-3">
      <legend className="px-1 text-sm font-semibold">{title}</legend>
      <p className="mb-2 text-xs text-ink-500">{hint}</p>
      <div className="space-y-2">
        {rows.map((r, i) => (
          <div key={i} className="grid grid-cols-[1fr_1fr_auto] items-center gap-2">
            {i < fixed ? <span className="text-sm">{r.from}</span> : <Input aria-label={`${title} name in RESTORA ${i + 1}`} value={r.from} onChange={(e) => set(i, { from: e.target.value })} placeholder="Name in RESTORA" maxLength={120} />}
            <Input aria-label={`${title}: ${r.from || "new"} in your books`} value={r.to} onChange={(e) => set(i, { to: e.target.value })} placeholder="Name in your books (empty = same)" maxLength={120} />
            {i >= fixed ? <Button size="sm" aria-label="Remove row" onClick={() => setRows(rows.filter((_, ix) => ix !== i))}><Icon name="x" /></Button> : <span />}
          </div>
        ))}
      </div>
      <Button size="sm" className="mt-2" onClick={() => setRows([...rows, { from: "", to: "" }])}><Icon name="plus" /> Add a name</Button>
    </fieldset>
  );
}

export function AccountingMappingCard() {
  const toast = useToast();
  const q = useQuery<Mapping>("/api/integrations/accounting/mapping");
  const [ledgers, setLedgers] = useState<Row[] | null>(null);
  const [parties, setParties] = useState<Row[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  if (q.error) return <Card title="Names in your books"><ErrorState error={q.error} onRetry={q.reload} compact /></Card>;
  if (!q.data) return <Card title="Names in your books"><LoadingState /></Card>;
  const l = ledgers ?? toRows(q.data.ledgers, q.data.standardLedgers);
  const p = parties ?? toRows(q.data.parties);
  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api("/api/integrations/accounting/mapping", { method: "POST", body: { ledgers: fromRows(l), parties: fromRows(p) } });
      toast.show("Mapping saved: every later export and sync uses these names", "ok");
      setLedgers(null);
      setParties(null);
      q.reload();
    } catch (e) {
      setErr(formError(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card title="Names in your books" actions={<Button variant="primary" size="sm" loading={busy} onClick={save}>Save mapping</Button>}>
      <p className="mb-3 text-sm text-ink-600">Rename RESTORA&apos;s ledgers and parties to the names your accountant uses. Amounts, dates, numbers and the duplicate protection never change. For Zoho Books sync, map each ledger to its Zoho account id (digits). Saving asks for your password.</p>
      <div className="grid gap-3 lg:grid-cols-2">
        <MapEditor title="Ledgers" hint="RESTORA ledger → the account in your books" rows={l} setRows={setLedgers} fixed={q.data.standardLedgers.length} />
        <MapEditor title="Parties" hint="Vendor or customer name in RESTORA → the party in your books" rows={p} setRows={setParties} fixed={0} />
      </div>
      <FormAlert message={err} />
      {q.data.updatedAt && <p className="mt-2 text-xs text-ink-500">Last saved {formatDateTime(q.data.updatedAt)}</p>}
    </Card>
  );
}

type SyncResult = { provider: string; mode: string; vouchers: number; alreadySynced: number; queued: number; delivered: number; failed: number };
type SyncRow = { id: string; provider: string; mode: string; status: string; state: string; attempts: number; maxAttempts: number; lastError: string | null; providerRef: string | null; sourceType: string | null; sourceId: string | null; createdAt: string; sentAt: string | null };
const STATE_TONE: Record<string, "ok" | "bad" | "warn" | "neutral"> = { SUCCESS: "ok", PENDING: "neutral", RUNNING: "warn", RETRYING: "warn", TIMEOUT_RETRYING: "warn", FAILED: "bad", TIMEOUT: "bad", EXHAUSTED: "bad", UNAUTHORIZED: "bad", SKIPPED: "neutral" };

export function AccountingSyncCard({ connections }: { connections: Conn[] }) {
  const { outletId, outlet, outlets } = useShell();
  const sync = connections.filter((c) => c.kind === "ACCOUNTING" && ["tally_gateway", "zoho_books"].includes(c.provider));
  const today = isoDay(new Date(), outlet?.timezone);
  const [connectionId, setConnectionId] = useState(sync[0]?.id ?? "");
  const [scope, setScope] = useState<"outlet" | "all">("outlet");
  const [from, setFrom] = useState(today.slice(0, 8) + "01");
  const [to, setTo] = useState(today);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<SyncResult | null>(null);
  const rows = useQuery<SyncRow[]>(sync.length ? "/api/integrations/accounting/sync" : null, { take: 50 });
  const run = async () => {
    setBusy(true);
    setErr(null);
    try {
      setResult(await api<SyncResult>("/api/integrations/accounting/sync", { method: "POST", body: { connectionId, outletId: scope === "outlet" ? outletId ?? undefined : undefined, from: `${from}T00:00:00.000Z`, to: `${to}T23:59:59.999Z` } }));
      rows.reload();
    } catch (e) {
      setErr(formError(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card title="Send to Tally or Zoho Books">
      {!sync.length ? <p className="text-sm text-ink-600">Connect a <strong>Tally gateway</strong> or a <strong>Zoho Books</strong> account on the Connections tab to send vouchers directly. File export above keeps working without it.</p> : (
        <div className="space-y-4">
          <p className="text-sm text-ink-600">Each voucher is sent once as its own request under a fixed key, so syncing the same period again sends only what is new. A failed voucher is retried on its own schedule; a Tally voucher whose outcome is unknown waits for you to check the books. Nothing here has been verified against a live Tally company or Zoho organisation.</p>
          <div className="grid gap-3 sm:grid-cols-5">
            <Field label="Connection" name="sync-connection"><Select value={connectionId} onChange={(e) => setConnectionId(e.target.value)}>{sync.map((c) => <option key={c.id} value={c.id}>{humanize(c.provider)} ({c.mode})</option>)}</Select></Field>
            <Field label="Outlets" name="sync-scope"><Select value={scope} onChange={(e) => setScope(e.target.value as "outlet" | "all")}><option value="outlet">{outlet?.name ?? "This outlet"}</option>{outlets.length > 1 && <option value="all">All my outlets</option>}</Select></Field>
            <Field label="From" name="sync-from"><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
            <Field label="To" name="sync-to"><Input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
            <div className="flex items-end"><Button variant="primary" loading={busy} disabled={!connectionId || !from || !to || from > to} onClick={run}><Icon name="send" /> Sync</Button></div>
          </div>
          <FormAlert message={err} />
          {result && <p className="text-sm" data-testid="sync-result">{result.vouchers} vouchers in the period · {result.alreadySynced} already synced · {result.delivered} delivered · {result.failed} failed <ModeNote mode={result.mode} /></p>}
          <DataTable label="Accounting sync outbox" rows={rows.data ?? []} rowKey={(r) => r.id} loading={rows.loading} error={rows.error} onRetry={rows.reload} empty="Nothing has been synced yet"
            columns={[
              { key: "c", header: "Queued", cell: (r) => formatDateTime(r.createdAt) },
              { key: "v", header: "Voucher", cell: (r) => <span>{humanize(r.sourceType)}<span className="block text-xs text-ink-500">{r.sourceId}</span></span> },
              { key: "p", header: "Provider", cell: (r) => humanize(r.provider) },
              { key: "s", header: "State", cell: (r) => <Badge tone={STATE_TONE[r.state] ?? "neutral"}>{humanize(r.state)}</Badge> },
              { key: "a", header: "Attempts", numeric: true, cell: (r) => `${r.attempts}/${r.maxAttempts}` },
              { key: "e", header: "Detail", cell: (r) => <span className="text-xs text-bad-600">{r.lastError ?? ""}</span> },
              { key: "r", header: "", cell: (r) => (r.status === "FAILED" ? <ActionButton size="sm" action={() => api(`/api/integrations/accounting/sync/${r.id}/retry`, { method: "POST", body: {} })} success="Retried" onDone={rows.reload}>Retry</ActionButton> : null) },
            ]} />
        </div>
      )}
    </Card>
  );
}

function ModeNote({ mode }: { mode: string }) {
  return <Badge tone={mode === "LIVE" ? "ok" : mode === "SANDBOX" ? "warn" : "neutral"}>{mode}</Badge>;
}

// ---------------------------------------------------------------- sheets

type DatasetResult = { dataset: string; tab: string; written: boolean; rows: number; pulled: number; pushed: number; unchanged: number; conflicts: number; invalid: Array<{ key: string; reason: string }>; unknownKeys: string[]; duplicateKeys: string[]; stoppedBecauseSheetChanged?: boolean; error?: string };
type Conflict = { id: string; key: string; name: string | null; status: string; detectedAt: string; restora: { reorderLevel: string; minStock: string; parLevel: string | null }; sheet: { reorderLevel: string; minStock: string; parLevel: string | null } };
const DATASET_LABEL: Record<string, string> = { MATERIALS: "Materials (two-way: reorder level, minimum stock, PAR level)", STOCK: "Stock on hand (push only)", VENDOR_DUES: "Vendor dues (push only)", DAILY_SALES: "Daily sales, last 31 days (push only)" };
const tuple = (t: Conflict["restora"]) => `reorder ${t.reorderLevel} · minimum ${t.minStock} · PAR ${t.parLevel ?? "—"}`;

export function SheetsPanel({ connections }: { connections: Conn[] }) {
  const { outletId, outlet } = useShell();
  const toast = useToast();
  const sheets = connections.filter((c) => c.kind === "SHEETS");
  const [connectionId, setConnectionId] = useState(sheets[0]?.id ?? "");
  const [datasets, setDatasets] = useState<Record<string, boolean>>({ MATERIALS: true, STOCK: false, VENDOR_DUES: false, DAILY_SALES: false });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [results, setResults] = useState<DatasetResult[] | null>(null);
  const conflicts = useQuery<{ conflicts: Conflict[] }>(sheets.length ? "/api/integrations/sheets/conflicts" : null, { status: "OPEN" });
  const chosen = Object.keys(datasets).filter((d) => datasets[d]);
  const run = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await api<{ results: DatasetResult[] }>("/api/integrations/sheets/sync", { method: "POST", body: { connectionId, datasets: chosen, outletId: chosen.some((d) => d === "STOCK" || d === "DAILY_SALES") ? outletId ?? undefined : undefined } });
      setResults(r.results);
      conflicts.reload();
    } catch (e) {
      setErr(formError(e));
    } finally {
      setBusy(false);
    }
  };
  if (!sheets.length) return <Card title="Google Sheets"><p className="text-sm text-ink-600">Connect a spreadsheet on the Connections tab (type <strong>Sheets</strong>) to keep your team&apos;s sheet and RESTORA in step. Share the sheet with the service account first.</p></Card>;
  return (
    <div className="space-y-4">
      <Card title="Sync a spreadsheet" actions={<Button variant="primary" size="sm" loading={busy} disabled={!connectionId || !chosen.length} onClick={run}><Icon name="refresh" /> Sync now</Button>}>
        <p className="mb-3 text-sm text-ink-600">Materials sync both ways: the team edits the reorder level, minimum stock and PAR level in the sheet, RESTORA edits flow back, and when both changed the same row differently it becomes a conflict for you to settle (neither side is overwritten). Edits are checked like any edit in RESTORA. Name, unit and SKU belong to RESTORA. The other sheets are read-only snapshots.</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Spreadsheet" name="sheet-connection"><Select value={connectionId} onChange={(e) => setConnectionId(e.target.value)}>{sheets.map((c) => <option key={c.id} value={c.id}>{humanize(c.provider)} ({c.mode})</option>)}</Select></Field>
          <fieldset><legend className="mb-1 text-sm font-medium">What to sync</legend>{Object.keys(DATASET_LABEL).map((d) => <Checkbox key={d} label={DATASET_LABEL[d]} checked={datasets[d]} onChange={(v) => setDatasets((x) => ({ ...x, [d]: v }))} />)}{(datasets.STOCK || datasets.DAILY_SALES) && <p className="mt-1 text-xs text-ink-500">Stock and sales are taken from {outlet?.name ?? "the selected outlet"}.</p>}</fieldset>
        </div>
        <FormAlert message={err} />
      </Card>
      {results && (
        <DataTable label="Sync result" rows={results} rowKey={(r) => r.dataset} empty="Nothing synced"
          columns={[
            { key: "d", header: "Sheet", cell: (r) => <span>{humanize(r.dataset)}<span className="block text-xs text-ink-500">{r.tab}</span></span> },
            { key: "w", header: "Written", cell: (r) => (r.error ? <Badge tone="bad">Not written</Badge> : r.stoppedBecauseSheetChanged ? <Badge tone="warn">Sheet changed: run again</Badge> : r.written ? <Badge tone="ok">Yes</Badge> : <Badge>No</Badge>) },
            { key: "p", header: "Pulled / pushed / same", numeric: true, cell: (r) => `${r.pulled} / ${r.pushed} / ${r.unchanged}` },
            { key: "c", header: "Conflicts", numeric: true, cell: (r) => r.conflicts },
            { key: "x", header: "Needs attention", cell: (r) => <span className="text-xs text-bad-600">{r.error ?? [...r.invalid.slice(0, 3).map((i) => `${i.key}: ${i.reason}`), r.duplicateKeys.length ? `${r.duplicateKeys.length} repeated SKU(s) skipped` : "", r.unknownKeys.length ? `${r.unknownKeys.length} unknown SKU(s) left alone` : ""].filter(Boolean).join(" · ")}</span> },
          ]} />
      )}
      <Card title="Conflicts to settle">
        {conflicts.error ? <ErrorState error={conflicts.error} onRetry={conflicts.reload} compact /> : !conflicts.data ? <LoadingState /> : (
          <DataTable label="Sheet conflicts" rows={conflicts.data.conflicts} rowKey={(c) => c.id} empty="No open conflicts"
            columns={[
              { key: "m", header: "Material", cell: (c) => <span>{c.name ?? c.key}<span className="block text-xs text-ink-500">{c.key}</span></span> },
              { key: "r", header: "In RESTORA", cell: (c) => <span className="text-xs">{tuple(c.restora)}</span> },
              { key: "s", header: "In the sheet", cell: (c) => <span className="text-xs">{tuple(c.sheet)}</span> },
              { key: "a", header: "", cell: (c) => (
                <span className="flex justify-end gap-1">
                  <ActionButton size="sm" action={() => api(`/api/integrations/sheets/conflicts/${c.id}/resolve`, { method: "POST", body: { choice: "RESTORA" } })} success="Kept RESTORA's values; the next sync updates the sheet" onDone={conflicts.reload}>Keep RESTORA</ActionButton>
                  <ActionButton size="sm" action={() => api(`/api/integrations/sheets/conflicts/${c.id}/resolve`, { method: "POST", body: { choice: "SHEET" } })} success="Applied the sheet's values" onDone={() => { conflicts.reload(); toast.show("Material updated from the sheet", "ok"); }}>Use the sheet</ActionButton>
                </span>
              ) },
            ]} />
        )}
      </Card>
    </div>
  );
}
