/**
 * Table QR status lines for the Coders' Cafe seed report.
 *
 * Table QR tokens are bearer secrets: anyone holding one can order at that
 * table. These lines report how many tables have a token and how to print
 * labels. They never contain a token or a /t/<token> link.
 */
import { normalizeQrOrigin, qrBaseUrlProblem } from "@/server/qr/tableLabels";

export function cafeQrStatusLines(input: {
  baseUrl: string | undefined;
  tableCodes: readonly string[];
  tables: Array<{ code: string; hasQrToken: boolean }>;
}): string[] {
  const withToken = new Set(input.tables.filter((t) => t.hasQrToken).map((t) => t.code));
  const missing = input.tableCodes.filter((code) => !withToken.has(code));
  const lines = [
    `\nTable QR: ${input.tableCodes.length - missing.length} of ${input.tableCodes.length} tables have a QR token stored (tokens are not printed).`,
  ];
  if (missing.length) lines.push(`No QR token: ${missing.join(", ")}`);

  const raw = input.baseUrl?.trim() ?? "";
  // Only a URL that passes the label checks is echoed back, and only as an origin.
  const origin = raw && !qrBaseUrlProblem(raw, "local") ? normalizeQrOrigin(raw) : null;
  if (origin && !qrBaseUrlProblem(origin, "production")) {
    lines.push(`Print customer labels with: npm run qr:tables -- --mode production --base-url ${origin}`);
  } else {
    lines.push(`Local test labels (not for customer printing): npm run qr:tables -- --base-url ${origin ?? "http://localhost:3000"}`);
    lines.push("Customer labels: npm run qr:tables -- --mode production --base-url <public https address>");
  }
  return lines;
}
