/**
 * What a scanned (or pasted) table QR says, without trusting it.
 *
 * Pure and dependency-free so the scanner screen (client) and the scan
 * endpoint (server) apply the same rules. The only accepted shapes are the
 * guest route `/t/<token>` on an absolute http(s) URL, or a bare token. The
 * server additionally requires the URL's origin to be one of this
 * deployment's own addresses (server/qr/scan.ts); nothing here ever opens,
 * fetches or redirects to the scanned text.
 *
 * Messages never repeat the scanned text: it may hold a live table token.
 */

/** URL-safe table token. The QR generator, resolveTable and the scanner share this rule. */
export const GUEST_TABLE_TOKEN_RE = /^[A-Za-z0-9_-]{6,64}$/;

export function isGuestTableToken(token: unknown): token is string {
  return typeof token === "string" && GUEST_TABLE_TOKEN_RE.test(token);
}

/** Longest text the scanner considers (a RESTORA guest URL is far shorter). */
export const MAX_QR_TEXT = 2048;

export type TableQrRejection =
  | "empty"
  | "too_long"
  | "unsafe_scheme"
  | "malformed_url"
  | "credentials"
  | "query_or_fragment"
  | "wrong_path"
  | "bad_token"
  | "untrusted_origin";

export type ParsedTableQr =
  | { ok: true; token: string; origin: string | null }
  | { ok: false; reason: TableQrRejection; message: string };

export const TABLE_QR_MESSAGES: Record<TableQrRejection, string> = {
  empty: "Nothing to check. Scan a table QR or paste its link.",
  too_long: "This QR holds far more text than a RESTORA table link.",
  unsafe_scheme: "This QR is not a web link RESTORA can use (only http and https table links are accepted).",
  malformed_url: "This text is not a valid web address or table token.",
  credentials: "Links that carry a user name or password are refused.",
  query_or_fragment: "RESTORA table links have no extra parameters; this one does, so it was refused.",
  wrong_path: "This link is not a RESTORA table link (expected …/t/<table code>).",
  bad_token: "The table code in this QR is not in RESTORA's format.",
  untrusted_origin: "This QR points to a website that is not this RESTORA deployment.",
};

const reject = (reason: TableQrRejection): ParsedTableQr => ({ ok: false, reason, message: TABLE_QR_MESSAGES[reason] });

/** Exact origin (scheme://host[:port]) of an absolute http(s) address, or null. */
export function originOf(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw.trim());
    return u.protocol === "http:" || u.protocol === "https:" ? u.origin : null;
  } catch {
    return null;
  }
}

/**
 * Parse scanned or pasted text. `trustedOrigins` (exact origins) is enforced
 * when given; without it only the shape is checked (the client's pre-check —
 * the server always passes its own list).
 */
export function parseTableQr(input: unknown, opts: { trustedOrigins?: readonly string[] } = {}): ParsedTableQr {
  if (typeof input !== "string") return reject("empty");
  const text = input.trim();
  if (!text) return reject("empty");
  if (text.length > MAX_QR_TEXT) return reject("too_long");

  // A bare token (what staff may paste from the Tables screen).
  if (!/[:/?#\s]/.test(text)) return isGuestTableToken(text) ? { ok: true, token: text, origin: null } : reject("bad_token");

  // Anything with a scheme other than http(s) — javascript:, data:, file:, intent:, upi:… — is refused before parsing.
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(text)?.[1]?.toLowerCase();
  if (!scheme) return reject("malformed_url");
  if (scheme !== "http" && scheme !== "https") return reject("unsafe_scheme");
  if (/\s/.test(text) || !/^https?:\/\/[^/]/i.test(text)) return reject("malformed_url");

  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return reject("malformed_url");
  }
  if (!url.hostname) return reject("malformed_url");
  if (url.username || url.password) return reject("credentials");
  if (url.search || url.hash || text.includes("?") || text.includes("#")) return reject("query_or_fragment");

  const m = /^\/t\/([^/]+)\/?$/.exec(url.pathname);
  if (!m) return reject("wrong_path");
  let token: string;
  try {
    token = decodeURIComponent(m[1]);
  } catch {
    return reject("bad_token");
  }
  // Same rule as the label writer: the path segment is exactly the encoded token.
  if (!isGuestTableToken(token) || encodeURIComponent(token) !== m[1]) return reject("bad_token");

  if (opts.trustedOrigins && !opts.trustedOrigins.includes(url.origin)) return reject("untrusted_origin");
  return { ok: true, token, origin: url.origin };
}

/** The guest ordering URL for a validated token on a known origin. */
export function guestTableUrl(origin: string, token: string): string {
  if (!isGuestTableToken(token)) throw new Error("Not a guest table token");
  const o = originOf(origin);
  if (!o) throw new Error("Not an http(s) origin");
  return `${o}/t/${encodeURIComponent(token)}`;
}

/** A display hint of a token ("••••b9_"): its last 3 characters only, never the whole value. */
export function maskToken(token: string): string {
  return `••••${token.slice(-3)}`;
}
