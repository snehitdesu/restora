/**
 * HTTP client the desktop's embedded server uses to talk to the RESTORA cloud API. It speaks only the public,
 * authenticated API — never the cloud database. The device credential is handed in by the caller (decrypted from
 * the CloudLink row just before use) as `Authorization: Bearer` and is never logged or put in a URL.
 *
 * Failures are classified so the sync runner can react correctly:
 *   CloudOfflineError  network down / timeout / DNS — retry later, keep working from the cache;
 *   CloudAuthError     401: the device was revoked or expired — stop, ask the operator to pair again;
 *   CloudHttpError     any other non-2xx; `transient` for 429 and 5xx (retry), permanent for other 4xx.
 */
import { BACKGROUND_HEADER } from "@/constants/auth";
import { ValidationError } from "@/server/db/scope";

export type Transport = (url: string, init: RequestInit) => Promise<Response>;

export class CloudOfflineError extends Error {
  status = 503;
  constructor(message = "The cloud could not be reached") {
    super(message);
    this.name = "CloudOfflineError";
  }
}
export class CloudAuthError extends Error {
  status = 401;
  constructor(message = "The cloud session is no longer valid") {
    super(message);
    this.name = "CloudAuthError";
  }
}
/** The cloud answered, but is overloaded / restarting — retry later; this is not a healthy link. */
export class CloudUnavailableError extends Error {
  status = 503;
  retryAfterSeconds = 2;
  constructor(message = "The cloud is temporarily unavailable. Try again in a moment.") {
    super(message);
    this.name = "CloudUnavailableError";
  }
}
export class CloudHttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = "CloudHttpError";
  }
  get transient(): boolean {
    return this.status === 429 || this.status >= 500;
  }
}

/** Anything that means "try again later" rather than "this request is wrong". */
export const isTransientCloudError = (e: unknown): boolean =>
  e instanceof CloudOfflineError || e instanceof CloudUnavailableError || (e instanceof CloudHttpError && e.transient);

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Only the origin of an https:// URL (http:// only for loopback development); no credentials, path, query or fragment. */
export function normalizeBaseUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new ValidationError("Enter the cloud address, for example https://restora.example.com");
  }
  if (u.username || u.password) throw new ValidationError("The cloud address must not contain a user name or password");
  if (u.protocol !== "https:" && !(u.protocol === "http:" && LOOPBACK.has(u.hostname))) throw new ValidationError("The cloud address must start with https://");
  return u.origin;
}

let transportOverride: Transport | null = null;
/** Tests route the desktop's cloud traffic to in-process handlers; nothing else may replace the network. */
export function setCloudTransportForTests(t: Transport | null): void {
  if (process.env.NODE_ENV === "production") throw new Error("setCloudTransportForTests is for tests only");
  transportOverride = t;
}
const defaultTransport: Transport = (url, init) => (transportOverride ?? fetch)(url, init);
const TIMEOUT_MS = 15_000;

async function readEnvelope(res: Response): Promise<{ ok: boolean; data?: unknown; error?: { code?: string; message?: string } } | null> {
  try {
    return (await res.json()) as never;
  } catch {
    return null;
  }
}

export class CloudClient {
  private readonly transport: Transport;
  constructor(private readonly opts: { baseUrl: string; token?: string; transport?: Transport; timeoutMs?: number }) {
    this.transport = opts.transport ?? defaultTransport;
  }

  private async request<T>(method: "GET" | "POST", path: string, extra: { body?: unknown; headers?: Record<string, string> } = {}): Promise<{ data: T; res: Response }> {
    const headers: Record<string, string> = { accept: "application/json", ...(extra.headers ?? {}) };
    // Device credentials travel as Bearer, never in a cookie (cookies are for staff browsers / the local desktop session).
    if (this.opts.token) headers.authorization = `Bearer ${this.opts.token}`;
    if (extra.body !== undefined) headers["content-type"] = "application/json";
    let res: Response;
    try {
      res = await this.transport(`${this.opts.baseUrl}${path}`, { method, headers, body: extra.body === undefined ? undefined : JSON.stringify(extra.body), redirect: "manual", signal: AbortSignal.timeout(this.opts.timeoutMs ?? TIMEOUT_MS) });
    } catch {
      // Never echo the underlying error: it can carry the URL.
      throw new CloudOfflineError();
    }
    const env = await readEnvelope(res);
    if (res.status === 401) throw new CloudAuthError(env?.error?.message);
    // Reachable but overloaded / restarting: a fixed message — the envelope can echo request internals.
    if (res.status === 503) throw new CloudUnavailableError();
    // A redirect (a proxy or login page in the way) is not an API answer.
    if (res.status >= 300 && res.status < 400) throw new CloudHttpError(502, "BadGateway", "The cloud address did not answer like RESTORA");
    if (!res.ok || !env?.ok) throw new CloudHttpError(res.status, env?.error?.code ?? "Error", env?.error?.message ?? `The cloud answered ${res.status}`);
    return { data: env.data as T, res };
  }

  async get<T>(path: string, opts: { background?: boolean } = {}): Promise<T> {
    return (await this.request<T>("GET", path, { headers: opts.background ? { [BACKGROUND_HEADER]: "1" } : undefined })).data;
  }

  async post<T>(path: string, body: unknown, opts: { idempotencyKey?: string } = {}): Promise<T> {
    return (await this.request<T>("POST", path, { body, headers: opts.idempotencyKey ? { "idempotency-key": opts.idempotencyKey } : undefined })).data;
  }

  /** Exchange a staff password for a revocable device credential (the password is not kept). */
  async enroll(body: { email: string; password: string; outletCode?: string; deviceName?: string; installId?: string }): Promise<{ token: string; outlet: { id: string; code: string; name: string }; expiresAt: string; userEmail: string }> {
    return this.post("/api/sync/enroll", body);
  }

  /** Redeem a hosted POS pairing code for a device credential. */
  async completePairing(body: { code: string; deviceName?: string; installId?: string }): Promise<{ token: string; outlet: { id: string; code: string; name: string }; expiresAt: string; userEmail: string }> {
    return this.post("/api/sync/pair/complete", body);
  }

  async revokeSelf(): Promise<void> {
    await this.request<unknown>("POST", "/api/sync/device/revoke", { body: {} }).catch(() => undefined);
  }
}
