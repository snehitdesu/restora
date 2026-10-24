/**
 * Investor acceptance E2E: the real Coders' Cafe menu, Table T07's QR, owner /
 * manager / chef / customer in separate browser contexts, a bank UPI QR
 * (success, decline + a new QR) and counter cash, against the PRODUCTION build
 * (`next start`).
 *
 * Isolated from the main suite: its own database (prisma/e2e-investor.db,
 * rebuilt every run by e2e/investor/prepare-db.ts: migrations + the Coders'
 * Cafe dataset + the bank's merchant binding) and port. The bank is the local
 * dynamic-UPI-QR emulator the spec starts (tests/support/upiBankEmulator.ts)
 * behind UPI_EMULATOR_BASE; the adapter labels that mode MOCK. It is RESTORA's
 * own test format, not SBI's: nothing here is SBI UAT evidence.
 *
 * Run: npm run build && npm run e2e:investor
 */
import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

export const INVESTOR_PORT = Number(process.env.INVESTOR_E2E_PORT ?? 3220);
export const EMULATOR_PORT = Number(process.env.UPI_EMULATOR_PORT ?? 3299);
export const INVESTOR_UPI = {
  apiKey: "investor-e2e-bank-api-key-not-real",
  merchantId: "EMU-INVESTOR-E2E-01",
  webhookSecret: "investor-e2e-bank-webhook-secret-not-real",
};
export const INVESTOR_DB_URL = `file:${path.join(process.cwd(), "prisma", "e2e-investor.db").replace(/\\/g, "/")}`;
const DB_URL = INVESTOR_DB_URL;

export default defineConfig({
  testDir: "e2e/investor",
  workers: 1,
  fullyParallel: false,
  timeout: 180_000,
  expect: { timeout: 20_000 },
  reporter: [["list"], ["html", { outputFolder: "e2e/.report-investor", open: "never" }]],
  outputDir: "e2e/.results-investor",
  use: { baseURL: `http://localhost:${INVESTOR_PORT}`, trace: "retain-on-failure", screenshot: "only-on-failure", actionTimeout: 15_000 },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } }],
  webServer: {
    command: `npx tsx e2e/investor/prepare-db.ts && npx next start -p ${INVESTOR_PORT}`,
    url: `http://localhost:${INVESTOR_PORT}/login`,
    reuseExistingServer: false,
    timeout: 240_000,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      DATABASE_URL: DB_URL,
      NODE_ENV: "production",
      AUTH_SECRET: "investor-e2e-auth-secret-not-a-real-production-value-0123456789",
      // Required for the test bank emulator; startup logs it as a warning.
      ALLOW_MOCK_PROVIDERS: "true",
      PAYMENT_PROVIDER: "upi_emulator",
      UPI_EMULATOR_BASE: `http://127.0.0.1:${EMULATOR_PORT}`,
      UPI_EMULATOR_API_KEY: INVESTOR_UPI.apiKey,
      UPI_EMULATOR_MERCHANT_ID: INVESTOR_UPI.merchantId,
      UPI_EMULATOR_WEBHOOK_SECRET: INVESTOR_UPI.webhookSecret,
      PUBLIC_BASE_URL: `http://localhost:${INVESTOR_PORT}`,
    },
  },
});
