/**
 * Production environment validation.
 *
 * Fails fast at server startup when required production configuration is missing
 * or unsafe, so a misconfigured deployment never silently serves traffic with
 * insecure defaults. Development and test stay permissive (the check is a no-op
 * unless NODE_ENV === "production"), so local workflows are unaffected.
 *
 * Only configuration the app actually reads is validated. Error messages name
 * the offending variable and the reason ONLY; a secret's value is NEVER
 * included in an error, log, or stack trace.
 *
 * Two levels:
 *  - validateProductionEnv: hard failures (the server refuses to start);
 *  - productionEnvWarnings: risky-but-legitimate settings logged at every boot
 *    (e.g. mock providers explicitly allowed on a non-public test deployment).
 *
 * The full variable reference is docs/production-infrastructure.md §2.
 */

import { resendPasswordProblems } from "@/server/auth/passwordResetMail";

/** Public, well-known development placeholder for AUTH_SECRET (safe to reference). */
export const DEV_AUTH_SECRET_PLACEHOLDER = "dev-only-insecure-secret-change-me-please-32chars-min";

/** Minimum length for a production AUTH_SECRET. */
const MIN_AUTH_SECRET_LENGTH = 32;

/**
 * Publicly known development values (in .env.example / mock adapters). A real
 * deployment must never run with them: anyone could forge a webhook.
 */
export const DEV_SECRET_PLACEHOLDERS = ["dev-webhook-secret", "dev-cron-secret", "changeme", "change-me", "secret"];
const WEBHOOK_SECRET_VARS = ["PAYMENT_WEBHOOK_SECRET", "AGGREGATOR_WEBHOOK_SECRET", "PETPOOJA_WEBHOOK_SECRET", "RAZORPAY_WEBHOOK_SECRET", "CRON_SECRET"] as const;
const PROVIDER_VARS = ["PAYMENT_PROVIDER", "POS_PROVIDER", "WHATSAPP_PROVIDER", "EMAIL_PROVIDER", "GOOGLE_SHEETS_PROVIDER"] as const;
/** integrations/payment getPaymentProvider: sbi_upi (not implemented yet), upi_emulator / mock (tests), razorpay (legacy only). */
const PAYMENT_PROVIDER_NAMES = ["sbi_upi", "upi_emulator", "mock", "razorpay"];
const LOG_LEVELS = ["debug", "info", "warn", "error"];

const isSet = (v: string | undefined): v is string => v !== undefined && v.trim() !== "";
const isLocalHost = (h: string) => h === "localhost" || h === "127.0.0.1" || h === "[::1]";

function httpsUrlProblem(name: string, v: string): string | null {
  try {
    const u = new URL(v);
    if (u.protocol === "https:") return null;
    if (u.protocol === "http:" && isLocalHost(u.hostname)) return null;
    return `${name} must be an https:// URL`;
  } catch {
    return `${name} must be a valid URL`;
  }
}

function intProblem(env: NodeJS.ProcessEnv, name: string, min: number, max = Number.MAX_SAFE_INTEGER): string | null {
  const v = env[name];
  if (!isSet(v)) return null;
  const n = Number(v);
  return Number.isInteger(n) && n >= min && n <= max ? null : `${name} must be an integer between ${min} and ${max}`;
}

export class EnvValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnvValidationError";
  }
}

/**
 * Validate the environment for production. No-op outside production.
 * Throws EnvValidationError listing every problem (variable names + reasons only).
 */
