// Count the rows of docs/master-feature-audit.md by status and (with --write) refresh the "Totals" table.
// Usage: node scripts/audit-totals.mjs [--write]      (exits 1 if a row has an unknown status or the table is stale)
import { readFileSync, writeFileSync } from "node:fs";

const FILE = "docs/master-feature-audit.md";
const ORDER = ["IMPLEMENTED + VERIFIED", "IMPLEMENTED + NOT EXTERNALLY VERIFIED", "PARTIAL", "NOT BUILT", "INTENTIONALLY DEFERRED"];

// A Windows checkout (core.autocrlf) has CRLF line ends: count on LF, write back what was there.
const raw = readFileSync(FILE, "utf8");
const eol = raw.includes("\r\n") ? "\r\n" : "\n";
const text = raw.replace(/\r\n/g, "\n");
const counts = Object.fromEntries(ORDER.map((s) => [s, 0]));
const ids = new Set();
for (const line of text.split("\n")) {
  if (!/^\| [A-Z]{2}-\d+ \|/.test(line)) continue;
  const cells = line.replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
  if (ids.has(cells[0])) throw new Error(`duplicate row id ${cells[0]}`);
  ids.add(cells[0]);
  if (!(cells[3] in counts)) throw new Error(`${cells[0]}: unknown status "${cells[3]}"`);
  counts[cells[3]]++;
}
const total = ids.size;
const table = ["| Status | Rows |", "|---|---|", ...ORDER.map((s) => `| ${s} | ${counts[s]} |`), `| **Total** | **${total}** |`].join("\n");
const re = /\| Status \| Rows \|\n\|---\|---\|\n(?:\|.*\n)+?\| \*\*Total\*\* \| \*\*\d+\*\* \|/;
if (!re.test(text)) throw new Error("Totals table not found");
const next = text.replace(re, table);
if (process.argv.includes("--write")) {
  writeFileSync(FILE, next.replace(/\n/g, eol));
  console.log(table);
} else if (next !== text) {
  console.error(`The Totals table is stale. Counted:\n${table}`);
  process.exit(1);
} else console.log(table);
