import { vi } from "vitest";
import type { FreshdeskConfig } from "../src/config.js";

/** Obviously fake credential; tests assert it never leaks into errors or logs. */
export const FAKE_API_KEY = "fakeKey0123456789TEST";

/** Retries disabled so each test sees exactly one HTTP exchange; retry behaviour has its own tests. */
export const testConfig: FreshdeskConfig = {
  baseUrl: "https://acme-test.freshdesk.com/api/v2",
  apiKey: FAKE_API_KEY,
  timeoutMs: 5_000,
  maxRetries: 0,
};

export function jsonResponse(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "Content-Type": "application/json", ...init.headers },
  });
}

/** A fetch mock that returns the given responses in order. */
export function mockFetch(...responses: Response[]) {
  const fn = vi.fn<typeof fetch>();
  for (const response of responses) fn.mockResolvedValueOnce(response);
  return fn;
}

export function requestedUrl(fetchMock: ReturnType<typeof mockFetch>, call = 0): string {
  return String(fetchMock.mock.calls[call]?.[0]);
}

export function requestInit(fetchMock: ReturnType<typeof mockFetch>, call = 0): RequestInit {
  return fetchMock.mock.calls[call]?.[1] ?? {};
}