export function validateProductionEnv(env: NodeJS.ProcessEnv = process.env): void {
  if (env.NODE_ENV !== "production") return; // dev/test are intentionally permissive

  const problems: string[] = [];

  // --- Database (required) ---
  if (!env.DATABASE_URL || env.DATABASE_URL.trim() === "") {
    problems.push("DATABASE_URL is required in production");
  }

  // --- Auth secret (must be present, not the dev placeholder, long enough) ---
  const secret = env.AUTH_SECRET;
  if (!secret || secret.trim() === "") {
    problems.push("AUTH_SECRET is required in production");
  } else if (secret === DEV_AUTH_SECRET_PLACEHOLDER) {
    problems.push("AUTH_SECRET must not use the development placeholder value in production");
  } else if (secret.length < MIN_AUTH_SECRET_LENGTH) {
    problems.push(`AUTH_SECRET must be at least ${MIN_AUTH_SECRET_LENGTH} characters in production`);
  }

  // --- Rate limiting must stay enabled in production ---
  if (env.RATE_LIMIT_DISABLED === "true") {
    problems.push("RATE_LIMIT_DISABLED must not be 'true' in production");
  }

  // --- Session lifetime, if overridden, must be a positive integer ---
  if (env.SESSION_TTL_SECONDS !== undefined && env.SESSION_TTL_SECONDS !== "") {
    const ttl = Number(env.SESSION_TTL_SECONDS);
    if (!Number.isInteger(ttl) || ttl <= 0) {
      problems.push("SESSION_TTL_SECONDS must be a positive integer");
    }
  }

  // --- Background exports (optional; defaults: background runner, 168 h retention) ---
  if (env.EXPORT_RUNNER !== undefined && env.EXPORT_RUNNER !== "" && !["background", "inline"].includes(env.EXPORT_RUNNER.toLowerCase())) {
    problems.push('EXPORT_RUNNER must be "background" or "inline"');
  }
  if (env.EXPORT_RETENTION_HOURS !== undefined && env.EXPORT_RETENTION_HOURS !== "") {
    const h = Number(env.EXPORT_RETENTION_HOURS);
    if (!Number.isInteger(h) || h <= 0) problems.push("EXPORT_RETENTION_HOURS must be a positive integer");
  }

  const mocksAllowed = env.ALLOW_MOCK_PROVIDERS === "true";

  // --- Development placeholder secrets: a forged webhook would be accepted ---
  // Tolerated only on an explicitly mock-provider (non-public test) deployment,
  // where productionEnvWarnings reports them on every boot.
  if (!mocksAllowed) {
    for (const name of WEBHOOK_SECRET_VARS) {
      const v = env[name];
      if (isSet(v) && DEV_SECRET_PLACEHOLDERS.includes(v.trim().toLowerCase())) problems.push(`${name} must not use a development placeholder value in production`);
    }
    for (const name of PROVIDER_VARS) {
      if (env[name]?.trim().toLowerCase() === "mock") problems.push(`${name}=mock is refused in production (configure a real provider, or set ALLOW_MOCK_PROVIDERS=true on a non-public test deployment only)`);
    }
  }

  // --- Online payment provider (new checkouts). Unknown names fail loudly; there is no fallback. ---
  const paymentProvider = env.PAYMENT_PROVIDER?.trim().toLowerCase();
  if (paymentProvider && !PAYMENT_PROVIDER_NAMES.includes(paymentProvider)) problems.push(`PAYMENT_PROVIDER must be one of ${PAYMENT_PROVIDER_NAMES.join(", ")}`);
  // The UPI bank emulator is a test adapter: it must never take a production guest's payment.
  if (!mocksAllowed) {
    if (paymentProvider === "upi_emulator") problems.push("PAYMENT_PROVIDER=upi_emulator (test bank emulator) is refused in production");
    for (const name of ["UPI_EMULATOR_BASE", "UPI_EMULATOR_API_KEY", "UPI_EMULATOR_MERCHANT_ID", "UPI_EMULATOR_WEBHOOK_SECRET"]) if (isSet(env[name])) problems.push(`${name} (test bank emulator) must not be set in production`);
  }
  // Vercel's Production environment serves real guests: no opt-in turns the test adapters on there (Preview may still run them).
  if (env.VERCEL_ENV === "production") {
    if (mocksAllowed) problems.push("ALLOW_MOCK_PROVIDERS must not be true on a Vercel Production deployment (mock and test-bank adapters approve payments without a bank)");
    if (paymentProvider === "upi_emulator" || paymentProvider === "mock") problems.push(`PAYMENT_PROVIDER=${paymentProvider} is a test adapter and is refused on a Vercel Production deployment`);
  }
  // --- Razorpay (LEGACY ONLY: settles / refunds payments made before it was retired). Keys, when present, must be complete. ---
  if (isSet(env.RAZORPAY_KEY_ID) || isSet(env.RAZORPAY_KEY_SECRET)) {
    if (!isSet(env.RAZORPAY_KEY_ID) || !/^rzp_(test|live)_[A-Za-z0-9]+$/.test(env.RAZORPAY_KEY_ID.trim())) problems.push("RAZORPAY_KEY_ID must be a Razorpay key id (rzp_test_… or rzp_live_…) when Razorpay keys are configured for legacy payments");
    if (!isSet(env.RAZORPAY_KEY_SECRET)) problems.push("RAZORPAY_KEY_SECRET is required with RAZORPAY_KEY_ID (legacy Razorpay payments are verified and refunded with it)");
    if (!isSet(env.RAZORPAY_WEBHOOK_SECRET)) problems.push("RAZORPAY_WEBHOOK_SECRET is required with RAZORPAY_KEY_ID (legacy Razorpay webhooks are verified with it)");
  }
  // A public demo must not enable mock adapters: they approve any payment and
  // relax webhook-secret checks.
  if (env.DEMO_DEPLOYMENT === "true" && mocksAllowed) {
    problems.push("ALLOW_MOCK_PROVIDERS must not be true when DEMO_DEPLOYMENT is set (mock adapters approve any payment and are not for a public demo)");
  }
  if (isSet(env.DEMO_STAFF_PASSWORD) || env.DEMO_DATABASE_CONFIRMED === "true") {
    problems.push("DEMO_STAFF_PASSWORD and DEMO_DATABASE_CONFIRMED are seed-CLI settings and must not be set on the running app");
  }
  // Live keys charge real money. Mock/demo deployments must never be able to reach Razorpay live.
  const liveRazorpay = env.RAZORPAY_KEY_ID?.trim().startsWith("rzp_live_") === true;
  if (liveRazorpay && (mocksAllowed || env.DEMO_DEPLOYMENT === "true")) {
    problems.push("RAZORPAY_KEY_ID must not be a live key when ALLOW_MOCK_PROVIDERS or DEMO_DEPLOYMENT is set (simulated/test payments only)");
  }

  // Vercel has no durable in-process worker; cron invokes /api/cron/worker with this secret.
  if (env.VERCEL === "1") {
    const cron = env.CRON_SECRET;
    if (!isSet(cron)) problems.push("CRON_SECRET is required on Vercel (the maintenance worker is invoked by cron, not in-process)");
    else if (DEV_SECRET_PLACEHOLDERS.includes(cron.trim().toLowerCase())) problems.push("CRON_SECRET must not use a development placeholder value in production");
  }

  // --- The demo seed wipes data and creates public-password accounts ---
  if (env.ALLOW_DEMO_SEED === "true") problems.push("ALLOW_DEMO_SEED must not be 'true' in production");

  // Password-reset email is optional. A partial Resend setup must not boot:
  // it would look configured while no message can be accepted.
  for (const p of resendPasswordProblems(env)) problems.push(p);

  // --- Secrets that are optional but must be strong when set ---
  if (isSet(env.INTEGRATION_SECRETS_KEY) && env.INTEGRATION_SECRETS_KEY.length < MIN_AUTH_SECRET_LENGTH) {
    problems.push(`INTEGRATION_SECRETS_KEY must be at least ${MIN_AUTH_SECRET_LENGTH} characters when set`);
  }
  if (isSet(env.METRICS_TOKEN) && env.METRICS_TOKEN.length < 24) problems.push("METRICS_TOKEN must be at least 24 characters when set");

  // --- URLs ---
  for (const name of ["PUBLIC_BASE_URL", "NEXT_PUBLIC_SITE_URL", "ALERT_WEBHOOK_URL"] as const) {
    const v = env[name];
    if (isSet(v)) {
      const p = httpsUrlProblem(name, v);
      if (p) problems.push(p);
    }
  }

  // --- Operational tuning ---
  if (isSet(env.RATE_LIMIT_STORE) && !["memory", "database"].includes(env.RATE_LIMIT_STORE.trim().toLowerCase())) problems.push('RATE_LIMIT_STORE must be "memory" (one instance) or "database" (counters shared by every instance)');
  if (isSet(env.LOG_LEVEL) && !LOG_LEVELS.includes(env.LOG_LEVEL.toLowerCase())) problems.push(`LOG_LEVEL must be one of ${LOG_LEVELS.join(", ")}`);
  if (isSet(env.LOG_FORMAT) && !["json", "pretty"].includes(env.LOG_FORMAT)) problems.push('LOG_FORMAT must be "json" or "pretty"');
  for (const p of [
    intProblem(env, "TRUSTED_PROXY_HOPS", 1, 10),
    intProblem(env, "GUEST_FULFILMENT_WINDOW_MINUTES", 1, 240),
    intProblem(env, "PAYMENT_RECHECK_MAX_AGE_HOURS", 1, 168),
    intProblem(env, "SLOW_REQUEST_MS", 1),
    intProblem(env, "SHUTDOWN_TIMEOUT_MS", 1000, 600_000),
    intProblem(env, "SHUTDOWN_DELAY_MS", 0, 120_000),
    intProblem(env, "SHUTDOWN_REFUSE_GRACE_MS", 0, 60_000),
    intProblem(env, "OUTBOX_WORKER_INTERVAL_MS", 1000, 3_600_000),
    intProblem(env, "SESSION_IDLE_TIMEOUT_SECONDS", 1),
    intProblem(env, "BACKUP_MAX_AGE_HOURS", 1),
    intProblem(env, "GUEST_MAX_UNPAID_ORDERS_PER_TABLE", 1, 50),
    intProblem(env, "ALERT_THROTTLE_SECONDS", 1),
  ]) if (p) problems.push(p);

  if (problems.length > 0) {
    // Names + reasons only — never a secret's value.
    throw new EnvValidationError(`Invalid production environment configuration:\n- ${problems.join("\n- ")}`);
  }
}

