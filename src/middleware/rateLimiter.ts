import { ConnectorError } from "./errors.js";

/** RFC 9110 IMF-fixdate, e.g. "Sun, 06 Nov 1994 08:49:37 GMT". */
const IMF_FIXDATE = /^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/;

/**
 * Parses a Retry-After header into whole seconds. Freshdesk sends delta-seconds,
 * but RFC 9110 also allows an HTTP-date, so both are accepted.
 */
export function parseRetryAfter(value: string | null, now: number = Date.now()): number | undefined {
  if (value === null) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  // Date.parse alone is too lenient: it reads "-5" as the year -5.
  if (!IMF_FIXDATE.test(trimmed)) return undefined;
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, Math.ceil((date - now) / 1000));
}

export interface RetryPolicy {
  /** Retries after the first attempt; 0 disables retrying. */
  maxRetries: number;
  /** Backoff base when Freshdesk gives no Retry-After. */
  baseDelayMs: number;
  /** Ceiling for a single computed backoff delay. */
  maxDelayMs: number;
  /**
   * Wall-clock budget for the whole call, attempts included. Kept below the MCP
   * SDK's default 60 s request timeout so we never retry for a caller that has gone.
   */
  totalBudgetMs: number;
}

export const DEFAULT_RETRY_POLICY: Omit<RetryPolicy, "maxRetries"> = {
  baseDelayMs: 500,
  maxDelayMs: 8_000,
  totalBudgetMs: 45_000,
};

export interface RetryDeps {
  sleep?: (ms: number) => Promise<void>;
  /** Returns [0, 1); injectable for deterministic tests. */
  random?: () => number;
  now?: () => number;
  onRetry?: (info: { attempt: number; delayMs: number; error: ConnectorError }) => void;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Full-jitter exponential backoff: uniform in [0, min(maxDelay, base * 2^attempt)]. */
export function backoffDelayMs(attempt: number, policy: RetryPolicy, random: () => number): number {
  const ceiling = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** attempt);
  return Math.floor(random() * ceiling);
}

/** Retry-After wins when present: the server knows when its window resets. */
export function retryDelayMs(error: ConnectorError, attempt: number, policy: RetryPolicy, random: () => number): number {
  return error.retryAfterSeconds !== undefined ? error.retryAfterSeconds * 1000 : backoffDelayMs(attempt, policy, random);
}

function givingUp(error: ConnectorError, retries: number, reason: "retries" | "budget"): ConnectorError {
  const why =
    reason === "retries"
      ? `The connector retried ${retries} time${retries === 1 ? "" : "s"} without success.`
      : "Waiting longer would exceed the connector's time budget for a single request.";
  return new ConnectorError(error.code, `${error.message} ${why}`, {
    status: error.status,
    retryable: error.retryable,
    retryAfterSeconds: error.retryAfterSeconds,
  });
}

/**
 * Runs `operation`, retrying only errors marked retryable (429, transient 5xx,
 * network). Non-retryable errors (400/401/403/404, validation) fail immediately.
 */
export async function withRetry<T>(operation: () => Promise<T>, policy: RetryPolicy, deps: RetryDeps = {}): Promise<T> {
  const sleep = deps.sleep ?? defaultSleep;
  const random = deps.random ?? Math.random;
  const now = deps.now ?? Date.now;
  const deadline = now() + policy.totalBudgetMs;

  for (let attempt = 0; ; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (!(error instanceof ConnectorError) || !error.retryable) throw error;
      if (attempt >= policy.maxRetries) {
        throw policy.maxRetries === 0 ? error : givingUp(error, attempt, "retries");
      }
      const delayMs = retryDelayMs(error, attempt, policy, random);
      if (now() + delayMs > deadline) throw givingUp(error, attempt, "budget");

      deps.onRetry?.({ attempt: attempt + 1, delayMs, error });
      await sleep(delayMs);
    }
  }
}
