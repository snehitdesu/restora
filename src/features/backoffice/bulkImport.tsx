"use client";

/**
 * Import materials or vendors from a spreadsheet (audit MD-21). Save the sheet as CSV, drop it here (or paste it), check it,
 * read what each line would do, then import. Checking writes nothing; importing is all-or-nothing, so a file with a bad line
 * creates nothing until that line is fixed. A row that already exists is skipped, so the same file can be sent twice safely.
 */
import { useId, useState } from "react";
import { api, describeError } from "@/lib/api/client";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Badge } from "@/components/ui/Badge";
import { FormAlert, Textarea } from "@/components/ui/Form";

type Kind = "materials" | "vendors";
type Report = {
  kind: Kind;
  committed: boolean;
  counts: { create: number; skip: number; error: number };
  rows: Array<{ line: number; label: string; action: "CREATE" | "SKIP" | "ERROR"; message?: string }>;
  newCategories: string[];
  columns: { used: string[]; ignored: string[] };
  note: string | null;
};

const TEMPLATES: Record<Kind, { header: string; example: string; columns: string }> = {
  materials: {
    header: "Name,SKU,Brand,Category,Unit,Purchase unit,Tax %,Min stock,Reorder level,Par level,Perishable,Track batch,Preferred vendor",
    example: "Basmati Rice,RICE-01,India Gate,Grains,kg,kg,5,10,20,60,no,no,",
    columns: "Name and Unit are required. Unit is the code of one of your units (for example kg). Everything else is optional; a new Category is created for you.",
  },
  vendors: {
    header: "Name,Company name,Phone,Email,Address,GSTIN,Payment terms,Credit limit,Category,Nature of supply,Notes",
    example: "Fresh Farms,Fresh Farms Pvt Ltd,9876543210,orders@freshfarms.example,\"12 Market Road, Pune\",,Net 15,50000,Produce,Goods,",
    columns: "Only Name is required. New vendors start as pending: an approver must activate them before anyone can buy from them.",
  },
};
const TONE = { CREATE: "ok", SKIP: "neutral", ERROR: "bad" } as const;
const WORD = { CREATE: "Create", SKIP: "Skip", ERROR: "Error" } as const;

export function ImportDialog({ kind, onClose, onDone }: { kind: Kind; onClose: () => void; onDone: () => void }) {
  const t = TEMPLATES[kind];
  const noun = kind === "materials" ? "materials" : "vendors";
  const fileId = useId();
  const textId = useId();
  const [csv, setCsv] = useState("");
  const [report, setReport] = useState<Report | null>(null);
  const [busy, setBusy] = useState<null | "check" | "import">(null);
  const [error, setError] = useState<string | null>(null);

  const edit = (text: string) => {
    setCsv(text);
    setReport(null);
    setError(null);
  };
  const send = async (commit: boolean) => {
    setBusy(commit ? "import" : "check");
    setError(null);
    try {
      const r = await api<Report>(`/api/master/import/${kind}`, { method: "POST", body: { csv, commit } });
      setReport(r);
      if (r.committed) onDone();
    } catch (e) {
      setReport(null);
      setError(describeError(e));
    } finally {
      setBusy(null);
    }
  };
  const readFile = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > 900_000) return setError("That file is too large. Split it into parts of a few hundred lines.");
    edit(await file.text());
  };
  const template = () => {
    const url = URL.createObjectURL(new Blob([`${t.header}\n${t.example}\n`], { type: "text/csv" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `${kind}-template.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const c = report?.counts;
  const done = report?.committed === true;
  const canImport = Boolean(report && !done && c && c.error === 0 && c.create > 0);
  return (
    <Dialog open onClose={onClose} size="lg" title={`Import ${noun}`} description={t.columns}
      footer={
        <>
          <Button onClick={onClose} disabled={busy !== null}>{done ? "Close" : "Cancel"}</Button>
          {!done && <Button onClick={() => send(false)} loading={busy === "check"} disabled={!csv.trim() || busy !== null}>Check file</Button>}
          {!done && <Button variant="primary" onClick={() => send(true)} loading={busy === "import"} disabled={!canImport || busy !== null}>{canImport && c ? `Import ${c.create} ${c.create === 1 ? "row" : "rows"}` : "Import"}</Button>}
        </>
      }>
      <div className="flex flex-col gap-3">
        <FormAlert message={error} />
        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor={fileId} className="text-sm font-medium text-ink-700">CSV file</label>
          <input id={fileId} type="file" accept=".csv,text/csv,text/plain" onChange={(e) => { void readFile(e.target.files?.[0]); e.target.value = ""; }} className="text-sm" />
          <Button size="sm" onClick={template}>Download template</Button>
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor={textId} className="text-sm font-medium text-ink-700">Or paste the rows, first line is the column names</label>
          <Textarea id={textId} rows={6} value={csv} onChange={(e) => edit(e.target.value)} spellCheck={false} placeholder={`${t.header}\n${t.example}`} className="font-mono text-xs" />
        </div>

        {report && c && (
          <div className="flex flex-col gap-2" aria-live="polite">
            <p className="text-sm text-ink-800" data-testid="import-summary">
              {done ? "Imported" : "Checked"}: <strong>{c.create}</strong> to create, <strong>{c.skip}</strong> already there, <strong>{c.error}</strong> with errors.
              {report.newCategories.length > 0 && <> New categories: {report.newCategories.join(", ")}.</>}
            </p>
            {report.columns.ignored.length > 0 && <p className="text-xs text-ink-600">Columns not used: {report.columns.ignored.join(", ")}.</p>}
            {report.note && <p className={`text-sm ${c.error ? "text-bad-700" : "text-ink-700"}`}>{report.note}</p>}
            <div className="max-h-64 overflow-auto rounded-md border border-ink-200">
              <table className="w-full text-left text-sm">
                <caption className="sr-only">What each line of the file would do</caption>
                <thead className="sticky top-0 bg-ink-50 text-xs text-ink-600">
                  <tr><th scope="col" className="px-2 py-1">Line</th><th scope="col" className="px-2 py-1">{kind === "materials" ? "Material" : "Vendor"}</th><th scope="col" className="px-2 py-1">Result</th><th scope="col" className="px-2 py-1">Detail</th></tr>
                </thead>
                <tbody>
                  {report.rows.map((r) => (
                    <tr key={r.line} className="border-t border-ink-100">
                      <td className="px-2 py-1 tabular-nums text-ink-600">{r.line}</td>
                      <td className="px-2 py-1">{r.label || "—"}</td>
                      <td className="px-2 py-1"><Badge tone={TONE[r.action]}>{WORD[r.action]}</Badge></td>
                      <td className="px-2 py-1 text-ink-700">{r.message ?? ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </Dialog>
  );
}
