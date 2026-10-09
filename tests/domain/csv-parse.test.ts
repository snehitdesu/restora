/** The CSV reader behind the bulk imports (audit MD-21): what spreadsheets really export, and the limits that keep a pasted file harmless. */
import { describe, it, expect } from "vitest";
import { parseCSV, toCSV, csvKey, CsvParseError, CSV_LIMITS } from "@/domain/csv";

describe("parseCSV", () => {
  it("reads a plain file: headers become lookup keys, rows carry their line numbers", () => {
    const r = parseCSV("Name,Reorder level,SKU\nRice,10,RM-1\nDal,5,RM-2\n");
    expect(r.headers).toEqual(["Name", "Reorder level", "SKU"]);
    expect(r.keys).toEqual(["name", "reorderlevel", "sku"]);
    expect(r.rows).toEqual([{ line: 2, cells: { name: "Rice", reorderlevel: "10", sku: "RM-1" } }, { line: 3, cells: { name: "Dal", reorderlevel: "5", sku: "RM-2" } }]);
    expect(r.delimiter).toBe(",");
  });

  it("handles a BOM, CRLF, quoted cells with commas, doubled quotes and line breaks, and skips blank lines", () => {
    const text = '﻿Name,Notes\r\n"Salt, fine","He said ""use less"""\r\n\r\n"Two\nlines",x\r\n';
    const r = parseCSV(text);
    expect(r.rows.map((x) => x.cells)).toEqual([{ name: "Salt, fine", notes: 'He said "use less"' }, { name: "Two\nlines", notes: "x" }]);
    expect(r.rows[1].line).toBe(4); // the line the row starts on, counting the line break inside the first quoted cell... and the blank line
  });

  it("detects semicolons (European Excel) and tabs (pasted from a sheet)", () => {
    expect(parseCSV("Name;Qty\nRice;5\n").delimiter).toBe(";");
    expect(parseCSV("Name;Qty\nRice;5\n").rows[0].cells).toEqual({ name: "Rice", qty: "5" });
    const tab = parseCSV("Name\tQty\nRice\t5\n");
    expect(tab.delimiter).toBe("\t");
    expect(tab.rows[0].cells.qty).toBe("5");
  });

  it("pads short rows, trims cells, and refuses rows with extra data", () => {
    expect(parseCSV("A,B,C\n x ,y\n").rows[0].cells).toEqual({ a: "x", b: "y", c: "" });
    expect(parseCSV("A,B\n1,2,\n").rows[0].cells).toEqual({ a: "1", b: "2" }); // a trailing empty cell is harmless
    expect(() => parseCSV("A,B\n1,2,3\n")).toThrow(/3 cells but only 2 columns/);
  });

  it("restores a cell our own export guarded against spreadsheet formulas", () => {
    const out = toCSV([{ n: "=SUM(A1)" }, { n: "-5" }], [{ header: "Name", value: (r) => r.n }]);
    expect(out).toContain("'=SUM(A1)");
    expect(parseCSV(out).rows.map((r) => r.cells.name)).toEqual(["=SUM(A1)", "-5"]);
    expect(parseCSV("A\n'quoted\n").rows[0].cells.a).toBe("'quoted"); // an ordinary apostrophe stays
  });

  it("round-trips what the exporter writes", () => {
    const rows = [{ name: 'A "quoted", name', qty: 2.5 }, { name: "Plain", qty: 1 }];
    const parsed = parseCSV(toCSV(rows, [{ header: "Name", value: (r) => r.name }, { header: "Qty", value: (r) => r.qty }], { bom: true }));
    expect(parsed.rows.map((r) => r.cells)).toEqual([{ name: 'A "quoted", name', qty: "2.5" }, { name: "Plain", qty: "1" }]);
  });

  it("refuses an empty file, an empty or repeated header, an unclosed quote", () => {
    expect(() => parseCSV("")).toThrow(/empty/);
    expect(() => parseCSV("\n\n")).toThrow(/empty/);
    expect(() => parseCSV("A,,C\n1,2,3\n")).toThrow(/header cell is empty/);
    expect(() => parseCSV("Name,name\n1,2\n")).toThrow(/appears twice/);
    expect(() => parseCSV('A,B\n"open,1\n')).toThrow(/never closed/);
    expect(() => parseCSV("A\n1\n")).not.toThrow();
  });

  it("is bounded: size, rows, columns and cell length", () => {
    expect(() => parseCSV("A\n" + "x".repeat(CSV_LIMITS.maxBytes + 1))).toThrow(/larger than/);
    expect(() => parseCSV("A\n" + "1\n".repeat(CSV_LIMITS.maxRows + 1))).toThrow(/More than 5000 rows/);
    expect(() => parseCSV(Array.from({ length: CSV_LIMITS.maxColumns + 1 }, (_, i) => `c${i}`).join(",") + "\n")).toThrow(/columns/);
    expect(() => parseCSV(`A\n${"x".repeat(CSV_LIMITS.maxCell + 1)}\n`)).toThrow(/longer than 500/);
    expect(parseCSV("A\n" + "1\n".repeat(CSV_LIMITS.maxRows)).rows).toHaveLength(CSV_LIMITS.maxRows);
  });

  it("errors carry the line number and a type the caller can recognise", () => {
    try { parseCSV("A,B\n1,2\n1,2,3\n"); throw new Error("did not throw"); } catch (e) {
      expect(e).toBeInstanceOf(CsvParseError);
      expect((e as CsvParseError).line).toBe(3);
      expect((e as Error).message).toMatch(/^Line 3:/);
    }
    expect(csvKey(" Reorder_Level-% ")).toBe("reorderlevel");
  });
});
