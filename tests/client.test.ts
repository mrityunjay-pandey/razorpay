import { inspect } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { FreshdeskClient } from "../src/freshdesk/client.js";
import { ConnectorError } from "../src/middleware/errors.js";
import { FAKE_API_KEY, jsonResponse, mockFetch, requestedUrl, requestInit, testConfig } from "./helpers.js";

async function captureError(promise: Promise<unknown>): Promise<ConnectorError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ConnectorError) return error;
    throw error;
  }
  throw new Error("expected the request to fail");
}

describe("FreshdeskClient request construction", () => {
  it("sends Basic auth with the API key as username and X as password", async () => {
    const fetchMock = mockFetch(jsonResponse({ id: 1 }));
    await new FreshdeskClient(testConfig, { fetch: fetchMock }).get("/tickets/1");

    const headers = requestInit(fetchMock).headers as Record<string, string>;
    const expected = Buffer.from(`${FAKE_API_KEY}:X`).toString("base64");
    expect(headers.Authorization).toBe(`Basic ${expected}`);
    expect(headers.Accept).toBe("application/json");
  });

  it("uses GET, refuses redirects and sets a timeout signal", async () => {
    const fetchMock = mockFetch(jsonResponse({}));
    await new FreshdeskClient(testConfig, { fetch: fetchMock }).get("/tickets");

    const init = requestInit(fetchMock);
    expect(init.method).toBe("GET");
    expect(init.redirect).toBe("manual");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("builds the URL with %20-encoded query values and skips undefined params", async () => {
    const fetchMock = mockFetch(jsonResponse({ results: [], total: 0 }));
    await new FreshdeskClient(testConfig, { fetch: fetchMock }).get("/search/tickets", {
      query: { query: '"status:2 AND priority:3"', page: 2, unused: undefined },
    });

    expect(requestedUrl(fetchMock)).toBe(
      "https://acme-test.freshdesk.com/api/v2/search/tickets?query=%22status%3A2%20AND%20priority%3A3%22&page=2",
    );
  });

  it.each(["tickets", "/tickets/../admin", "/tickets?x=1", "//evil.com/x", "https://evil.com", "/tickets/1/"])(
    "refuses unsafe path %j without calling fetch",
    async (path) => {
      const fetchMock = mockFetch();
      await expect(new FreshdeskClient(testConfig, { fetch: fetchMock }).get(path)).rejects.toThrow(/unsafe Freshdesk API path/);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );
});

describe("FreshdeskClient successful responses", () => {
  it("returns parsed data, pagination and rate-limit metadata", async () => {
    const fetchMock = mockFetch(
      jsonResponse([{ id: 1 }, { id: 2 }], {
        headers: {
          Link: '<https://acme-test.freshdesk.com/api/v2/tickets?page=2>; rel="next"',
          "X-RateLimit-Total": "400",
          "X-RateLimit-Remaining": "398",
        },
      }),
    );
    const result = await new FreshdeskClient(testConfig, { fetch: fetchMock }).get<{ id: number }[]>("/tickets");

    expect(result.data).toEqual([{ id: 1 }, { id: 2 }]);
    expect(result.hasNextPage).toBe(true);
    expect(result.rateLimit).toEqual({ total: 400, remaining: 398 });
  });

  it("reports no next page when the Link header is absent", async () => {
    const result = await new FreshdeskClient(testConfig, { fetch: mockFetch(jsonResponse([])) }).get("/tickets");
    expect(result.hasNextPage).toBe(false);
    expect(result.rateLimit).toEqual({ total: undefined, remaining: undefined });
  });

  it("treats a non-JSON 200 body as an upstream error", async () => {
    const fetchMock = mockFetch(new Response("<html>maintenance</html>", { status: 200 }));
    const error = await captureError(new FreshdeskClient(testConfig, { fetch: fetchMock }).get("/tickets"));
    expect(error.code).toBe("UPSTREAM_ERROR");
    expect(error.message).not.toContain("<html>");
  });
});

describe("FreshdeskClient error normalization", () => {
  it.each([
    [401, "AUTHENTICATION_ERROR", false],
    [403, "PERMISSION_DENIED", false],
    [404, "NOT_FOUND", false],
    [405, "UPSTREAM_ERROR", false],
    [500, "UPSTREAM_ERROR", true],
    [502, "UPSTREAM_ERROR", true],
    [503, "UPSTREAM_ERROR", true],
    [504, "UPSTREAM_ERROR", true],
    [501, "UPSTREAM_ERROR", false],
  ] as const)("maps HTTP %i to %s (retryable=%s)", async (status, code, retryable) => {
    const fetchMock = mockFetch(jsonResponse({ description: "x" }, { status }));
    const error = await captureError(new FreshdeskClient(testConfig, { fetch: fetchMock }).get("/tickets/1"));
    expect(error.code).toBe(code);
    expect(error.status).toBe(status);
    expect(error.retryable).toBe(retryable);
  });

  it("surfaces Freshdesk's field-level validation messages on 400", async () => {
    const body = {
      description: "Validation failed",
      errors: [{ field: "query", message: "Invalid query format", code: "invalid_value" }],
    };
    const fetchMock = mockFetch(jsonResponse(body, { status: 400 }));
    const error = await captureError(new FreshdeskClient(testConfig, { fetch: fetchMock }).get("/search/tickets"));
    expect(error.code).toBe("INVALID_REQUEST");
    expect(error.message).toBe("Freshdesk rejected the request: Validation failed; query: Invalid query format");
  });

  it("uses the caller's not-found message on 404", async () => {
    const fetchMock = mockFetch(jsonResponse({}, { status: 404 }));
    const error = await captureError(
      new FreshdeskClient(testConfig, { fetch: fetchMock }).get("/tickets/12345", {
        notFoundMessage: "The Freshdesk ticket with ID 12345 was not found.",
      }),
    );
    expect(error.message).toBe("The Freshdesk ticket with ID 12345 was not found.");
  });

  it("classifies 429 as retryable RATE_LIMITED and reads Retry-After", async () => {
    const fetchMock = mockFetch(jsonResponse({}, { status: 429, headers: { "Retry-After": "37" } }));
    const error = await captureError(new FreshdeskClient(testConfig, { fetch: fetchMock }).get("/tickets"));
    expect(error.code).toBe("RATE_LIMITED");
    expect(error.retryable).toBe(true);
    expect(error.retryAfterSeconds).toBe(37);
    expect(error.message).toMatch(/retry after 37 seconds/);
  });

  it("does not echo an HTML error page to the agent", async () => {
    const fetchMock = mockFetch(new Response("<html><body>Bad Gateway from proxy-17</body></html>", { status: 502 }));
    const error = await captureError(new FreshdeskClient(testConfig, { fetch: fetchMock }).get("/tickets"));
    expect(error.message).toBe("Freshdesk returned a server error (HTTP 502). Try again later.");
  });

  it("treats a redirect as a configuration error instead of following it", async () => {
    const fetchMock = mockFetch(new Response(null, { status: 302, headers: { Location: "https://elsewhere.example" } }));
    const error = await captureError(new FreshdeskClient(testConfig, { fetch: fetchMock }).get("/tickets"));
    expect(error.code).toBe("CONFIGURATION_ERROR");
  });

  it("maps a network failure to retryable NETWORK_ERROR", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError("fetch failed"));
    const error = await captureError(new FreshdeskClient(testConfig, { fetch: fetchMock }).get("/tickets"));
    expect(error.code).toBe("NETWORK_ERROR");
    expect(error.retryable).toBe(true);
    expect(error.message).toBe("Could not reach Freshdesk (network or DNS failure).");
  });

  it("maps a timeout to NETWORK_ERROR with the configured timeout", async () => {
    const timeout = new DOMException("The operation was aborted due to timeout", "TimeoutError");
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValueOnce(timeout);
    const error = await captureError(new FreshdeskClient(testConfig, { fetch: fetchMock }).get("/tickets"));
    expect(error.code).toBe("NETWORK_ERROR");
    expect(error.message).toBe("Freshdesk did not respond within 5000 ms.");
  });
});

describe("credential hygiene", () => {
  const encodedKey = Buffer.from(`${FAKE_API_KEY}:X`).toString("base64");

  it("never includes the API key in errors or logs", async () => {
    const logs: string[] = [];
    const logger = (_level: string, event: string, fields?: Record<string, unknown>) => {
      logs.push(JSON.stringify({ event, ...fields }));
    };
    const statuses = [400, 401, 403, 404, 429, 500];
    const fetchMock = mockFetch(...statuses.map((status) => jsonResponse({ description: "nope" }, { status })));
    const client = new FreshdeskClient(testConfig, { fetch: fetchMock, logger });

    for (let i = 0; i < statuses.length; i++) {
      const error = await captureError(client.get("/tickets", { query: { email: "jane@example.test" } }));
      const serialized = `${error.message} ${JSON.stringify(error)} ${inspect(error)}`;
      expect(serialized).not.toContain(FAKE_API_KEY);
      expect(serialized).not.toContain(encodedKey);
    }

    expect(logs).toHaveLength(statuses.length);
    for (const line of logs) {
      expect(line).not.toContain(FAKE_API_KEY);
      expect(line).not.toContain(encodedKey);
      expect(line).not.toContain("jane@example.test");
    }
  });

  it("does not expose the key when the client object is printed or serialized", () => {
    const client = new FreshdeskClient(testConfig);
    const printed = `${inspect(client, { depth: 5 })} ${JSON.stringify(client)}`;
    expect(printed).not.toContain(FAKE_API_KEY);
    expect(printed).not.toContain(encodedKey);
  });
});

