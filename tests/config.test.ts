import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig, normalizeDomain } from "../src/config.js";
import { FAKE_API_KEY } from "./helpers.js";

const validEnv = { FRESHDESK_DOMAIN: "acme-test", FRESHDESK_API_KEY: FAKE_API_KEY };

describe("normalizeDomain", () => {
  it.each([
    ["acme", "acme.freshdesk.com"],
    ["acme.freshdesk.com", "acme.freshdesk.com"],
    ["https://acme.freshdesk.com/", "acme.freshdesk.com"],
    ["  ACME  ", "acme.freshdesk.com"],
  ])("normalizes %j to %s", (input, expected) => {
    expect(normalizeDomain(input)).toBe(expected);
  });

  it.each([
    ["http://acme.freshdesk.com", /HTTPS/],
    ["evil.example.com", /Freshdesk subdomain/],
    ["acme.freshdesk.com.evil.com", /Freshdesk subdomain/],
    ["a.b.freshdesk.com", /Freshdesk subdomain/],
    ["acme.freshdesk.com/api", /not a valid hostname/],
    ["acme.freshdesk.com:8443", /not a valid hostname/],
    ["user@acme.freshdesk.com", /not a valid hostname/],
  ])("rejects %j", (input, message) => {
    expect(() => normalizeDomain(input)).toThrow(message);
  });
});

describe("loadConfig", () => {
  it("loads the API key and builds the HTTPS v2 base URL", () => {
    expect(loadConfig(validEnv)).toEqual({
      baseUrl: "https://acme-test.freshdesk.com/api/v2",
      apiKey: FAKE_API_KEY,
      timeoutMs: 10_000,
      maxRetries: 3,
    });
  });

  it("accepts optional tuning values", () => {
    const config = loadConfig({ ...validEnv, FRESHDESK_TIMEOUT_MS: "2500", FRESHDESK_MAX_RETRIES: "0" });
    expect(config.timeoutMs).toBe(2500);
    expect(config.maxRetries).toBe(0);
  });

  it("fails clearly when the API key is missing", () => {
    expect(() => loadConfig({ FRESHDESK_DOMAIN: "acme-test" })).toThrow(/FRESHDESK_API_KEY is not set/);
  });

  it("fails clearly when the domain is missing", () => {
    expect(() => loadConfig({ FRESHDESK_API_KEY: FAKE_API_KEY })).toThrow(/FRESHDESK_DOMAIN is not set/);
  });

  it("reports every problem at once", () => {
    expect.assertions(4);
    try {
      loadConfig({ FRESHDESK_TIMEOUT_MS: "abc" });
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      const message = (error as Error).message;
      expect(message).toMatch(/FRESHDESK_DOMAIN is not set/);
      expect(message).toMatch(/FRESHDESK_API_KEY is not set/);
      expect(message).toMatch(/FRESHDESK_TIMEOUT_MS must be an integer/);
    }
  });

  it("rejects the placeholder values copied from .env.example", () => {
    expect(() => loadConfig({ FRESHDESK_DOMAIN: "your-company", FRESHDESK_API_KEY: "your-api-key-here" })).toThrow(
      /FRESHDESK_DOMAIN still has the placeholder[\s\S]*FRESHDESK_API_KEY still has the placeholder/,
    );
  });

  it.each(["1", "61000", "10.5", "-3"])("rejects out-of-range timeout %s", (value) => {
    expect(() => loadConfig({ ...validEnv, FRESHDESK_TIMEOUT_MS: value })).toThrow(/FRESHDESK_TIMEOUT_MS/);
  });

  it("never includes the API key in error messages", () => {
    const badKey = "secretKeyWith:colon";
    let message = "";
    try {
      loadConfig({ FRESHDESK_DOMAIN: "http://bad", FRESHDESK_API_KEY: badKey });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/FRESHDESK_API_KEY contains/);
    expect(message).not.toContain(badKey);
  });
});
