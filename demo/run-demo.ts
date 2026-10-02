import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { ConfigError, loadConfig, type FreshdeskConfig } from "../src/config.js";
import { FreshdeskClient } from "../src/freshdesk/client.js";
import { ContactService } from "../src/freshdesk/contacts.js";
import { TicketService } from "../src/freshdesk/tickets.js";
import type { Logger } from "../src/logger.js";
import type { RetryDeps } from "../src/middleware/rateLimiter.js";
import { createServer } from "../src/mcp/server.js";
import { createMockFreshdesk, type MockFreshdesk } from "./mock-freshdesk.js";

/**
 * End-to-end demo: a real MCP client calls the real connector (config ->
 * FreshdeskClient -> services -> MCP server). Only the Freshdesk side differs:
 *   mock: an in-process fictional simulation (demo/mock-freshdesk.ts), no network
 *   live: the real Freshdesk account configured in .env (use a demo account)
 */

export interface DemoOptions {
  mode: "mock" | "live";
  write?: (text: string) => void;
  /** Lets tests skip real waiting during the rate-limit step. */
  retry?: Omit<RetryDeps, "onRetry">;
}

interface TicketRow {
  id: number;
  subject: string;
  status: string;
  priority: string;
  requesterId: number | null;
}

const MOCK_ENV = { FRESHDESK_DOMAIN: "demo-mock", FRESHDESK_API_KEY: "demoMockKeyNotReal123" };

