// Mock adapters approve anything, so no provider factory may hand one out in production by accident.
import { afterEach, describe, expect, it } from "vitest";
import { getAggregatorProvider } from "@/integrations/aggregator";
import { getPaymentProvider } from "@/integrations/payment";
import { getPOSProvider } from "@/integrations/pos";
import { ProviderUnavailableError } from "@/integrations/policy";

const env = process.env as Record<string, string | undefined>;
const saved = { NODE_ENV: env.NODE_ENV, ALLOW_MOCK_PROVIDERS: env.ALLOW_MOCK_PROVIDERS };
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
});

describe("mock providers in production", () => {
  it("every factory refuses its mock in production", () => {
    env.NODE_ENV = "production";
    delete env.ALLOW_MOCK_PROVIDERS;
    expect(() => getPaymentProvider("mock")).toThrow(ProviderUnavailableError);
    expect(() => getPOSProvider("mock")).toThrow(ProviderUnavailableError);
    expect(() => getAggregatorProvider("zomato")).toThrow(ProviderUnavailableError);
    expect(() => getAggregatorProvider()).toThrow(ProviderUnavailableError);
  });

  it("only an explicit ALLOW_MOCK_PROVIDERS=true opts a non-public production deployment in", () => {
    env.NODE_ENV = "production";
    env.ALLOW_MOCK_PROVIDERS = "true";
    expect(getAggregatorProvider("swiggy").mode).toBe("MOCK");
    env.ALLOW_MOCK_PROVIDERS = "1";
    expect(() => getAggregatorProvider("swiggy")).toThrow(ProviderUnavailableError);
  });

  it("outside production the mock stays available for development and tests", () => {
    env.NODE_ENV = "test";
    expect(getAggregatorProvider("zomato").mode).toBe("MOCK");
    expect(getPaymentProvider("mock").name).toBe("mock");
  });
});
