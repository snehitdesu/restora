/**
 * Phase 5B — production environment validation.
 *
 * validateProductionEnv fails fast when required production configuration is
 * missing or unsafe, is a no-op for development/test, and NEVER echoes a secret
 * value in its error.
 */
import { describe, it, expect } from "vitest";
import { validateProductionEnv, EnvValidationError, DEV_AUTH_SECRET_PLACEHOLDER } from "@/server/config/env";

const GOOD_SECRET = "a-sufficiently-long-production-secret-value-0123456789";
const prod = (over: Record<string, string | undefined> = {}): NodeJS.ProcessEnv => ({
  NODE_ENV: "production",
  DATABASE_URL: "file:./prod.db",
  AUTH_SECRET: GOOD_SECRET,
  ...over,
});

describe("production environment validation", () => {
  it("passes for a valid production configuration", () => {
    expect(() => validateProductionEnv(prod())).not.toThrow();
  });

  it("fails when DATABASE_URL is missing", () => {
    expect(() => validateProductionEnv(prod({ DATABASE_URL: undefined }))).toThrow(EnvValidationError);
    expect(() => validateProductionEnv(prod({ DATABASE_URL: "" }))).toThrow(/DATABASE_URL/);
  });

  it("fails when AUTH_SECRET is missing", () => {
    expect(() => validateProductionEnv(prod({ AUTH_SECRET: undefined }))).toThrow(/AUTH_SECRET is required/);
  });

  it("fails when AUTH_SECRET uses the insecure dev placeholder", () => {
    expect(() => validateProductionEnv(prod({ AUTH_SECRET: DEV_AUTH_SECRET_PLACEHOLDER }))).toThrow(/AUTH_SECRET must not use the development placeholder/);
  });

  it("fails when AUTH_SECRET is too short", () => {
    expect(() => validateProductionEnv(prod({ AUTH_SECRET: "tooshort" }))).toThrow(/at least 32 characters/);
  });

  it("fails when rate limiting is disabled in production", () => {
    expect(() => validateProductionEnv(prod({ RATE_LIMIT_DISABLED: "true" }))).toThrow(/RATE_LIMIT_DISABLED/);
  });

  it("fails when SESSION_TTL_SECONDS is not a positive integer", () => {
    expect(() => validateProductionEnv(prod({ SESSION_TTL_SECONDS: "0" }))).toThrow(/SESSION_TTL_SECONDS/);
    expect(() => validateProductionEnv(prod({ SESSION_TTL_SECONDS: "-1" }))).toThrow(/SESSION_TTL_SECONDS/);
    expect(() => validateProductionEnv(prod({ SESSION_TTL_SECONDS: "abc" }))).toThrow(/SESSION_TTL_SECONDS/);
  });

  it("fails when a shutdown timing is not a whole number of milliseconds in range", () => {
    for (const name of ["SHUTDOWN_DELAY_MS", "SHUTDOWN_REFUSE_GRACE_MS"]) {
      expect(() => validateProductionEnv(prod({ [name]: "-1" }))).toThrow(new RegExp(name));
      expect(() => validateProductionEnv(prod({ [name]: "soon" }))).toThrow(new RegExp(name));
      expect(() => validateProductionEnv(prod({ [name]: "0" }))).not.toThrow();
    }
    expect(() => validateProductionEnv(prod({ SHUTDOWN_REFUSE_GRACE_MS: "600000" }))).toThrow(/SHUTDOWN_REFUSE_GRACE_MS/);
  });

  it("is a no-op in development and test, even with unsafe values", () => {
    expect(() => validateProductionEnv({ NODE_ENV: "development", AUTH_SECRET: DEV_AUTH_SECRET_PLACEHOLDER })).not.toThrow();
    expect(() => validateProductionEnv({ NODE_ENV: "test" })).not.toThrow();
    expect(() => validateProductionEnv({} as NodeJS.ProcessEnv)).not.toThrow();
  });

  it("never leaks the secret value in the error", () => {
    let message = "";
    try {
      validateProductionEnv(prod({ AUTH_SECRET: DEV_AUTH_SECRET_PLACEHOLDER }));
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).not.toContain(DEV_AUTH_SECRET_PLACEHOLDER);
  });

  it("reports every problem at once", () => {
    try {
      validateProductionEnv(prod({ DATABASE_URL: "", AUTH_SECRET: "", RATE_LIMIT_DISABLED: "true" }));
      throw new Error("expected validation to fail");
    } catch (e) {
      const message = (e as Error).message;
      expect(message).toContain("DATABASE_URL");
      expect(message).toContain("AUTH_SECRET");
      expect(message).toContain("RATE_LIMIT_DISABLED");
    }
  });
});
