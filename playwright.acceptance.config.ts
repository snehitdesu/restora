/**
 * Coders' Cafe customer / investor ACCEPTANCE TEST: the thirty-step walk from a
 * guest scanning table T07 to a served, invoiced, stock-consumed, reported order,
 * plus the five attack families (failed payment, duplicate webhook, duplicate
 * submission, amount tampering, identifier tampering).
 *
 * Fresh state every run: its own database (prisma/e2e-acceptance.db, deleted and
 * rebuilt by e2e/acceptance/prepare-db.ts: migrations + the Coders' Cafe dataset
 * + the bank merchant binding + a recipe with stocked ingredients for one dish + a
 * second, unrelated restaurant for the cross-tenant checks), its own port, and
 * the production build (`next start`). Nothing of dev.db or the main E2E database
 * is touched.
 *
 * The bank is the local dynamic-UPI-QR emulator (tests/support/upiBankEmulator.ts)
 * behind UPI_EMULATOR_BASE; the adapter labels that mode MOCK. This proves RESTORA's
 * side of a direct-bank UPI checkout (QR for the server-computed amount, the page
 * polling RESTORA, the server's own status lookup, signed callbacks). Its wire
 * format is RESTORA's own: it is NOT evidence that SBI behaves the same way (that
 * needs SBI's specification and UAT access: docs/sbi-upi-integration.md).
 *
 * Run: npm run build && npm run e2e:acceptance
 * Evidence: e2e/.evidence-acceptance/acceptance-evidence.{json,md}
 */
import { defineConfig, devices } from "@playwright/test";
import { ACCEPTANCE_DB_PATH } from "./e2e/acceptance/fixture";

export const ACCEPTANCE_PORT = Number(process.env.ACCEPTANCE_E2E_PORT ?? 3230);
export const ACCEPTANCE_EMULATOR_PORT = Number(process.env.ACCEPTANCE_EMULATOR_PORT ?? 3298);
export const ACCEPTANCE_UPI = {
  apiKey: "acceptance-bank-api-key-not-real",
  merchantId: "EMU-ACCEPTANCE-0001",
  webhookSecret: "acceptance-bank-webhook-secret-not-real",
};
const DB_URL = `file:${ACCEPTANCE_DB_PATH.replace(/\\/g, "/")}`;

export default defineConfig({
  testDir: "e2e/acceptance",
  workers: 1,
  fullyParallel: false,
  timeout: 300_000,
  expect: { timeout: 20_000 },
  reporter: [["list"], ["html", { outputFolder: "e2e/.report-acceptance", open: "never" }]],
  outputDir: "e2e/.results-acceptance",
  use: { baseURL: `http://localhost:${ACCEPTANCE_PORT}`, trace: "retain-on-failure", screenshot: "only-on-failure", actionTimeout: 15_000 },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } }],
  webServer: {
    command: `npx tsx e2e/acceptance/prepare-db.ts && npx next start -p ${ACCEPTANCE_PORT}`,
    url: `http://localhost:${ACCEPTANCE_PORT}/login`,
    reuseExistingServer: false,
    timeout: 240_000,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      DATABASE_URL: DB_URL,
      NODE_ENV: "production",
      AUTH_SECRET: "acceptance-auth-secret-not-a-real-production-value-0123456789",
      // Required for the test bank emulator; startup logs it as a warning.
      ALLOW_MOCK_PROVIDERS: "true",
      PAYMENT_PROVIDER: "upi_emulator",
      UPI_EMULATOR_BASE: `http://127.0.0.1:${ACCEPTANCE_EMULATOR_PORT}`,
      UPI_EMULATOR_API_KEY: ACCEPTANCE_UPI.apiKey,
      UPI_EMULATOR_MERCHANT_ID: ACCEPTANCE_UPI.merchantId,
      UPI_EMULATOR_WEBHOOK_SECRET: ACCEPTANCE_UPI.webhookSecret,
      PUBLIC_BASE_URL: `http://localhost:${ACCEPTANCE_PORT}`,
    },
  },
});