/**
 * Risky-but-legitimate production settings. Logged (names + reasons only) at
 * every boot so an operator cannot miss them. Empty outside production.
 */
export function productionEnvWarnings(env: NodeJS.ProcessEnv = process.env): string[] {
  if (env.NODE_ENV !== "production") return [];
  const w: string[] = [];
  if (env.ALLOW_MOCK_PROVIDERS === "true") w.push("ALLOW_MOCK_PROVIDERS=true: mock payment/POS/aggregator adapters approve anything — never on a public deployment");
  if (env.DEMO_DEPLOYMENT === "true") w.push("DEMO_DEPLOYMENT=true: sample data and simulated/test payments only; not a live restaurant");
  if (env.VERCEL === "1") w.push("VERCEL=1: in-process maintenance worker is disabled; /api/cron/worker must be invoked by Vercel Cron");
  if (env.ALLOW_MOCK_PROVIDERS === "true") {
    for (const name of WEBHOOK_SECRET_VARS) {
      const v = env[name];
      if (isSet(v) && DEV_SECRET_PLACEHOLDERS.includes(v.trim().toLowerCase())) w.push(`${name} uses a development placeholder value`);
    }
  }
  const paymentProvider = env.PAYMENT_PROVIDER?.trim().toLowerCase();
  if (paymentProvider === "razorpay") w.push("PAYMENT_PROVIDER=razorpay: Razorpay is retired for new online payments, so guest QR ordering reports online payment as unavailable (Razorpay keys still settle and refund older Razorpay payments). Set PAYMENT_PROVIDER=sbi_upi once SBI is live");
  if (paymentProvider === "sbi_upi") w.push("PAYMENT_PROVIDER=sbi_upi: the SBI UPI adapter is not implemented yet (waiting for SBI's API specification and UAT), so guest QR ordering reports online payment as unavailable");
  if (paymentProvider === "upi_emulator") w.push("PAYMENT_PROVIDER=upi_emulator: online payments go to the local TEST bank emulator, no real money (tests only)");
  if (isSet(env.RAZORPAY_KEY_ID) && env.RAZORPAY_KEY_ID.trim().startsWith("rzp_test_")) w.push("RAZORPAY_KEY_ID is a TEST key: legacy Razorpay payments on this deployment are test-mode payments");
  const db = env.DATABASE_URL ?? "";
  if (db.startsWith("file:") && env.AHAROS_DESKTOP !== "1") w.push("DATABASE_URL is SQLite: the server deployment target is PostgreSQL (docs/production-infrastructure.md)");
  if (env.AHAROS_DESKTOP !== "1") {
    if (!isSet(env.EXPORT_DIR)) w.push("EXPORT_DIR is unset: background exports are written to the OS temp directory and lost on restart/cleanup");
    if (!isSet(env.METRICS_TOKEN)) w.push("METRICS_TOKEN is unset: /api/health/metrics is disabled");
    if (!isSet(env.ALERT_WEBHOOK_URL)) w.push("ALERT_WEBHOOK_URL is unset: alerts are written to the log only");
    if (!isSet(env.PUBLIC_BASE_URL)) w.push("PUBLIC_BASE_URL is unset: table QR codes use the address the Tables screen is viewed on, which guests' phones may not reach");
    if (!isSet(env.RESEND_API_KEY)) w.push("RESEND_API_KEY is unset: password-reset emails are not sent; a manager issues the link");
    if (!isSet(env.NEXT_PUBLIC_SITE_URL)) w.push("NEXT_PUBLIC_SITE_URL is unset (it must be set when building the website too): the website's canonical links, sitemap and Open Graph URLs point at http://localhost:3000");
    if (db.startsWith("postgres") && (env.RATE_LIMIT_STORE ?? "memory").trim().toLowerCase() !== "database") w.push("RATE_LIMIT_STORE is not \"database\": login and other limits are counted per process, so each additional instance multiplies them (set RATE_LIMIT_STORE=database when running more than one instance)");
    if (!isSet(env.INTEGRATION_SECRETS_KEY)) w.push("INTEGRATION_SECRETS_KEY is unset: integration secrets are encrypted with a key derived from AUTH_SECRET (rotating AUTH_SECRET then makes them unreadable)");
  }
  return w;
}
