import { z } from "zod";

/**
 * Zod builders whose error messages tell the model how to fix its call. The MCP
 * SDK reports schema failures as "<issue message> at <field>", so each message
 * here is the guidance the agent will actually read.
 */

/** Uses one message for every way the value can be wrong, with a "required" variant when absent. */
function guidance(field: string, rule: string) {
  return (issue: { input?: unknown }) =>
    issue.input === undefined ? `${field} is required: ${rule}.` : `${field} ${rule}.`;
}

export function positiveId(field: string, example: string, description: string) {
  const error = guidance(field, `must be a positive integer such as ${example} (a number, not a string)`);
  return z.number({ error }).int({ error }).positive({ error }).describe(description);
}

export function boundedInt(field: string, min: number, max: number, fallback: number, description: string) {
  const error = guidance(field, `must be an integer from ${min} to ${max}`);
  return z.number({ error }).int({ error }).min(min, { error }).max(max, { error }).default(fallback).describe(description);
}

export function isoDate(field: string, description: string) {
  const error = guidance(field, "must be a date in YYYY-MM-DD format, e.g. 2026-09-01");
  return z
    .string({ error })
    .regex(/^\d{4}-\d{2}-\d{2}$/, { error })
    .describe(`${description} (YYYY-MM-DD, UTC, inclusive)`);
}

export function email(field: string, description: string) {
  const error = guidance(field, "must be a single valid email address, e.g. name@example.com");
  return z.email({ error }).max(254, { error }).describe(description);
}

export function boundedString(field: string, min: number, max: number, description: string) {
  const error = guidance(field, `must be a string of ${min}-${max} characters`);
  return z.string({ error }).min(min, { error }).max(max, { error }).describe(description);
}

export function enumOf<const T extends readonly [string, ...string[]]>(field: string, values: T, description: string) {
  const error = guidance(field, `must be one of: ${values.join(", ")}`);
  return z.enum(values, { error }).describe(description);
}

export function enumList<const T extends readonly [string, ...string[]]>(field: string, values: T, description: string) {
  const error = guidance(field, `must be a non-empty array drawn from: ${values.join(", ")}`);
  return z
    .array(z.enum(values, { error }), { error })
    .min(1, { error })
    .max(values.length, { error })
    .describe(description);
}

export function stringList(field: string, maxItems: number, maxLength: number, description: string) {
  const error = guidance(field, `must be an array of 1-${maxItems} strings, each 1-${maxLength} characters`);
  return z
    .array(z.string({ error }).min(1, { error }).max(maxLength, { error }), { error })
    .min(1, { error })
    .max(maxItems, { error })
    .describe(description);
}

/**
 * A strict object (unknown arguments are rejected, not silently ignored) whose
 * error for unknown keys lists the allowed ones and points at the right tool.
 */
export function toolInput<S extends z.ZodRawShape>(tool: string, shape: S, redirects: Record<string, string> = {}) {
  const allowed = Object.keys(shape).join(", ") || "(none)";
  return z.strictObject(shape, {
    error: (issue) => {
      if (issue.code !== "unrecognized_keys") return undefined;
      const hints = issue.keys.map((key) => redirects[key]).filter((hint): hint is string => hint !== undefined);
      const unknown = issue.keys.map((key) => `"${key}"`).join(", ");
      return [`${tool} does not accept ${unknown}. Allowed arguments: ${allowed}.`, ...new Set(hints)].join(" ");
    },
  });
}
