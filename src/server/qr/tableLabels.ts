/**
 * Printable QR labels for Coders' Cafe tables T01–T10.
 *
 * The label encodes only the existing guest URL `/t/<qrToken>`. The token is
 * the one stored on the table; this module never invents one, and it never
 * reads a client-supplied table id, outlet id, or price. The guest server
 * (guestOrdering.resolveTable) is what turns that token into a table.
 *
 * Local mode always marks the sheet "not for customer printing". Production
 * mode refuses any base URL that is not public https, so a localhost code
 * cannot be written as a print-ready label.
 */
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { qrSvgDocument, qrSvgPath } from "@/lib/qrSvg";
import { isGuestTableToken } from "@/server/services/guestOrdering";
import { STARTER_TABLE_CODES } from "@/server/services/starterMenu";

export const CAFE_TABLE_CODES = STARTER_TABLE_CODES;

export type QrIssueMode = "local" | "production";

export class TableQrError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TableQrError";
  }
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0", "::"]);

function bareHost(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
}

function parseIpv4(text: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (!m) return null;
  const oct = m.slice(1).map((part) => Number(part));
  if (oct.some((n) => n > 255)) return null;
  return oct;
}

/** Private, loopback, link-local, CGNAT, and the rest of the non-routable IPv4 space. */
function ipv4NonPublic(oct: number[]): boolean {
  const [a, b] = oct;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a >= 224) return true;
  return false;
}

/**
 * Addresses that are not a global unicast origin.
 * Global unicast is 2000::/3. The seven /3 blocks are its complement, so
 * unspecified, loopback, IPv4-mapped, discard, NAT64, unique-local,
 * link-local, site-local, and multicast all match. The later prefixes are
 * reserved ranges that sit inside 2000::/3.
 */
const NON_GLOBAL_IPV6 = new net.BlockList();
for (const cidr of [
  "0000::/3",
  "4000::/3",
  "6000::/3",
  "8000::/3",
  "a000::/3",
  "c000::/3",
  "e000::/3",
  "2001::/23",
  "2001:db8::/32",
  "2002::/16",
  "3fff::/20",
]) {
  const slash = cidr.lastIndexOf("/");
  NON_GLOBAL_IPV6.addSubnet(cidr.slice(0, slash), Number(cidr.slice(slash + 1)), "ipv6");
}

/** True when `host` is not a global IPv6 unicast address. Malformed values fail closed. */
function ipv6NonPublic(host: string): boolean {
  if (host.includes("%") || net.isIP(host) !== 6) return true;
  return NON_GLOBAL_IPV6.check(host, "ipv6");
}

/** True for loopback, private, documentation, multicast, and every non-global address. Public DNS names return false. */
export function isNonPublicHost(hostname: string): boolean {
  const host = bareHost(hostname);
  if (!host || LOOPBACK.has(host) || host.endsWith(".localhost") || host.endsWith(".local")) return true;
  const v4 = parseIpv4(host);
  if (v4) return ipv4NonPublic(v4);
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return true;
  if (host.includes(":")) return ipv6NonPublic(host);
  return false;
}

/**
 * Why this base URL cannot be used for the requested mode.
 * Production requires a public https origin. Local mode allows this computer.
 */
export function qrBaseUrlProblem(raw: string, mode: QrIssueMode): string | null {
  const v = raw?.trim() ?? "";
  if (!v) return "A base URL is required";
  if (mode !== "local" && mode !== "production") return "QR mode must be local or production";
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return "Base URL must be a valid absolute URL";
  }
  if (u.username || u.password) return "Base URL must not include credentials";
  if (u.search || u.hash) return "Base URL must not include a query or fragment";
  if (u.pathname !== "/" && u.pathname !== "") return "Base URL must be an origin with no path";
  if (mode === "local") {
    if (u.protocol !== "http:" && u.protocol !== "https:") return "Local base URL must use http or https";
    return null;
  }
  if (u.protocol !== "https:") return "Production QR codes require a public https:// URL";
  if (isNonPublicHost(u.hostname)) return "Production QR codes require a public https:// URL; local and private addresses are not print-ready";
  return null;
}

