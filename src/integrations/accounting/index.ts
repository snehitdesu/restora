/**
 * Accounting export formats. RESTORA stays the source of truth: the accounting
 * service (server/services/accounting.ts) turns finance records into balanced
 * double-entry vouchers; an AccountingFormat only serializes them —
 * deterministically (same vouchers → byte-identical file), so an export can be
 * re-downloaded and diffed.
 *
 *  - generic: one CSV row per ledger line (Date, Voucher type, Number, Ledger,
 *    Debit, Credit, Party, Narration, Source key).
 *  - tally:   Tally ERP / TallyPrime XML import envelope (vouchers with
 *    ALLLEDGERENTRIES.LIST; debits negative with ISDEEMEDPOSITIVE=Yes).
 *  - zoho:    Zoho Books manual-journal import CSV.
 *
 * Direct sync (sync.ts: a TallyPrime XML gateway, the Zoho Books API) is built
 * and contract-tested against local emulators only: no Tally company or Zoho
 * organisation has been connected, so it is never reported as LIVE-verified.
 */
export type VoucherType =
  | "SALES" | "CREDIT_NOTE" | "RECEIPT" | "REFUND" | "EXPENSE" | "EXPENSE_VOID"
  | "PURCHASE" | "PURCHASE_CANCEL" | "VENDOR_PAYMENT" | "VENDOR_PAYMENT_REVERSAL";

export type VoucherLine = { ledger: string; debit: number; credit: number };
export type Voucher = {
  /** Stable identity of the source document (e.g. "inv:<id>") — the duplicate guard. */
  sourceKey: string;
  date: string; // YYYY-MM-DD (outlet business day)
  type: VoucherType;
  number: string;
  party?: string;
  narration: string;
  lines: VoucherLine[];
};

export interface AccountingFormat {
  readonly name: "generic" | "tally" | "zoho";
  readonly mime: string;
  readonly extension: string;
  render(vouchers: Voucher[]): string;
}

const TALLY_TYPE: Record<VoucherType, string> = {
  SALES: "Sales", CREDIT_NOTE: "Credit Note", RECEIPT: "Receipt", REFUND: "Payment", EXPENSE: "Payment", EXPENSE_VOID: "Journal",
  PURCHASE: "Purchase", PURCHASE_CANCEL: "Debit Note", VENDOR_PAYMENT: "Payment", VENDOR_PAYMENT_REVERSAL: "Journal",
};

/** Sort so the same set of vouchers always renders identically. */
export const ordered = (vs: Voucher[]) => [...vs].sort((a, b) => a.date.localeCompare(b.date) || a.type.localeCompare(b.type) || a.number.localeCompare(b.number) || a.sourceKey.localeCompare(b.sourceKey));

const csvCell = (v: string | number) => {
  const s = String(v);
  // Formula-injection guard (spreadsheets execute =, +, -, @ at the start of a cell).
  const safe = /^[=+\-@\t\r]/.test(s) && typeof v === "string" ? `'${s}` : s;
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};
const amt = (n: number) => n.toFixed(2);

export class GenericAccountingFormat implements AccountingFormat {
  readonly name = "generic" as const;
  readonly mime = "text/csv";
  readonly extension = "csv";
  render(vouchers: Voucher[]): string {
    const rows = [["Date", "Voucher Type", "Voucher No", "Ledger", "Debit", "Credit", "Party", "Narration", "Source"]];
    for (const v of ordered(vouchers)) for (const l of v.lines) rows.push([v.date, v.type, v.number, l.ledger, l.debit ? amt(l.debit) : "", l.credit ? amt(l.credit) : "", v.party ?? "", v.narration, v.sourceKey]);
    return rows.map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
  }
}

const xml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]!);

