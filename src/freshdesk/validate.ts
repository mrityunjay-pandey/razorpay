import { ConnectorError } from "../middleware/errors.js";

/**
 * Service-level guards. The MCP layer validates with Zod first; these make the
 * services safe to call directly and guarantee nothing malformed reaches a URL.
 */
export function assertIntInRange(name: string, value: number, min: number, max: number): void {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new ConnectorError("VALIDATION_ERROR", `${name} must be an integer between ${min} and ${max} (got ${value}).`);
  }
}

export function assertPositiveId(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new ConnectorError("VALIDATION_ERROR", `${name} must be a positive integer (got ${value}).`);
  }
}

const SIMPLE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function assertEmail(name: string, value: string): void {
  if (value.length > 254 || !SIMPLE_EMAIL.test(value)) {
    throw new ConnectorError("VALIDATION_ERROR", `${name} must be a valid email address.`);
  }
}

/** Guards against Freshdesk returning a shape we do not expect, instead of crashing during normalization. */
export function expectArray<T>(data: unknown, what: string): T[] {
  if (!Array.isArray(data)) {
    throw new ConnectorError("UPSTREAM_ERROR", `Freshdesk returned an unexpected format for ${what}.`);
  }
  return data as T[];
}

export function expectObjectWithId<T>(data: unknown, what: string): T {
  if (typeof data !== "object" || data === null || typeof (data as { id?: unknown }).id !== "number") {
    throw new ConnectorError("UPSTREAM_ERROR", `Freshdesk returned an unexpected format for ${what}.`);
  }
  return data as T;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_DATE_TIME = /^(\d{4}-\d{2}-\d{2})T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

/** True for a real calendar date in YYYY-MM-DD form; rejects e.g. 2026-02-30, which Date would roll over. */
function isCalendarDate(value: string): boolean {
  const time = Date.parse(`${value}T00:00:00Z`);
  return !Number.isNaN(time) && new Date(time).toISOString().slice(0, 10) === value;
}

export function assertIsoDate(name: string, value: string): void {
  if (!ISO_DATE.test(value) || !isCalendarDate(value)) {
    throw new ConnectorError("VALIDATION_ERROR", `${name} must be a valid date in YYYY-MM-DD format (got "${value}").`);
  }
}

/**
 * Normalizes a date or ISO 8601 date-time to Freshdesk's documented UTC form
 * (e.g. 2015-01-19T02:00:00Z). A bare date means midnight UTC.
 */
export function toUtcTimestamp(name: string, value: string): string {
  if (ISO_DATE.test(value)) {
    assertIsoDate(name, value);
    return `${value}T00:00:00Z`;
  }
  const datePart = ISO_DATE_TIME.exec(value)?.[1];
  const time = Date.parse(value);
  if (datePart === undefined || !isCalendarDate(datePart) || Number.isNaN(time)) {
    throw new ConnectorError(
      "VALIDATION_ERROR",
      `${name} must be a date (YYYY-MM-DD) or an ISO 8601 date-time with timezone (got "${value}").`,
    );
  }
  return new Date(time).toISOString().replace(/\.\d{3}Z$/, "Z");
}
