import { describe, expect, it, vi } from "vitest";
import { FreshdeskClient } from "../src/freshdesk/client.js";
import { ConnectorError } from "../src/middleware/errors.js";
import {
  backoffDelayMs,
  DEFAULT_RETRY_POLICY,
  parseRetryAfter,
  withRetry,
  type RetryPolicy,
} from "../src/middleware/rateLimiter.js";
import { jsonResponse, mockFetch, testConfig } from "./helpers.js";

const policy: RetryPolicy = { ...DEFAULT_RETRY_POLICY, maxRetries: 3 };

const rateLimited = (retryAfterSeconds?: number) =>
  new ConnectorError("RATE_LIMITED", "Freshdesk's API rate limit was exceeded.", { status: 429, retryable: true, retryAfterSeconds });
const serverError = () => new ConnectorError("UPSTREAM_ERROR", "Freshdesk returned a server error (HTTP 503).", { status: 503, retryable: true });

/** Deterministic deps: sleeps are recorded and advance a fake clock instead of waiting. */
function fakeTime(random = () => 0.5) {
  let clock = 0;
  const sleeps: number[] = [];
  return {
    sleeps,
    advance: (ms: number) => (clock += ms),
    deps: {
      sleep: async (ms: number) => {
        sleeps.push(ms);
        clock += ms;
      },
      random,
      now: () => clock,
    },
  };
}

async function captureError(promise: Promise<unknown>): Promise<ConnectorError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ConnectorError) return error;
    throw error;
  }
  throw new Error("expected failure");
}

describe("parseRetryAfter", () => {
  it("parses delta-seconds", () => {
    expect(parseRetryAfter("30")).toBe(30);
  });

  it("parses an HTTP-date relative to now", () => {
    const now = Date.parse("2026-01-01T00:00:00Z");
    expect(parseRetryAfter("Thu, 01 Jan 2026 00:00:45 GMT", now)).toBe(45);
  });

  it("clamps a date in the past to zero", () => {
    const now = Date.parse("2026-01-01T00:01:00Z");
    expect(parseRetryAfter("Thu, 01 Jan 2026 00:00:00 GMT", now)).toBe(0);
  });

  it.each([null, "", "soon", "-5", "1.5", "2026-01-01"])("returns undefined for %j", (value) => {
    expect(parseRetryAfter(value)).toBeUndefined();
  });
});

describe("backoffDelayMs (full jitter)", () => {
  it("doubles the ceiling each attempt", () => {
    const max = () => 0.999_999;
    expect([0, 1, 2, 3].map((attempt) => backoffDelayMs(attempt, policy, max))).toEqual([499, 999, 1999, 3999]);
  });

  it("never exceeds maxDelayMs", () => {
    expect(backoffDelayMs(10, policy, () => 0.999_999)).toBeLessThan(policy.maxDelayMs);
  });

  it("is randomized within [0, ceiling)", () => {
    expect(backoffDelayMs(2, policy, () => 0)).toBe(0);
    expect(backoffDelayMs(2, policy, () => 0.5)).toBe(1000);
  });
});

