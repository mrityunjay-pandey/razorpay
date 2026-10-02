import type { FreshdeskConfig } from "../config.js";
import { silentLogger, type Logger } from "../logger.js";
import { ConnectorError, errorFromHttpStatus } from "../middleware/errors.js";
import {
  DEFAULT_RETRY_POLICY,
  parseRetryAfter,
  withRetry,
  type RetryDeps,
  type RetryPolicy,
} from "../middleware/rateLimiter.js";

export type QueryParams = Record<string, string | number | boolean | undefined>;

export interface GetOptions {
  query?: QueryParams;
  /** Agent-facing message used when Freshdesk answers 404. */
  notFoundMessage?: string;
}

export interface RateLimitInfo {
  total: number | undefined;
  remaining: number | undefined;
}

export interface FreshdeskResponse<T> {
  data: T;
  /** True when Freshdesk's Link header advertises a rel="next" page. */
  hasNextPage: boolean;
  rateLimit: RateLimitInfo;
}

export interface FreshdeskClientDeps {
  fetch?: typeof fetch;
  logger?: Logger;
  /** Overrides for the retry policy; maxRetries otherwise comes from config. */
  retryPolicy?: Partial<RetryPolicy>;
  /** Injectable sleep/random/clock, for deterministic tests. */
  retry?: Omit<RetryDeps, "onRetry">;
}

const LOW_QUOTA_RATIO = 0.1;

/** Relative API paths only: letters, digits, "_", "-" and "/". Rules out "..", "?", "//host" and absolute URLs. */
const SAFE_PATH = /^(\/[A-Za-z0-9_-]+)+$/;

/**
 * The single place that talks HTTP to Freshdesk. It exposes GET only: the
 * connector is read-only by construction, not by a deny-list.
 */
export class FreshdeskClient {
  readonly #authorization: string;
  readonly #baseUrl: string;
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;
  readonly #log: Logger;
  readonly #retryPolicy: RetryPolicy;
  readonly #retryDeps: Omit<RetryDeps, "onRetry">;

  constructor(config: FreshdeskConfig, deps: FreshdeskClientDeps = {}) {
    // Freshdesk API-key auth: HTTP Basic with the key as username and "X" as password.
    this.#authorization = `Basic ${Buffer.from(`${config.apiKey}:X`).toString("base64")}`;
    this.#baseUrl = config.baseUrl;
    this.#timeoutMs = config.timeoutMs;
    this.#fetch = deps.fetch ?? globalThis.fetch;
    this.#log = deps.logger ?? silentLogger;
    this.#retryPolicy = {
      ...DEFAULT_RETRY_POLICY,
      maxRetries: config.maxRetries,
      attemptTimeoutMs: config.timeoutMs,
      ...deps.retryPolicy,
    };
    this.#retryDeps = deps.retry ?? {};
  }

  /** GET with rate-limit and transient-failure retries. The URL is validated once, before any attempt. */
  async get<T>(path: string, options: GetOptions = {}): Promise<FreshdeskResponse<T>> {
    const url = this.#buildUrl(path, options.query);
    return withRetry(() => this.#sendOnce<T>(url, path, options), this.#retryPolicy, {
      ...this.#retryDeps,
      onRetry: ({ attempt, delayMs, error }) =>
        this.#log("warn", "freshdesk_retry", { path, attempt, delayMs, code: error.code, status: error.status }),
    });
  }

  async #sendOnce<T>(url: string, path: string, options: GetOptions): Promise<FreshdeskResponse<T>> {
    const startedAt = Date.now();

    let response: Response;
    try {
      response = await this.#fetch(url, {
        method: "GET",
        headers: { Authorization: this.#authorization, Accept: "application/json" },
        // A redirect would mean a misconfigured domain; never follow it with credentials attached.
        redirect: "manual",
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (error) {
      throw this.#networkError(error, path);
    }

    try {
      const result = await this.#handleResponse<T>(response, options);
      this.#warnIfQuotaLow(path, result.rateLimit);
      return result;
    } catch (error) {
      if (error instanceof ConnectorError) {
        // Path and status only: query values can contain customer emails, headers contain the key.
        this.#log("warn", "freshdesk_request_failed", {
          path,
          status: response.status,
          code: error.code,
          durationMs: Date.now() - startedAt,
        });
      }
      throw error;
    }
  }

  /** Freshdesk limits are account-wide, so other integrations share this budget; surface it early. */
  #warnIfQuotaLow(path: string, { total, remaining }: RateLimitInfo): void {
    if (total !== undefined && remaining !== undefined && total > 0 && remaining / total < LOW_QUOTA_RATIO) {
      this.#log("warn", "freshdesk_rate_limit_low", { path, remaining, total });
    }
  }

  #buildUrl(path: string, query: QueryParams = {}): string {
    if (!SAFE_PATH.test(path)) {
      throw new Error(`Refusing to request unsafe Freshdesk API path: ${path}`);
    }
    // encodeURIComponent (not URLSearchParams) so spaces become %20, as Freshdesk's search docs show.
    const search = Object.entries(query)
      .filter((entry): entry is [string, string | number | boolean] => entry[1] !== undefined)
      .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
      .join("&");
    return `${this.#baseUrl}${path}${search ? `?${search}` : ""}`;
  }

  async #handleResponse<T>(response: Response, options: GetOptions): Promise<FreshdeskResponse<T>> {
    const { status, headers } = response;

    if (status >= 300 && status < 400) {
      throw new ConnectorError(
        "CONFIGURATION_ERROR",
        "Freshdesk redirected the request, which usually means FRESHDESK_DOMAIN is wrong or the helpdesk has moved.",
        { status },
      );
    }

    const text = await response.text().catch(() => "");

    if (!response.ok) {
      throw errorFromHttpStatus(status, safeJsonParse(text), {
        notFoundMessage: options.notFoundMessage,
        retryAfterSeconds: parseRetryAfter(headers.get("retry-after")),
      });
    }

    const data = safeJsonParse(text);
    if (data === undefined) {
      throw new ConnectorError("UPSTREAM_ERROR", "Freshdesk returned a response that was not valid JSON.", { status });
    }

    return {
      data: data as T,
      hasNextPage: /rel="?next"?/i.test(headers.get("link") ?? ""),
      rateLimit: {
        total: parseOptionalInt(headers.get("x-ratelimit-total")),
        remaining: parseOptionalInt(headers.get("x-ratelimit-remaining")),
      },
    };
  }

  #networkError(error: unknown, path: string): ConnectorError {
    const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    this.#log("warn", "freshdesk_network_error", {
      path,
      timedOut,
      reason: error instanceof Error ? error.message : String(error),
    });
    return new ConnectorError(
      "NETWORK_ERROR",
      timedOut
        ? `Freshdesk did not respond within ${this.#timeoutMs} ms.`
        : "Could not reach Freshdesk (network or DNS failure).",
      { retryable: true },
    );
  }
}

function safeJsonParse(text: string): unknown {
  if (text === "") return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function parseOptionalInt(value: string | null): number | undefined {
  if (value === null) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? undefined : parsed;
}
