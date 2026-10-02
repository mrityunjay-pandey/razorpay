export interface FreshdeskConfig {
  /** e.g. https://acme.freshdesk.com/api/v2 */
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
  maxRetries: number;
}

export class ConfigError extends Error {
  override name = "ConfigError";
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RETRIES = 3;
const HOSTNAME_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const PLACEHOLDER_VALUES = new Set(["your-company", "your-api-key-here"]);

/**
 * Accepts "acme", "acme.freshdesk.com" or "https://acme.freshdesk.com" and
 * returns the bare hostname. Only *.freshdesk.com is allowed so a mistyped or
 * tampered setting can never send the API key to an unrelated host.
 */
export function normalizeDomain(raw: string): string {
  let host = raw.trim().toLowerCase();
  if (host.startsWith("http://")) {
    throw new ConfigError("FRESHDESK_DOMAIN must use HTTPS; Freshdesk only serves its API over HTTPS.");
  }
  host = host.replace(/^https:\/\//, "").replace(/\/+$/, "");
  if (!host.includes(".")) host = `${host}.freshdesk.com`;

  const labels = host.split(".");
  if (!labels.every((label) => HOSTNAME_LABEL.test(label))) {
    throw new ConfigError(`FRESHDESK_DOMAIN "${raw}" is not a valid hostname (expected e.g. "acme" or "acme.freshdesk.com").`);
  }
  if (!host.endsWith(".freshdesk.com") || labels.length !== 3) {
    throw new ConfigError(`FRESHDESK_DOMAIN "${raw}" must be a Freshdesk subdomain such as "acme.freshdesk.com".`);
  }
  return host;
}

function parseIntInRange(name: string, raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ConfigError(`${name} must be an integer between ${min} and ${max} (got "${raw}").`);
  }
  return value;
}

/**
 * Reads configuration from the environment, reporting every problem at once.
 * Error messages never include the API key.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): FreshdeskConfig {
  const problems: string[] = [];
  const collect = <T>(fn: () => T): T | undefined => {
    try {
      return fn();
    } catch (error) {
      if (!(error instanceof ConfigError)) throw error;
      problems.push(error.message);
      return undefined;
    }
  };

  const domain = env.FRESHDESK_DOMAIN?.trim();
  const apiKey = env.FRESHDESK_API_KEY?.trim();

  let host: string | undefined;
  if (!domain) problems.push("FRESHDESK_DOMAIN is not set (e.g. FRESHDESK_DOMAIN=acme for acme.freshdesk.com).");
  else if (PLACEHOLDER_VALUES.has(domain)) problems.push("FRESHDESK_DOMAIN still has the placeholder value from .env.example.");
  else host = collect(() => normalizeDomain(domain));

  if (!apiKey) problems.push("FRESHDESK_API_KEY is not set (Freshdesk > Profile Settings > View API Key).");
  else if (PLACEHOLDER_VALUES.has(apiKey)) problems.push("FRESHDESK_API_KEY still has the placeholder value from .env.example.");
  else if (/[\s:]/.test(apiKey)) problems.push("FRESHDESK_API_KEY contains whitespace or ':' characters, which a Freshdesk API key never does.");

  // Capped at 30 s so a single slow attempt cannot consume the MCP client's default 60 s request window.
  const timeoutMs = collect(() => parseIntInRange("FRESHDESK_TIMEOUT_MS", env.FRESHDESK_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, 1_000, 30_000));
  const maxRetries = collect(() => parseIntInRange("FRESHDESK_MAX_RETRIES", env.FRESHDESK_MAX_RETRIES, DEFAULT_MAX_RETRIES, 0, 5));

  if (problems.length > 0 || !host || !apiKey || timeoutMs === undefined || maxRetries === undefined) {
    throw new ConfigError(`Invalid Freshdesk configuration:\n- ${problems.join("\n- ")}`);
  }
  return { baseUrl: `https://${host}/api/v2`, apiKey, timeoutMs, maxRetries };
}