describe("withRetry", () => {
  it("returns immediately on success", async () => {
    const time = fakeTime();
    const op = vi.fn().mockResolvedValue("ok");
    await expect(withRetry(op, policy, time.deps)).resolves.toBe("ok");
    expect(op).toHaveBeenCalledTimes(1);
    expect(time.sleeps).toEqual([]);
  });

  it("waits exactly Retry-After seconds, then succeeds", async () => {
    const time = fakeTime();
    const op = vi.fn().mockRejectedValueOnce(rateLimited(7)).mockResolvedValueOnce("ok");
    await expect(withRetry(op, policy, time.deps)).resolves.toBe("ok");
    expect(time.sleeps).toEqual([7_000]);
  });

  it("uses exponential backoff when Retry-After is absent", async () => {
    const time = fakeTime(() => 0.5);
    const op = vi
      .fn()
      .mockRejectedValueOnce(rateLimited())
      .mockRejectedValueOnce(rateLimited())
      .mockRejectedValueOnce(serverError())
      .mockResolvedValueOnce("ok");
    await expect(withRetry(op, policy, time.deps)).resolves.toBe("ok");
    expect(time.sleeps).toEqual([250, 500, 1000]);
  });

  it("stops after maxRetries and returns a controlled RATE_LIMITED error", async () => {
    const time = fakeTime();
    const op = vi.fn().mockRejectedValue(rateLimited(1));
    const error = await captureError(withRetry(op, policy, time.deps));

    expect(op).toHaveBeenCalledTimes(4);
    expect(time.sleeps).toEqual([1_000, 1_000, 1_000]);
    expect(error.code).toBe("RATE_LIMITED");
    expect(error.retryable).toBe(true);
    expect(error.retryAfterSeconds).toBe(1);
    expect(error.message).toBe("Freshdesk's API rate limit was exceeded. The connector retried 3 times without success.");
  });

  it.each([
    new ConnectorError("AUTHENTICATION_ERROR", "bad key", { status: 401 }),
    new ConnectorError("PERMISSION_DENIED", "no", { status: 403 }),
    new ConnectorError("NOT_FOUND", "missing", { status: 404 }),
    new ConnectorError("INVALID_REQUEST", "bad query", { status: 400 }),
    new ConnectorError("VALIDATION_ERROR", "bad input"),
    new Error("programming error"),
  ])("does not retry non-retryable error %#", async (failure) => {
    const time = fakeTime();
    const op = vi.fn().mockRejectedValue(failure);
    await expect(withRetry(op, policy, time.deps)).rejects.toBe(failure);
    expect(op).toHaveBeenCalledTimes(1);
    expect(time.sleeps).toEqual([]);
  });

  it("fails fast instead of sleeping past the time budget", async () => {
    const time = fakeTime();
    const op = vi.fn().mockRejectedValue(rateLimited(3_600));
    const error = await captureError(withRetry(op, policy, time.deps));

    expect(op).toHaveBeenCalledTimes(1);
    expect(time.sleeps).toEqual([]);
    expect(error.retryAfterSeconds).toBe(3_600);
    expect(error.message).toMatch(/exceed the connector's time budget/);
  });

  it("counts time spent in attempts, not just sleeps, against the budget", async () => {
    const time = fakeTime();
    // Each attempt takes 20 s (e.g. slow timeouts); after two, a 10 s wait would cross the 45 s budget.
    const op = vi.fn().mockImplementation(async () => {
      time.advance(20_000);
      throw rateLimited(2);
    });
    const error = await captureError(withRetry(op, policy, time.deps));
    expect(op).toHaveBeenCalledTimes(3);
    expect(time.sleeps).toEqual([2_000, 2_000]);
    expect(error.message).toMatch(/time budget/);
  });

  it("returns the original error unchanged when retries are disabled", async () => {
    const failure = rateLimited(5);
    const op = vi.fn().mockRejectedValue(failure);
    await expect(withRetry(op, { ...policy, maxRetries: 0 }, fakeTime().deps)).rejects.toBe(failure);
  });
});

describe("FreshdeskClient retries (mocked HTTP)", () => {
  function clientWith(fetchMock: ReturnType<typeof mockFetch>, random = () => 0.5) {
    const time = fakeTime(random);
    const logs: { event: string; fields?: Record<string, unknown> }[] = [];
    const client = new FreshdeskClient(
      { ...testConfig, maxRetries: 3 },
      { fetch: fetchMock, retry: time.deps, logger: (_level, event, fields) => logs.push({ event, fields }) },
    );
    return { client, time, logs };
  }

  it("429 + Retry-After: waits the advertised time and succeeds on retry", async () => {
    const fetchMock = mockFetch(
      jsonResponse({}, { status: 429, headers: { "Retry-After": "2" } }),
      jsonResponse([{ id: 1 }]),
    );
    const { client, time, logs } = clientWith(fetchMock);

    const result = await client.get("/tickets");

    expect(result.data).toEqual([{ id: 1 }]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(time.sleeps).toEqual([2_000]);
    expect(logs).toContainEqual({
      event: "freshdesk_retry",
      fields: { path: "/tickets", attempt: 1, delayMs: 2_000, code: "RATE_LIMITED", status: 429 },
    });
  });

  it("429 without Retry-After: backs off exponentially and gives up after the retry limit", async () => {
    const fetchMock = mockFetch(...Array.from({ length: 4 }, () => jsonResponse({}, { status: 429 })));
    const { client, time } = clientWith(fetchMock);

    const error = await captureError(client.get("/tickets"));

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(time.sleeps).toEqual([250, 500, 1000]);
    expect(error.code).toBe("RATE_LIMITED");
    expect(error.message).toMatch(/retried 3 times/);
  });

  it("retries a transient 503 and a network failure, then succeeds", async () => {
    const fetchMock = mockFetch(jsonResponse({}, { status: 503 }));
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: 9 }));
    const { client } = clientWith(fetchMock);

    await expect(client.get("/tickets/9")).resolves.toMatchObject({ data: { id: 9 } });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it.each([400, 401, 403, 404])("does not retry HTTP %i", async (status) => {
    const fetchMock = mockFetch(jsonResponse({}, { status }));
    const { client, time } = clientWith(fetchMock);
    await expect(client.get("/tickets/1")).rejects.toBeInstanceOf(ConnectorError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(time.sleeps).toEqual([]);
  });

  it("works with the real timer-based sleep (no injected deps)", async () => {
    const fetchMock = mockFetch(jsonResponse({}, { status: 502 }), jsonResponse({ id: 3 }));
    const client = new FreshdeskClient({ ...testConfig, maxRetries: 1 }, { fetch: fetchMock, retryPolicy: { baseDelayMs: 5 } });
    await expect(client.get("/tickets/3")).resolves.toMatchObject({ data: { id: 3 } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("warns when the remaining account-wide quota drops below 10%", async () => {
    const fetchMock = mockFetch(jsonResponse([], { headers: { "X-RateLimit-Total": "400", "X-RateLimit-Remaining": "12" } }));
    const { client, logs } = clientWith(fetchMock);
    await client.get("/tickets");
    expect(logs).toContainEqual({ event: "freshdesk_rate_limit_low", fields: { path: "/tickets", remaining: 12, total: 400 } });
  });

  it("does not warn when quota is healthy", async () => {
    const fetchMock = mockFetch(jsonResponse([], { headers: { "X-RateLimit-Total": "400", "X-RateLimit-Remaining": "300" } }));
    const { client, logs } = clientWith(fetchMock);
    await client.get("/tickets");
    expect(logs).toEqual([]);
  });
});