export async function runDemo({ mode, write = (t) => process.stdout.write(t), retry }: DemoOptions): Promise<void> {
  const out = (line = "") => write(`${line}\n`);
  const step = (n: number, title: string) => out(`\n── STEP ${n} · ${title} ${"─".repeat(Math.max(0, 60 - title.length))}`);
  const note = (text: string) => out(`   ${text}`);
  const banner = (...lines: string[]) => {
    const width = Math.max(...lines.map((l) => l.length)) + 2;
    out(`╔${"═".repeat(width)}╗`);
    for (const line of lines) out(`║ ${line.padEnd(width - 2)} ║`);
    out(`╚${"═".repeat(width)}╝`);
  };

  // Connector logs go to the demo output so retries are visible.
  const logger: Logger = (_level, event, fields) => {
    if (event === "freshdesk_retry" || event === "freshdesk_rate_limit_low") note(`  [connector log] ${event} ${JSON.stringify(fields)}`);
  };

  let mock: MockFreshdesk | undefined;
  let config: FreshdeskConfig;

  if (mode === "mock") {
    banner(
      "MOCK MODE: simulated Freshdesk, fictional data, no network calls.",
      "The connector code is real; the Freshdesk server is a local simulation.",
      "This is NOT a run against a real Freshdesk account.",
    );
    config = loadConfig(MOCK_ENV);
    mock = createMockFreshdesk({ apiKey: config.apiKey, host: new URL(config.baseUrl).host });
  } else {
    config = loadConfig();
    banner(
      `LIVE MODE: real Freshdesk API at ${new URL(config.baseUrl).host}. Read-only calls only.`,
      "Use a demo/trial account with fictional data; output shows its records.",
    );
  }

  const connect = async (cfg: FreshdeskConfig) => {
    const http = new FreshdeskClient(cfg, { fetch: mock?.fetch, logger, retry });
    const server = createServer({ tickets: new TicketService(http), contacts: new ContactService(http) });
    const client = new Client({ name: "demo-agent", version: "0.1.0" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(b), client.connect(a)]);
    return client;
  };

  const call = async (client: Client, name: string, args: Record<string, unknown>) => {
    note(`→ ${name} ${JSON.stringify(args)}`);
    const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
    if (result.isError) {
      const first = result.content[0];
      note(`← isError: ${first?.type === "text" ? first.text : "(no text)"}`);
    }
    return result;
  };

  const rows = (tickets: TicketRow[]) => {
    for (const t of tickets) note(`   #${t.id}  [${t.status}/${t.priority}]  ${t.subject}  (requester ${t.requesterId ?? "-"})`);
  };

  // ── 1. Authentication ────────────────────────────────────────────────
  step(1, "Authentication");
  note(`Config validated at startup: baseUrl=${config.baseUrl}, API key loaded (never printed)`);
  note("Auth scheme: HTTP Basic, API key as username, 'X' as password (per Freshdesk docs).");
  try {
    loadConfig({ FRESHDESK_DOMAIN: "http://acme.freshdesk.com" });
  } catch (error) {
    if (error instanceof ConfigError) note(`Misconfiguration is refused at startup:\n${error.message.replace(/^/gm, "     ")}`);
  }
  const wrongKeyClient = await connect({ ...config, apiKey: "deliberatelyWrongDemoKey", maxRetries: 0 });
  note("A deliberately wrong API key:");
  await call(wrongKeyClient, "list_tickets", { per_page: 1 });
  await wrongKeyClient.close();

  const agent = await connect(config);

  // ── 2. Discovery ─────────────────────────────────────────────────────
  step(2, "MCP discovery (tools/list)");
  const { tools } = await agent.listTools();
  for (const tool of tools) note(`${tool.name.padEnd(16)} readOnlyHint=${String(tool.annotations?.readOnlyHint)}  ${tool.title ?? ""}`);

  // ── 3. list_tickets ──────────────────────────────────────────────────
  step(3, "list_tickets (pagination)");
  const page1 = (await call(agent, "list_tickets", { per_page: 3, updated_since: "2015-01-01" })).structuredContent as
    | { tickets: TicketRow[]; pagination: { hasMore: boolean } }
    | undefined;
  rows(page1?.tickets ?? []);
  note(`pagination.hasMore = ${String(page1?.pagination.hasMore)}`);
  if (page1?.pagination.hasMore) {
    const page2 = (await call(agent, "list_tickets", { per_page: 3, page: 2, updated_since: "2015-01-01" })).structuredContent as
      | { tickets: TicketRow[]; pagination: { hasMore: boolean } }
      | undefined;
    rows(page2?.tickets ?? []);
    note(`pagination.hasMore = ${String(page2?.pagination.hasMore)}`);
  }

  // ── 4. search_tickets ────────────────────────────────────────────────
  step(4, "search_tickets (structured filter)");
  const search = (await call(agent, "search_tickets", { status: ["open"], priority: ["high", "urgent"] })).structuredContent as
    | { tickets: TicketRow[]; query: string; pagination: { total: number } }
    | undefined;
  note(`Freshdesk query built by the connector: ${search?.query ?? "-"}`);
  rows(search?.tickets ?? []);
  note(`total = ${search?.pagination.total ?? "-"}`);

  // ── 5. get_ticket ────────────────────────────────────────────────────
  const ticketId = search?.tickets[0]?.id ?? page1?.tickets[0]?.id;
  step(5, "get_ticket (normalized detail)");
  let requesterId: number | null | undefined;
  let requesterName: string | null | undefined;
  let requesterEmail: string | null | undefined;
  if (ticketId === undefined) {
    note("No tickets in this account; skipping.");
  } else {
    const detail = (await call(agent, "get_ticket", { ticket_id: ticketId })).structuredContent as
      | { requesterId: number | null; requester: { name: string | null; email: string | null } | null }
      | undefined;
    out(JSON.stringify(detail, null, 2).replace(/^/gm, "      "));
    note("Dropped from the raw payload: HTML description, cc_emails, attachments, custom_fields, requester phone.");
    requesterId = detail?.requesterId;
    requesterName = detail?.requester?.name;
    requesterEmail = detail?.requester?.email;
  }

  // ── 6. Contacts ──────────────────────────────────────────────────────
  step(6, "get_contact / search_contacts");
  if (requesterId) {
    const contact = (await call(agent, "get_contact", { contact_id: requesterId })).structuredContent;
    out(JSON.stringify(contact, null, 2).replace(/^/gm, "      "));
    note("Dropped: address, internal notes (description), other emails, custom fields, avatar.");
  }
  const prefix = requesterName?.split(/\s+/)[0]?.slice(0, 3);
  if (prefix && prefix.length >= 2) {
    const byName = (await call(agent, "search_contacts", { name: prefix })).structuredContent;
    note(`← ${JSON.stringify(byName)}`);
  }
  if (requesterEmail) {
    const byEmail = (await call(agent, "search_contacts", { email: requesterEmail })).structuredContent;
    note(`← ${JSON.stringify(byEmail)}`);
  }

  // ── 7. Rate limiting ─────────────────────────────────────────────────
  step(7, "Rate-limit handling (HTTP 429)");
  if (!mock || ticketId === undefined) {
    note("Simulated in mock mode only; a live demo must not deliberately exhaust a real account's quota.");
  } else {
    note("SIMULATION: the mock answers the next request with 429 + Retry-After: 1");
    mock.rateLimitNext(1, 1);
    const recovered = await call(agent, "get_ticket", { ticket_id: ticketId });
    note(`← recovered after retry: isError=${String(recovered.isError ?? false)}`);

    note("SIMULATION: the mock answers every request with 429 and no Retry-After");
    mock.rateLimitNext(100);
    await call(agent, "get_ticket", { ticket_id: ticketId });
    mock.rateLimitNext(0);
  }

  // ── 8. Errors and validation ─────────────────────────────────────────
  step(8, "Validation and normalized errors");
  await call(agent, "get_ticket", { ticket_id: 987654321 });
  await call(agent, "get_ticket", { ticket_id: "abc" });
  await call(agent, "list_tickets", { status: ["open"] });
  await call(agent, "search_contacts", { name: "Asha", email: "asha@example.com" });
  await call(agent, "delete_ticket", { ticket_id: 1001 });

  await agent.close();
  out("");
  out(mode === "mock" ? `Done (mock). HTTP requests handled by the simulation: ${mock?.requestCount ?? 0}.` : "Done (live).");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const mode = process.argv.includes("--live") ? "live" : "mock";
  runDemo({ mode }).catch((error: unknown) => {
    console.error(error instanceof ConfigError ? error.message : error);
    process.exit(1);
  });
}
