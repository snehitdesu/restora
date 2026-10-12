/**
 * Rate limiting for security-sensitive and expensive endpoints.
 *
 * Fixed-window counters behind a `RateLimitStore` interface:
 *  - MemoryRateLimitStore (default): per-process. Correct for local development
 *    and single-instance deployments.
 *  - DatabaseRateLimitStore (rateLimitDb.ts): the counters live in the application
 *    database, so several instances share them. REQUIRED when more than one
 *    instance serves the same restaurant. Any other value fails loudly instead of
 *    silently degrading to per-process limits.
 *
 * Env: RATE_LIMIT_DISABLED=true turns limiting off (e.g. load tests);
 *      RATE_LIMIT_STORE=memory|database.
 *
 * Client IP comes from X-Forwarded-For, which is only trustworthy behind a
 * reverse proxy. Proxies APPEND the address they saw, so the client controls
 * every entry left of the ones added by our own proxies: the IP is read
 * TRUSTED_PROXY_HOPS entries from the RIGHT (default 1 = one proxy / load
 * balancer in front of the app). Taking the leftmost entry (as before) let a
 * client pick a fresh "IP" per request, defeating the per-IP login limit and
 * flooding the store. Login is ALSO limited per email.
 */
import type { NextRequest } from "next/server";
import { DatabaseRateLimitStore } from "@/server/api/rateLimitDb";
import { MemoryRateLimitStore, type RateLimitStore } from "@/server/api/rateLimitStore";

export class RateLimitError extends Error {
  status = 429;
  retryAfterSeconds: number;
  constructor(retryAfterSeconds: number, message = "Too many requests") {
    super(message);
    this.name = "RateLimitError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export { MemoryRateLimitStore, type RateLimitStore } from "@/server/api/rateLimitStore";

let store: RateLimitStore | null = null;
export function getRateLimitStore(): RateLimitStore {
  if (store) return store;
  const kind = (process.env.RATE_LIMIT_STORE ?? "memory").toLowerCase();
  if (kind !== "memory" && kind !== "database") throw new Error(`RATE_LIMIT_STORE=${kind} is not supported; use "memory" (one instance) or "database" (shared by every instance)`);
  store = kind === "database" ? new DatabaseRateLimitStore() : new MemoryRateLimitStore();
  return store;
}

/** Tests only: forget the chosen store so the next call reads RATE_LIMIT_STORE again. */
export function resetRateLimitStoreForTests(): void {
  store = null;
}

export type RatePolicy = { name: string; limit: number; windowMs: number };

export const RATE_POLICIES = {
  loginPerEmail: { name: "login-email", limit: 10, windowMs: 15 * 60_000 },
  loginPerIp: { name: "login-ip", limit: 50, windowMs: 60_000 },
  passwordResetPerEmail: { name: "pwreset-email", limit: 5, windowMs: 60 * 60_000 },
  passwordResetPerIp: { name: "pwreset-ip", limit: 20, windowMs: 15 * 60_000 },
  passwordCompletePerIp: { name: "pwcomplete-ip", limit: 20, windowMs: 15 * 60_000 },
  passwordChangePerUser: { name: "pwchange-user", limit: 10, windowMs: 15 * 60_000 },
  reauthPerUser: { name: "reauth-user", limit: 30, windowMs: 15 * 60_000 },
  webhook: { name: "webhook", limit: 600, windowMs: 60_000 },
  export: { name: "export", limit: 20, windowMs: 60_000 },
  report: { name: "report", limit: 120, windowMs: 60_000 },
  // The search box fires as people type (debounced); a runaway client is not a person.
  search: { name: "search", limit: 240, windowMs: 60_000 },
  // Calls that reach an external provider or device (test connection / test print / test message).
  integrationAction: { name: "integration-action", limit: 30, windowMs: 60_000 },
  // Guest QR ordering (anonymous). Guests behind restaurant Wi-Fi share one IP,
  // so per-IP limits are generous; order placement is also capped per table.
  guestReadPerIp: { name: "guest-read-ip", limit: 600, windowMs: 60_000 },
  guestWritePerIp: { name: "guest-write-ip", limit: 60, windowMs: 60_000 },
  guestOrderPerTable: { name: "guest-order-table", limit: 20, windowMs: 10 * 60_000 },
  // Cart re-pricing (read-only POST): several guests on one café Wi-Fi share an IP.
  guestQuotePerIp: { name: "guest-quote-ip", limit: 240, windowMs: 60_000 },
  // One feedback answer per order; a link or an order key being hammered is not a guest.
  guestFeedbackPerKey: { name: "guest-feedback-key", limit: 10, windowMs: 10 * 60_000 },
  guestUnsubscribePerIp: { name: "guest-unsub-ip", limit: 30, windowMs: 10 * 60_000 },
} satisfies Record<string, RatePolicy>;

export function trustedProxyHops(): number {
  const n = Number(process.env.TRUSTED_PROXY_HOPS ?? 1);
  return Number.isInteger(n) && n >= 1 && n <= 10 ? n : 1;
}

export function clientIp(req: NextRequest | Request, hops = trustedProxyHops()): string {
  const chain = (req.headers.get("x-forwarded-for") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  // The entry added by the outermost trusted proxy; if the chain is shorter than
  // expected (misconfigured / no proxy), fall back to its first entry.
  const ip = chain.length ? chain[Math.max(0, chain.length - hops)] : req.headers.get("x-real-ip")?.trim();
  return (ip || "unknown").slice(0, 64);
}

/** Count a hit and throw RateLimitError (429 + Retry-After) when over the limit. */
export async function enforceRateLimit(policy: RatePolicy, key: string, now = Date.now()): Promise<void> {
  if (process.env.RATE_LIMIT_DISABLED === "true") return;
  const { count, resetAt } = await getRateLimitStore().hit(`${policy.name}:${key}`, policy.windowMs, now);
  if (count > policy.limit) throw new RateLimitError(Math.max(1, Math.ceil((resetAt - now) / 1000)));
}
