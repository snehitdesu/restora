/** Minimal, safe CSV serialization (RFC 4180). No external deps. */
export type CsvColumn<T> = { header: string; value: (row: T) => unknown };

const NUMERIC = /^-?\d+(\.\d+)?$/;

function escapeCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  let s: string;
  if (v instanceof Date) s = v.toISOString();
  else if (typeof v === "number" || typeof v === "bigint") return String(v); // numbers are never formulas
  else if (typeof v === "boolean") s = v ? "true" : "false";
  else if (typeof v === "object" && typeof (v as { toFixed?: unknown }).toFixed === "function") s = String(v); // Prisma.Decimal
  else s = typeof v === "object" ? JSON.stringify(v) : String(v);
  // Guard against CSV/formula injection in spreadsheet apps (plain numbers are left alone).
  if (/^[=+\-@\t\r]/.test(s) && !NUMERIC.test(s)) s = `'${s}`;
  if (/[",\n\r]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

/** Header row + one CRLF-terminated line per row; column order is exactly `columns`. */
export function toCSV<T>(rows: T[], columns: CsvColumn<T>[], opts: { bom?: boolean } = {}): string {
  const lines = [columns.map((c) => escapeCell(c.header)).join(",")];
  for (const r of rows) lines.push(columns.map((c) => escapeCell(c.value(r))).join(","));
  return (opts.bom ? "﻿" : "") + lines.join("\r\n") + "\r\n";
}

// ---------------------------------------------------------------- parsing (bulk import, audit MD-21)

export class CsvParseError extends Error {
  constructor(message: string, readonly line?: number) {
    super(line ? `Line ${line}: ${message}` : message);
    this.name = "CsvParseError";
  }
}

export type ParsedCsv = {
  /** The header cells as typed (trimmed). */
  headers: string[];
  /** The same headers as lookup keys: lower case, letters and digits only ("Reorder level" -> "reorderlevel"). */
  keys: string[];
  /** One object per data row, keyed by `keys`; `line` is the 1-based line of the row in the file (for error messages). */
  rows: Array<{ line: number; cells: Record<string, string> }>;
  delimiter: "," | ";" | "\t";
};

export const CSV_LIMITS = { maxBytes: 2_000_000, maxRows: 5000, maxColumns: 40, maxCell: 500 } as const;

/** "Reorder level", "reorder_level" and "REORDER-LEVEL" are the same column. */
export const csvKey = (header: string) => header.toLowerCase().replace(/[^a-z0-9]/g, "");

function detectDelimiter(firstLine: string): "," | ";" | "\t" {
  const count = (d: string) => {
    let n = 0, quoted = false;
    for (const ch of firstLine) {
      if (ch === '"') quoted = !quoted;
      else if (!quoted && ch === d) n++;
    }
    return n;
  };
  const [c, s, t] = [count(","), count(";"), count("\t")];
  return t > c && t > s ? "\t" : s > c ? ";" : ",";
}

/**
 * RFC 4180 reader for what people export from Excel or Google Sheets: UTF-8 with or without a BOM, comma / semicolon / tab
 * separated, quoted cells with embedded quotes, commas and line breaks, CRLF or LF. Blank lines are skipped. A cell that our
 * own exports guarded against spreadsheet formulas (`'=SUM`) is restored. Bounded: size, rows, columns and cell length, so
 * a pasted file can never be an attack on the server.
 */
export function parseCSV(input: string): ParsedCsv {
  if (input.length > CSV_LIMITS.maxBytes) throw new CsvParseError(`The file is larger than ${CSV_LIMITS.maxBytes / 1_000_000} MB`);
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const delimiter = detectDelimiter(text.split(/\r?\n/, 1)[0] ?? "");
  const records: Array<{ line: number; cells: string[] }> = [];
  let cells: string[] = [];
  let cell = "";
  let quoted = false;
  let line = 1;
  let recordLine = 1;
  let touched = false; // anything (even an empty quoted cell) seen on this record
  const endCell = () => {
    if (cell.length > CSV_LIMITS.maxCell) throw new CsvParseError(`A cell is longer than ${CSV_LIMITS.maxCell} characters`, recordLine);
    cells.push(cell.trim().replace(/^'(?=[=+\-@])/, ""));
    cell = "";
  };
  const endRecord = () => {
    endCell();
    if (touched || cells.some((c) => c !== "")) {
      if (cells.length > CSV_LIMITS.maxColumns) throw new CsvParseError(`More than ${CSV_LIMITS.maxColumns} columns`, recordLine);
      records.push({ line: recordLine, cells });
      if (records.length > CSV_LIMITS.maxRows + 1) throw new CsvParseError(`More than ${CSV_LIMITS.maxRows} rows: import the file in parts`);
    }
    cells = [];
    touched = false;
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
      } else {
        if (ch === "\n") line++;
        cell += ch;
      }
      continue;
    }
    if (ch === '"' && cell === "") { quoted = true; touched = true; continue; }
    if (ch === delimiter) { endCell(); touched = true; continue; }
    if (ch === "\r" && text[i + 1] === "\n") continue;
    if (ch === "\n" || ch === "\r") {
      endRecord();
      line++;
      recordLine = line;
      continue;
    }
    cell += ch;
  }
  if (quoted) throw new CsvParseError("A quoted cell is never closed", recordLine);
  endRecord();
  if (!records.length) throw new CsvParseError("The file is empty");
  const [head, ...body] = records;
  const headers = head.cells.map((h) => h.trim());
  const keys = headers.map(csvKey);
  if (keys.some((k) => !k)) throw new CsvParseError("A header cell is empty", head.line);
  const dup = keys.find((k, i) => keys.indexOf(k) !== i);
  if (dup) throw new CsvParseError(`The column "${headers[keys.indexOf(dup)]}" appears twice`, head.line);
  const rows = body.map((r) => {
    if (r.cells.length > headers.length && r.cells.slice(headers.length).some((c) => c !== "")) throw new CsvParseError(`${r.cells.length} cells but only ${headers.length} columns`, r.line);
    return { line: r.line, cells: Object.fromEntries(keys.map((k, i) => [k, r.cells[i] ?? ""])) };
  });
  return { headers, keys, rows, delimiter };
}
