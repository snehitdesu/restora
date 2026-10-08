/**
 * Parse an aggregator payout statement pasted or uploaded as CSV into the
 * lines the import endpoint takes. Strict on purpose: a bad cell is reported
 * with its row and column, never guessed or defaulted, and a statement with
 * any bad row is not sent at all. The server validates again (this only saves
 * a round trip and points at the cell).
 *
 * Header (case-insensitive, any order, extra columns ignored):
 *   order_id, settled_at, gross, commission, penalty, ad_spend, other_deductions, net_paid
 * `penalty`, `ad_spend` and `other_deductions` may be absent (= 0).
 */
export type StatementLineInput = { externalId: string; settledAt: string; grossAmount: number; commission: number; penalty: number; adSpend: number; otherDeductions: number; netPayout: number };

const ALIASES: Record<string, keyof StatementLineInput> = {
  order_id: "externalId", orderid: "externalId", order: "externalId", external_id: "externalId",
  settled_at: "settledAt", settled: "settledAt", date: "settledAt", payout_date: "settledAt",
  gross: "grossAmount", gross_amount: "grossAmount",
  commission: "commission",
  penalty: "penalty", penalties: "penalty",
  ad_spend: "adSpend", adspend: "adSpend", ads: "adSpend",
  other_deductions: "otherDeductions", other: "otherDeductions", deductions: "otherDeductions",
  net_paid: "netPayout", net: "netPayout", net_payout: "netPayout", paid: "netPayout",
};
const REQUIRED: Array<keyof StatementLineInput> = ["externalId", "settledAt", "grossAmount", "commission", "netPayout"];
const NUMBER = /^-?\d{1,9}(\.\d{1,2})?$/;

/** Split one CSV record, honouring double quotes ("" = a quote). */
function splitRecord(line: string): string[] {
  const out: string[] = [];
  let cur = "", quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) { if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else quoted = false; } else cur += c; }
    else if (c === '"') quoted = true;
    else if (c === ",") { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

export function parseStatementCsv(text: string, maxLines = 2000): { lines: StatementLineInput[]; errors: string[] } {
  const rows = text.replace(/^﻿/, "").split(/\r?\n/).filter((r) => r.trim() !== "");
  if (!rows.length) return { lines: [], errors: ["Paste the statement: a header row, then one row per order."] };
  const header = splitRecord(rows[0]).map((h) => ALIASES[h.toLowerCase().replace(/[\s-]+/g, "_")]);
  const missing = REQUIRED.filter((k) => !header.includes(k));
  if (missing.length) return { lines: [], errors: [`The header row lacks: ${missing.join(", ")}. Expected: order_id, settled_at, gross, commission, [penalty, ad_spend, other_deductions,] net_paid.`] };
  if (rows.length - 1 > maxLines) return { lines: [], errors: [`At most ${maxLines} lines per statement (found ${rows.length - 1}).`] };
  const errors: string[] = [];
  const lines: StatementLineInput[] = [];
  rows.slice(1).forEach((r, i) => {
    const cells = splitRecord(r);
    const rec: Record<string, string> = {};
    header.forEach((k, ix) => { if (k) rec[k] = cells[ix] ?? ""; });
    const at = `Row ${i + 2}`;
    const num = (k: keyof StatementLineInput, optional: boolean): number | null => {
      const v = (rec[k] ?? "").replace(/^₹/, "");
      if (v === "" && optional) return 0;
      if (!NUMBER.test(v)) { errors.push(`${at}: ${k} must be a plain amount like 123.45, not "${(rec[k] ?? "").slice(0, 20)}"`); return null; }
      return Number(v);
    };
    const id = rec.externalId ?? "";
    if (!id) errors.push(`${at}: order_id is empty`);
    const d = new Date(rec.settledAt ?? "");
    if (Number.isNaN(d.getTime())) errors.push(`${at}: settled_at must be a date like 2026-10-08, not "${(rec.settledAt ?? "").slice(0, 20)}"`);
    const gross = num("grossAmount", false), commission = num("commission", false), penalty = num("penalty", true), adSpend = num("adSpend", true), other = num("otherDeductions", true), net = num("netPayout", false);
    if (id && !Number.isNaN(d.getTime()) && [gross, commission, penalty, adSpend, other, net].every((x) => x !== null)) {
      lines.push({ externalId: id, settledAt: d.toISOString(), grossAmount: gross!, commission: commission!, penalty: penalty!, adSpend: adSpend!, otherDeductions: other!, netPayout: net! });
    }
  });
  return { lines: errors.length ? [] : lines, errors };
}