export function normalizeQrOrigin(raw: string): string {
  return new URL(raw.trim()).origin;
}

/** Guest menu URL. The path is the stored token, never a table code or outlet id. */
export function guestOrderingUrl(baseUrl: string, qrToken: string): string {
  if (!isGuestTableToken(qrToken)) throw new TableQrError("Table token is not a valid guest token");
  return `${normalizeQrOrigin(baseUrl)}/t/${encodeURIComponent(qrToken)}`;
}

export type TableQrSource = { code: string; qrToken: string | null };

export type TableQrLabel = { code: string; url: string; svg: string };

export type TableQrManifest = {
  restaurant: string;
  mode: QrIssueMode;
  printReady: boolean;
  baseUrl: string;
  notice: string | null;
  generatedAt: string;
  tables: Array<{ code: string; url: string }>;
};

export type TableQrPack = {
  mode: QrIssueMode;
  printReady: boolean;
  baseUrl: string;
  restaurantName: string;
  notice: string | null;
  labels: TableQrLabel[];
  html: string;
  manifest: TableQrManifest;
};

function localNotice(origin: string): string {
  const host = bareHost(new URL(origin).hostname);
  if (LOOPBACK.has(host)) {
    return "LOCAL TEST — NOT FOR CUSTOMER PRINTING. This address is this computer; a phone cannot open it, and these codes are not ready to print.";
  }
  if (isNonPublicHost(host)) {
    return "LOCAL TEST — NOT FOR CUSTOMER PRINTING. This address is on a private network. These codes are not ready to print for customers.";
  }
  return "LOCAL TEST — NOT FOR CUSTOMER PRINTING. Run production mode with the public https address before printing customer codes.";
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

function renderSheet(pack: { restaurantName: string; notice: string | null; printReady: boolean; labels: TableQrLabel[] }): string {
  const title = pack.printReady ? `${pack.restaurantName} table QR` : `${pack.restaurantName} table QR — not for customer printing`;
  const banner = pack.notice
    ? `<p class="banner" role="note">${esc(pack.notice)}</p>`
    : "";
  const cards = pack.labels.map((label) => {
    return `<section class="card">
      <p class="brand">${esc(pack.restaurantName)}</p>
      <h2>Table ${esc(label.code)}</h2>
      ${label.svg}
      <p class="hint">Scan to order</p>
      <p class="url">${esc(label.url)}</p>
    </section>`;
  }).join("\n");
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<title>${esc(title)}</title>
<style>
  body { font-family: sans-serif; margin: 16px; color: #111; }
  .banner { border: 3px solid #111; padding: 12px; font-weight: 700; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-top: 16px; }
  .card { break-inside: avoid; border: 1px solid #111; padding: 12px; text-align: center; }
  .brand, .hint, .url { margin: 4px 0; }
  h2 { margin: 0 0 8px; font-size: 1.4rem; }
  .url { font-size: 10px; word-break: break-all; }
  .card svg { width: 42mm; height: auto; max-width: 100%; }
  @media print { body { margin: 8mm; } .card { page-break-inside: avoid; } }
</style>
</head>
<body>
  <h1>${esc(title)}</h1>
  ${banner}
  <div class="grid">
    ${cards}
  </div>
</body>
</html>
`;
}

/**
 * Build the T01–T10 label set from stored table rows.
 * Extra fields on a row (outlet, price, table id) are ignored.
 * Throws TableQrError and produces no pack when the URL or the tokens are unsafe.
 */
export function buildTableQrPack(input: {
  mode: QrIssueMode;
  baseUrl: string;
  restaurantName: string;
  tables: ReadonlyArray<TableQrSource>;
  expectedCodes?: readonly string[];
  now?: Date;
}): TableQrPack {
  const problem = qrBaseUrlProblem(input.baseUrl, input.mode);
  if (problem) throw new TableQrError(problem);
  const origin = normalizeQrOrigin(input.baseUrl);
  const expected = input.expectedCodes ?? CAFE_TABLE_CODES;
  const byCode = new Map<string, { code: string; qrToken: string }>();
  for (const row of input.tables) {
    if (!expected.includes(row.code)) continue;
    if (byCode.has(row.code)) throw new TableQrError(`Table ${row.code} appears more than once`);
    if (!isGuestTableToken(row.qrToken)) throw new TableQrError(`Table ${row.code} has no valid QR token`);
    byCode.set(row.code, { code: row.code, qrToken: row.qrToken });
  }
  const missing = expected.filter((code) => !byCode.has(code));
  if (missing.length) throw new TableQrError(`Missing QR token for ${missing.join(", ")}`);
  const owner = new Map<string, string>();
  for (const row of byCode.values()) {
    const prev = owner.get(row.qrToken);
    if (prev) throw new TableQrError(`Tables ${prev} and ${row.code} share one QR token`);
    owner.set(row.qrToken, row.code);
  }
  const labels: TableQrLabel[] = expected.map((code) => {
    const row = byCode.get(code)!;
    const url = guestOrderingUrl(origin, row.qrToken);
    const svg = qrSvgDocument(url, `Table ${code}`);
    if (!svg.includes(qrSvgPath(url).d)) throw new TableQrError(`QR for ${code} does not encode its guest URL`);
    return { code, url, svg };
  });
  const printReady = input.mode === "production";
  const notice = printReady ? null : localNotice(origin);
  const manifest: TableQrManifest = {
    restaurant: input.restaurantName,
    mode: input.mode,
    printReady,
    baseUrl: origin,
    notice,
    generatedAt: (input.now ?? new Date()).toISOString(),
    tables: labels.map(({ code, url }) => ({ code, url })),
  };
  const pack: TableQrPack = {
    mode: input.mode,
    printReady,
    baseUrl: origin,
    restaurantName: input.restaurantName,
    notice,
    labels,
    html: "",
    manifest,
  };
  pack.html = renderSheet(pack);
  return pack;
}

const NOTICE_FILE = "NOT-FOR-CUSTOMER-PRINTING.txt";

export function assertOutputDir(dir: string): string {
  if (typeof dir !== "string" || dir.trim() === "") throw new TableQrError("Output directory is required");
  if (path.isAbsolute(dir)) throw new TableQrError("Output directory must be a relative path inside the project");
  if (dir.split(/[/\\]/).includes("..")) throw new TableQrError("Output directory must stay inside the project");
  return dir;
}

/** Guest path for one stored token: same origin as the pack, no query, fragment, or credentials. */
function sameOriginGuestUrl(url: string, origin: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.origin !== origin || parsed.username || parsed.password || parsed.search || parsed.hash) return false;
  const match = /^\/t\/([^/]+)$/.exec(parsed.pathname);
  if (!match) return false;
  let token: string;
  try {
    token = decodeURIComponent(match[1]);
  } catch {
    return false;
  }
  return isGuestTableToken(token) && encodeURIComponent(token) === match[1];
}

/** Every field that would be written, checked before the directory is created. */
function assertWritablePack(pack: TableQrPack): void {
  if (pack.mode !== "local" && pack.mode !== "production") {
    throw new TableQrError("Refusing to write a label pack with an unknown mode");
  }
  const production = pack.mode === "production";
  if (production) {
    if (pack.printReady !== true || pack.notice !== null) {
      throw new TableQrError("Refusing to write print-ready labels that were not produced in production mode");
    }
  } else if (pack.printReady !== false || typeof pack.notice !== "string" || pack.notice.trim() === "") {
    throw new TableQrError("Refusing to write print-ready labels that were not produced in production mode");
  }
  let origin: string;
  try {
    origin = normalizeQrOrigin(pack.baseUrl);
  } catch {
    throw new TableQrError("Refusing to write a label pack whose base URL is not allowed for its mode");
  }
  if (typeof pack.baseUrl !== "string" || qrBaseUrlProblem(pack.baseUrl, pack.mode) || pack.baseUrl !== origin) {
    throw new TableQrError("Refusing to write a label pack whose base URL is not allowed for its mode");
  }
  if (!Array.isArray(pack.labels) || pack.labels.length === 0) throw new TableQrError("Refusing to write an empty label pack");
  if (typeof pack.html !== "string" || pack.html.trim() === "") throw new TableQrError("Refusing to write a label pack with no sheet");
  if (typeof pack.restaurantName !== "string" || !pack.html.includes(esc(pack.restaurantName))) {
    throw new TableQrError("Refusing to write a label pack whose sheet does not match its labels");
  }
  if (pack.notice !== null && !pack.html.includes(esc(pack.notice))) {
    throw new TableQrError("Refusing to write a label pack whose sheet does not match its labels");
  }
  if (pack.notice === null && pack.html.includes("NOT FOR CUSTOMER PRINTING")) {
    throw new TableQrError("Refusing to write print-ready labels that were not produced in production mode");
  }
  const manifest = pack.manifest;
  if (
    !manifest
    || manifest.mode !== pack.mode
    || manifest.printReady !== pack.printReady
    || manifest.baseUrl !== pack.baseUrl
    || manifest.notice !== pack.notice
    || manifest.restaurant !== pack.restaurantName
    || typeof manifest.generatedAt !== "string"
    || Number.isNaN(Date.parse(manifest.generatedAt))
    || !Array.isArray(manifest.tables)
    || manifest.tables.length !== pack.labels.length
  ) {
    throw new TableQrError("Refusing to write a label pack whose manifest does not match");
  }
  const seenCode = new Set<string>();
  const seenUrl = new Set<string>();
  for (let i = 0; i < pack.labels.length; i++) {
    const label = pack.labels[i];
    const code = label?.code;
    if (typeof code !== "string" || !/^T\d{2}$/.test(code)) {
      throw new TableQrError(`Refusing to write a label file for unexpected table code ${code ?? ""}`);
    }
    if (seenCode.has(code)) throw new TableQrError(`Refusing to write a duplicate label for ${code}`);
    seenCode.add(code);
    if (typeof label.url !== "string" || !sameOriginGuestUrl(label.url, pack.baseUrl)) {
      throw new TableQrError(`Refusing to write a label whose guest URL is not allowed for ${code}`);
    }
    if (seenUrl.has(label.url)) throw new TableQrError(`Refusing to write a duplicate guest URL for ${code}`);
    seenUrl.add(label.url);
    const drawn = qrSvgPath(label.url);
    if (typeof label.svg !== "string" || !label.svg.includes(drawn.d) || label.svg !== qrSvgDocument(label.url, `Table ${code}`)) {
      throw new TableQrError(`Refusing to write a QR that does not encode the guest URL for ${code}`);
    }
    const row = manifest.tables[i];
    if (!row || row.code !== code || row.url !== label.url) throw new TableQrError("Refusing to write a label pack whose manifest does not match");
    if (!pack.html.includes(label.svg) || !pack.html.includes(esc(label.url))) {
      throw new TableQrError("Refusing to write a label pack whose sheet does not match its labels");
    }
  }
}

/** Swap a finished temp directory into place. A failed write never publishes a partial directory. */
function publishDir(tmp: string, abs: string): void {
  if (!fs.existsSync(abs)) {
    fs.renameSync(tmp, abs);
    return;
  }
  const backup = `${tmp}.previous`;
  fs.renameSync(abs, backup);
  try {
    fs.renameSync(tmp, abs);
  } catch (e) {
    try { fs.renameSync(backup, abs); } catch { /* the previous directory remains at the backup path */ }
    throw e;
  }
  fs.rmSync(backup, { recursive: true, force: true });
}

/**
 * Write the sheet, one SVG per table, and the manifest.
 * Validation runs first. Files are written to a temp directory and published
 * only after every file succeeds, so a mid-write failure does not leave a
 * partial sheet that looks complete.
 */
export function writeTableQrFiles(dir: string, pack: TableQrPack): string {
  assertWritablePack(pack);
  const rel = assertOutputDir(dir);
  const abs = path.resolve(process.cwd(), rel);
  const tmp = path.join(path.dirname(abs), `.${path.basename(abs)}.partial-${process.pid}-${Date.now()}`);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.mkdirSync(tmp);
  try {
    if (!pack.printReady) fs.writeFileSync(path.join(tmp, NOTICE_FILE), `${pack.notice}\nDo not place these codes on tables.\n`, "utf8");
    fs.writeFileSync(path.join(tmp, "manifest.json"), `${JSON.stringify(pack.manifest, null, 2)}\n`, "utf8");
    fs.writeFileSync(path.join(tmp, "labels.html"), pack.html, "utf8");
    for (const label of pack.labels) fs.writeFileSync(path.join(tmp, `${label.code}.svg`), label.svg, "utf8");
    publishDir(tmp, abs);
  } catch (e) {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw e;
  }
  return abs;
}

/** Keys parseQrArgs reads. An index signature keeps this assignable from `process.env`. */
export type QrEnvironment = {
  PUBLIC_BASE_URL?: string;
  [key: string]: string | undefined;
};

export type ParsedQrArgs = { help: true } | { help: false; mode: QrIssueMode; baseUrl: string; outDir: string };

export const QR_CLI_HELP = `Usage: npm run qr:tables -- [--mode local|production] [--base-url URL] [--out DIR]

Reads Coders' Cafe table tokens T01–T10 from the database and writes QR labels
for the existing guest menu route /t/<token>. Does not create or rotate tokens.

  --mode local        Default. Writes a local test sheet marked not for customer printing.
  --mode production   Requires a public https base URL. Refuses localhost and private addresses.
  --base-url URL      Overrides PUBLIC_BASE_URL. Local mode defaults to http://localhost:3000.
  --out DIR           Relative output directory. Defaults to artifacts/table-qr/<mode>.
`;

/** Operator arguments only. There is no flag for a table id, outlet id, token, or price. */
export function parseQrArgs(
  argv: string[],
  env: QrEnvironment = process.env,
): ParsedQrArgs {
  let mode: QrIssueMode = "local";
  let baseUrl = env.PUBLIC_BASE_URL?.trim() || "";
  let outDir = "";
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") return { help: true };
    if (arg === "--mode") {
      const value = argv[++i];
      if (value !== "local" && value !== "production") throw new TableQrError("--mode must be local or production");
      mode = value;
    } else if (arg === "--base-url") {
      const value = argv[++i];
      if (!value) throw new TableQrError("--base-url requires a URL");
      baseUrl = value;
    } else if (arg === "--out") {
      const value = argv[++i];
      if (!value) throw new TableQrError("--out requires a directory");
      outDir = value;
    } else {
      throw new TableQrError(`Unknown argument ${arg}. Table, outlet, token, and price cannot be passed on the command line.`);
    }
  }
  if (!baseUrl) {
    if (mode === "local") baseUrl = "http://localhost:3000";
    else throw new TableQrError("Production mode requires --base-url or PUBLIC_BASE_URL set to a public https URL");
  }
  if (!outDir) outDir = mode === "production" ? "artifacts/table-qr/production" : "artifacts/table-qr/local";
  return { help: false, mode, baseUrl, outDir };
}
