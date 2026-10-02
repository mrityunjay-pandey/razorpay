export type ErrorCode =
  | "AUTHENTICATION_ERROR"
  | "PERMISSION_DENIED"
  | "NOT_FOUND"
  | "INVALID_REQUEST"
  | "RATE_LIMITED"
  | "UPSTREAM_ERROR"
  | "NETWORK_ERROR"
  | "VALIDATION_ERROR"
  | "CONFIGURATION_ERROR"
  | "INTERNAL_ERROR";

export interface ConnectorErrorOptions {
  status?: number;
  retryable?: boolean;
  retryAfterSeconds?: number;
}

/**
 * The only error type that crosses the client boundary. `message` is written
 * for the agent: it must never contain credentials, headers or raw upstream bodies.
 */
export class ConnectorError extends Error {
  override name = "ConnectorError";
  readonly code: ErrorCode;
  readonly status: number | undefined;
  readonly retryable: boolean;
  readonly retryAfterSeconds: number | undefined;

  constructor(code: ErrorCode, message: string, options: ConnectorErrorOptions = {}) {
    super(message);
    this.code = code;
    this.status = options.status;
    this.retryable = options.retryable ?? false;
    this.retryAfterSeconds = options.retryAfterSeconds;
  }
}

/** What the agent receives for a failed tool call. */
export interface ToolErrorPayload {
  error: {
    code: ErrorCode;
    message: string;
    retryable: boolean;
    retryAfterSeconds?: number;
  };
}

/**
 * Converts any thrown value into an agent-safe payload. Only ConnectorError
 * messages (written for the agent) pass through; anything else is an internal
 * bug whose raw message could expose paths or internals, so it is replaced.
 */
export function toToolErrorPayload(error: unknown): ToolErrorPayload {
  if (error instanceof ConnectorError) {
    return {
      error: {
        code: error.code,
        message: error.message,
        retryable: error.retryable,
        ...(error.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: error.retryAfterSeconds }),
      },
    };
  }
  return {
    error: {
      code: "INTERNAL_ERROR",
      message: "The connector hit an unexpected internal error. The request was not completed.",
      retryable: false,
    },
  };
}

/** GET is idempotent, so transient server errors are safe to retry. */
const RETRYABLE_SERVER_STATUSES = new Set([500, 502, 503, 504]);
const MAX_DETAIL_LENGTH = 500;

/** Extracts Freshdesk's documented `{ description, errors: [{ field, message }] }` body. */
function describeFreshdeskError(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const { description, errors } = body as { description?: unknown; errors?: unknown };
  const parts: string[] = [];
  if (typeof description === "string") parts.push(description);
  if (Array.isArray(errors)) {
    for (const item of errors) {
      if (typeof item !== "object" || item === null) continue;
      const { field, message } = item as { field?: unknown; message?: unknown };
      if (typeof message !== "string") continue;
      parts.push(typeof field === "string" && field ? `${field}: ${message}` : message);
    }
  }
  const detail = parts.join("; ");
  return detail ? detail.slice(0, MAX_DETAIL_LENGTH) : undefined;
}

export interface HttpErrorContext {
  notFoundMessage?: string;
  retryAfterSeconds?: number;
}

export function errorFromHttpStatus(status: number, body: unknown, context: HttpErrorContext = {}): ConnectorError {
  switch (status) {
    case 400: {
      const detail = describeFreshdeskError(body);
      return new ConnectorError("INVALID_REQUEST", `Freshdesk rejected the request${detail ? `: ${detail}` : "."}`, { status });
    }
    case 401:
      return new ConnectorError(
        "AUTHENTICATION_ERROR",
        "Freshdesk rejected the connector's credentials. The operator should check FRESHDESK_API_KEY and FRESHDESK_DOMAIN.",
        { status },
      );
    case 403:
      return new ConnectorError(
        "PERMISSION_DENIED",
        "The Freshdesk account used by this connector is not permitted to access this resource.",
        { status },
      );
    case 404:
      return new ConnectorError("NOT_FOUND", context.notFoundMessage ?? "The requested Freshdesk resource was not found.", { status });
    case 429: {
      const wait = context.retryAfterSeconds;
      const hint = wait === undefined ? "" : `; retry after ${wait} seconds`;
      return new ConnectorError("RATE_LIMITED", `Freshdesk's API rate limit was exceeded${hint}.`, {
        status,
        retryable: true,
        retryAfterSeconds: wait,
      });
    }
  }
  if (status >= 500) {
    return new ConnectorError("UPSTREAM_ERROR", `Freshdesk returned a server error (HTTP ${status}). Try again later.`, {
      status,
      retryable: RETRYABLE_SERVER_STATUSES.has(status),
    });
  }
  return new ConnectorError("UPSTREAM_ERROR", `Freshdesk returned an unexpected response (HTTP ${status}).`, { status });
}