export class TallyAccountingFormat implements AccountingFormat {
  readonly name = "tally" as const;
  readonly mime = "application/xml";
  readonly extension = "xml";
  render(vouchers: Voucher[]): string {
    const body = ordered(vouchers).map((v) => {
      const entries = v.lines.map((l) => {
        const debit = l.debit > 0;
        return `<ALLLEDGERENTRIES.LIST><LEDGERNAME>${xml(l.ledger)}</LEDGERNAME><ISDEEMEDPOSITIVE>${debit ? "Yes" : "No"}</ISDEEMEDPOSITIVE><AMOUNT>${debit ? `-${amt(l.debit)}` : amt(l.credit)}</AMOUNT></ALLLEDGERENTRIES.LIST>`;
      }).join("");
      return `<TALLYMESSAGE xmlns:UDF="TallyUDF"><VOUCHER VCHTYPE="${TALLY_TYPE[v.type]}" ACTION="Create"><DATE>${v.date.replace(/-/g, "")}</DATE><VOUCHERTYPENAME>${TALLY_TYPE[v.type]}</VOUCHERTYPENAME><VOUCHERNUMBER>${xml(v.number)}</VOUCHERNUMBER>${v.party ? `<PARTYLEDGERNAME>${xml(v.party)}</PARTYLEDGERNAME>` : ""}<NARRATION>${xml(`${v.narration} [${v.sourceKey}]`)}</NARRATION>${entries}</VOUCHER></TALLYMESSAGE>`;
    }).join("");
    return `<?xml version="1.0" encoding="UTF-8"?><ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER><BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>Vouchers</REPORTNAME></REQUESTDESC><REQUESTDATA>${body}</REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>\n`;
  }
}

/**
 * Zoho Books manual-journal import CSV: one row per journal line, rows of one
 * journal share the Journal Date + Reference Number (the voucher's stable
 * source key). The columns follow Zoho Books' manual-journal import; Zoho's
 * import wizard maps columns by name, so check the mapping once against your
 * Zoho organisation before the first import. Amounts in INR, 2 decimals.
 */
export class ZohoBooksAccountingFormat implements AccountingFormat {
  readonly name = "zoho" as const;
  readonly mime = "text/csv";
  readonly extension = "csv";
  render(vouchers: Voucher[]): string {
    const rows = [["Journal Date", "Reference Number", "Notes", "Journal Type", "Currency", "Account", "Description", "Contact Name", "Debit", "Credit"]];
    for (const v of ordered(vouchers)) for (const l of v.lines) rows.push([v.date, v.sourceKey, `${v.type} ${v.number}: ${v.narration}`.slice(0, 500), "both", "INR", l.ledger, v.narration, v.party ?? "", l.debit ? amt(l.debit) : "", l.credit ? amt(l.credit) : ""]);
    return rows.map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
  }
}

export const ACCOUNTING_FORMATS = ["generic", "tally", "zoho"] as const;

export function getAccountingFormat(name?: string): AccountingFormat {
  const n = (name ?? "generic").toLowerCase();
  return n === "tally" ? new TallyAccountingFormat() : n === "zoho" ? new ZohoBooksAccountingFormat() : new GenericAccountingFormat();
}

/** The accountant's names for RESTORA's ledgers and parties (organization setting). */
export type AccountingMap = { ledgers: Record<string, string>; parties: Record<string, string> };

/**
 * Rename ledgers and parties to the books' own names. Amounts, dates, numbers
 * and source keys never change, so balance and duplicate protection hold.
 * An unmapped name passes through unchanged.
 */
export function applyAccountingMap(vouchers: Voucher[], map: AccountingMap | null | undefined): Voucher[] {
  if (!map) return vouchers;
  const ledger = (n: string) => map.ledgers[n] ?? n;
  return vouchers.map((v) => ({
    ...v,
    party: v.party === undefined ? undefined : map.parties[v.party] ?? v.party,
    // "Vendor - <party>" ledgers follow the party mapping unless the ledger itself is mapped.
    lines: v.lines.map((l) => ({ ...l, ledger: map.ledgers[l.ledger] ?? (l.ledger.startsWith("Vendor - ") && map.parties[l.ledger.slice(9)] ? `Vendor - ${map.parties[l.ledger.slice(9)]}` : ledger(l.ledger)) })),
  }));
}

/** A voucher is balanced when Σ debit = Σ credit (to the paisa). */
export const isBalanced = (v: Voucher) => Math.round(v.lines.reduce((a, l) => a + l.debit - l.credit, 0) * 100) === 0;
