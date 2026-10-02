import { existsSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { loadConfig } from "../../src/config.js";
import { FreshdeskClient } from "../../src/freshdesk/client.js";
import { ContactService } from "../../src/freshdesk/contacts.js";
import { TicketService } from "../../src/freshdesk/tickets.js";
import { createServer } from "../../src/mcp/server.js";

/**
 * OPTIONAL smoke test against a real Freshdesk account (use a trial/demo account
 * with fictional data). Read-only, ~8 API calls. Runs only via `npm run test:live`
 * with FRESHDESK_LIVE_TEST=1 plus real credentials in .env. Prints counts only, never data.
 */
if (existsSync(".env")) process.loadEnvFile(".env");
const enabled = process.env.FRESHDESK_LIVE_TEST === "1";

async function connect(apiKeyOverride?: string) {
  const config = { ...loadConfig(), ...(apiKeyOverride ? { apiKey: apiKeyOverride, maxRetries: 0 } : {}) };
  const http = new FreshdeskClient(config);
  const server = createServer({ tickets: new TicketService(http), contacts: new ContactService(http) });
  const client = new Client({ name: "live-test", version: "0.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown>) {
  return (await client.callTool({ name, arguments: args })) as CallToolResult;
}

function errorCode(result: CallToolResult): string | undefined {
  const first = result.content[0];
  if (!result.isError || first?.type !== "text") return undefined;
  return (JSON.parse(first.text) as { error: { code: string } }).error.code;
}

describe.skipIf(!enabled)("live Freshdesk (read-only)", () => {
  let client: Client;
  let ticketId: number | undefined;
  let requesterId: number | undefined;
  let requesterEmail: string | undefined;

  beforeAll(async () => {
    client = await connect();
  });
  afterAll(async () => {
    await client?.close();
  });

  it("list_tickets returns a page (the MCP client validates it against the output schema)", async () => {
    // updated_since widens past Freshdesk's 30-day default so older demo data is found.
    const result = await call(client, "list_tickets", { per_page: 5, updated_since: "2015-01-01" });
    expect(result.isError).toBeFalsy();
    const page = result.structuredContent as { tickets: { id: number; requesterId: number | null }[] };
    ticketId = page.tickets[0]?.id;
    requesterId = page.tickets[0]?.requesterId ?? undefined;
    console.error(`[live] list_tickets: ${page.tickets.length} tickets`);
  });

  it("get_ticket returns the first listed ticket", async (ctx) => {
    if (ticketId === undefined) return ctx.skip();
    const result = await call(client, "get_ticket", { ticket_id: ticketId });
    expect(result.isError).toBeFalsy();
    const detail = result.structuredContent as { id: number; requester: { email: string | null } | null };
    expect(detail.id).toBe(ticketId);
    requesterEmail = detail.requester?.email ?? undefined;
  });

  it("search_tickets accepts the structured filter syntax we generate", async () => {
    const result = await call(client, "search_tickets", { status: ["open", "pending"], priority: ["low", "medium", "high", "urgent"] });
    expect(result.isError).toBeFalsy();
    console.error(`[live] search_tickets total: ${(result.structuredContent as { pagination: { total: number } }).pagination.total}`);
  });

  it("get_contact returns the ticket's requester", async (ctx) => {
    if (requesterId === undefined) return ctx.skip();
    const result = await call(client, "get_contact", { contact_id: requesterId });
    expect(result.isError).toBeFalsy();
  });

  it("search_contacts finds the requester by exact email", async (ctx) => {
    if (requesterEmail === undefined) return ctx.skip();
    const result = await call(client, "search_contacts", { email: requesterEmail });
    expect(result.isError).toBeFalsy();
    expect((result.structuredContent as { contacts: { id: number }[] }).contacts.map((c) => c.id)).toContain(requesterId);
  });

  it("search_contacts by name prefix uses the autocomplete endpoint", async () => {
    const result = await call(client, "search_contacts", { name: "an" });
    expect(result.isError).toBeFalsy();
  });

  it("a non-existent ticket maps to NOT_FOUND", async () => {
    expect(errorCode(await call(client, "get_ticket", { ticket_id: 987_654_321 }))).toBe("NOT_FOUND");
  });

  it("a wrong API key maps to AUTHENTICATION_ERROR", async () => {
    const badClient = await connect("deliberatelyWrongKeyForLiveTest");
    try {
      expect(errorCode(await call(badClient, "list_tickets", {}))).toBe("AUTHENTICATION_ERROR");
    } finally {
      await badClient.close();
    }
  });
});
