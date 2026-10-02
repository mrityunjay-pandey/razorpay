import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { FreshdeskClient } from "../src/freshdesk/client.js";
import { ContactService } from "../src/freshdesk/contacts.js";
import { TicketService } from "../src/freshdesk/tickets.js";
import { createServer, SERVER_NAME } from "../src/mcp/server.js";
import { TOOL_NAMES, type ConnectorServices } from "../src/mcp/tools.js";
import { rawContact, rawTicket } from "./fixtures.js";
import { FAKE_API_KEY, jsonResponse, mockFetch, requestedUrl, testConfig } from "./helpers.js";

let client: Client | undefined;

afterEach(async () => {
  await client?.close();
  client = undefined;
});

/** Real MCP client <-> real server over the SDK's in-memory transport; only HTTP is mocked. */
async function connect(services: ConnectorServices) {
  const server = createServer(services);
  client = new Client({ name: "test-agent", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

async function connectWithHttp(...responses: Response[]) {
  const fetchMock = mockFetch(...responses);
  const http = new FreshdeskClient(testConfig, { fetch: fetchMock });
  const mcp = await connect({ tickets: new TicketService(http), contacts: new ContactService(http) });
  return { mcp, fetchMock };
}

async function call(mcp: Client, name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  return (await mcp.callTool({ name, arguments: args })) as CallToolResult;
}

function textOf(result: CallToolResult): string {
  const first = result.content[0];
  return first?.type === "text" ? first.text : "";
}

function errorOf(result: CallToolResult) {
  expect(result.isError).toBe(true);
  expect(result.structuredContent).toBeUndefined();
  return (JSON.parse(textOf(result)) as { error: { code: string; message: string; retryable: boolean; retryAfterSeconds?: number } })
    .error;
}

describe("MCP server: discovery", () => {
  it("completes the handshake and advertises usage instructions", async () => {
    const { mcp } = await connectWithHttp();
    expect(mcp.getServerVersion()?.name).toBe(SERVER_NAME);
    expect(mcp.getInstructions()).toMatch(/cannot create, update, reply to, close or delete/);
  });

  it("registers exactly the five read-only tools and nothing else", async () => {
    const { mcp } = await connectWithHttp();
    const { tools } = await mcp.listTools();

    expect(tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());
    for (const tool of tools) {
      expect(tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true });
      expect(tool.description?.length).toBeGreaterThan(100);
      expect(tool.description).toMatch(/Read-only/);
      expect(tool.outputSchema?.type).toBe("object");
      // Strict inputs: unknown/misspelled arguments are rejected rather than silently ignored.
      expect(tool.inputSchema.additionalProperties).toBe(false);
    }
  });

  it("publishes accurate input schemas: required IDs, bounded pagination, optional defaults", async () => {
    const { mcp } = await connectWithHttp();
    const byName = Object.fromEntries((await mcp.listTools()).tools.map((t) => [t.name, t.inputSchema]));

    expect(byName.get_ticket?.required).toEqual(["ticket_id"]);
    expect(byName.get_contact?.required).toEqual(["contact_id"]);
    // Fields with defaults must not be advertised as required.
    expect(byName.list_tickets?.required ?? []).toEqual([]);
    expect(byName.search_tickets?.required ?? []).toEqual([]);

    const listProps = byName.list_tickets?.properties as Record<string, { maximum?: number; default?: number }>;
    expect(listProps.per_page).toMatchObject({ maximum: 100, default: 10 });
    expect(listProps.page).toMatchObject({ maximum: 300, default: 1 });
    const searchProps = byName.search_tickets?.properties as Record<string, { maximum?: number; items?: { enum?: string[] } }>;
    expect(searchProps.page?.maximum).toBe(10);
    expect(searchProps.status?.items?.enum).toEqual(["open", "pending", "resolved", "closed"]);
  });
});

describe("MCP server: valid invocations", () => {
  it("get_ticket returns structured content plus an identical JSON text copy", async () => {
    const { mcp, fetchMock } = await connectWithHttp(
      jsonResponse({ ...rawTicket(), requester: { id: 5001, name: "Asha Example", email: "asha@example.test" } }),
    );
    const result = await call(mcp, "get_ticket", { ticket_id: 101 });

    expect(result.isError).toBeFalsy();
    expect(requestedUrl(fetchMock)).toContain("/tickets/101?include=requester");
    expect(result.structuredContent).toMatchObject({ id: 101, status: "open", priority: "high", requester: { name: "Asha Example" } });
    expect(JSON.parse(textOf(result))).toEqual(result.structuredContent);
  });

  it("list_tickets maps snake_case tool arguments to the Freshdesk query", async () => {
    const { mcp, fetchMock } = await connectWithHttp(jsonResponse([rawTicket()]));
    const result = await call(mcp, "list_tickets", { requester_email: "asha@example.test", per_page: 5, order_by: "updated_at" });

    const params = new URL(requestedUrl(fetchMock)).searchParams;
    expect(params.get("email")).toBe("asha@example.test");
    expect(params.get("per_page")).toBe("5");
    expect(params.get("order_by")).toBe("updated_at");
    expect(result.structuredContent).toMatchObject({ pagination: { page: 1, perPage: 5, hasMore: false } });
  });

  it("search_tickets builds the filter query from structured criteria", async () => {
    const { mcp } = await connectWithHttp(jsonResponse({ total: 1, results: [rawTicket()] }));
    const result = await call(mcp, "search_tickets", { status: ["open"], priority: ["urgent"], created_from: "2026-09-01" });
    expect(result.structuredContent).toMatchObject({
      query: "\"status:2 AND priority:4 AND created_at:>'2026-09-01'\"",
      pagination: { total: 1, hasMore: false },
    });
  });

  it("search_contacts by name works despite page/per_page defaults being filled in", async () => {
    const { mcp, fetchMock } = await connectWithHttp(jsonResponse([{ id: 33, name: "Asha Example" }]));
    const result = await call(mcp, "search_contacts", { name: "Asha" });
    expect(result.isError).toBeFalsy();
    expect(requestedUrl(fetchMock)).toContain("/contacts/autocomplete?term=Asha");
    expect(result.structuredContent).toMatchObject({ matchedBy: "name", contacts: [{ id: 33, name: "Asha Example" }] });
  });

  it("get_contact returns the compact contact", async () => {
    const { mcp } = await connectWithHttp(jsonResponse(rawContact()));
    const result = await call(mcp, "get_contact", { contact_id: 5001 });
    expect(result.structuredContent).toMatchObject({ id: 5001, email: "asha@example.test", verified: true });
  });
});

describe("MCP server: invalid invocations are rejected before any HTTP call", () => {
  it.each([
    ["get_ticket", { ticket_id: -1 }, /ticket_id/],
    ["get_ticket", { ticket_id: 1.5 }, /ticket_id/],
    ["get_ticket", { ticket_id: "42" }, /ticket_id/],
    ["get_ticket", {}, /ticket_id/],
    ["get_ticket", { ticket_id: 1, ticketId: 1 }, /ticketId/],
    ["list_tickets", { page: 0 }, /page/],
    ["list_tickets", { per_page: 1_000 }, /per_page/],
    ["list_tickets", { requester_email: "not-an-email" }, /requester_email/],
    ["list_tickets", { status: "open" }, /status/],
    ["search_tickets", { status: ["escalated"] }, /status/],
    ["search_tickets", { status: ["open"], page: 11 }, /page/],
    ["search_tickets", { created_from: "Sept 1" }, /YYYY-MM-DD/],
    ["search_contacts", { name: "A" }, /name/],
    ["get_contact", { contact_id: 0 }, /contact_id/],
  ])("%s %j", async (tool, args, mentions) => {
    const { mcp, fetchMock } = await connectWithHttp();
    const result = await call(mcp, tool, args);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/Input validation error/);
    expect(textOf(result)).toMatch(mentions);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["get_ticket", {}, "ticket_id is required: must be a positive integer such as 12345 (a number, not a string)."],
    ["get_ticket", { ticket_id: "42" }, "ticket_id must be a positive integer such as 12345 (a number, not a string)."],
    ["get_ticket", { id: 42 }, 'get_ticket does not accept "id". Allowed arguments: ticket_id. Pass the ID as ticket_id.'],
    [
      "list_tickets",
      { status: ["open"] },
      'list_tickets does not accept "status". Allowed arguments: page, per_page, requester_email, requester_id, company_id, updated_since, order_by, order_type. To filter by status, priority, type, tags, agent, group or dates, use search_tickets.',
    ],
    ["list_tickets", { per_page: 500 }, "per_page must be an integer from 1 to 100."],
    ["list_tickets", { order_by: "priority" }, "order_by must be one of: created_at, due_by, updated_at, status."],
    ["search_tickets", { status: ["escalated"] }, "status must be a non-empty array drawn from: open, pending, resolved, closed."],
    ["search_tickets", { created_from: "Sept 1" }, "created_from must be a date in YYYY-MM-DD format, e.g. 2026-09-01."],
    ["search_tickets", { requester_email: "a@example.test" }, "search_tickets cannot filter by customer; use list_tickets with requester_email or requester_id."],
    ["search_tickets", { query: "refund" }, "Freshdesk's API offers no free-text ticket search; express the request as structured filters."],
    ["search_contacts", { email: "nope" }, "email must be a single valid email address, e.g. name@example.com."],
  ])("%s %j explains how to fix the call", async (tool, args, guidance) => {
    const { mcp } = await connectWithHttp();
    const text = textOf(await call(mcp, tool, args));
    expect(text).toContain(`Invalid arguments for tool ${tool}`);
    expect(text).toContain(guidance);
  });

  it("service-level rules return a normalized VALIDATION_ERROR", async () => {
    const { mcp, fetchMock } = await connectWithHttp();
    const error = errorOf(await call(mcp, "search_contacts", { name: "Asha", email: "asha@example.test" }));
    expect(error).toEqual({
      code: "VALIDATION_ERROR",
      message: "Search contacts by name OR by email/phone/mobile/company_id, not both in one call.",
      retryable: false,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("an empty search_tickets filter is rejected with guidance", async () => {
    const { mcp } = await connectWithHttp();
    expect(errorOf(await call(mcp, "search_tickets", {})).message).toMatch(/needs at least one filter/);
  });

  it("an unknown tool is rejected", async () => {
    const { mcp } = await connectWithHttp();
    const result = await call(mcp, "delete_ticket", { ticket_id: 1 });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/Tool delete_ticket not found/);
  });
});

describe("MCP server: every error category reaches the agent normalized", () => {
  const html = (status: number) => new Response("<html>internal proxy page</html>", { status });

  it.each([
    ["INVALID_REQUEST", () => jsonResponse({ description: "Validation failed", errors: [{ field: "type", message: "Invalid value" }] }, { status: 400 }), false],
    ["AUTHENTICATION_ERROR", () => jsonResponse({}, { status: 401 }), false],
    ["PERMISSION_DENIED", () => jsonResponse({}, { status: 403 }), false],
    ["NOT_FOUND", () => jsonResponse({}, { status: 404 }), false],
    ["RATE_LIMITED", () => jsonResponse({}, { status: 429 }), true],
    ["UPSTREAM_ERROR", () => html(503), true],
    ["UPSTREAM_ERROR", () => new Response("not json", { status: 200 }), false],
    ["CONFIGURATION_ERROR", () => new Response(null, { status: 301, headers: { Location: "https://elsewhere.example" } }), false],
  ] as const)("%s (retryable=%s)", async (code, response, retryable) => {
    const { mcp } = await connectWithHttp(response());
    const result = await call(mcp, "search_tickets", { type: "Refund" });
    const error = errorOf(result);
    expect(error.code).toBe(code);
    expect(error.retryable).toBe(retryable);
    expect(error.message.length).toBeGreaterThan(20);
    expect(JSON.stringify(result)).not.toMatch(/<html>|Basic |fakeKey/);
  });

  it("NETWORK_ERROR", async () => {
    const fetchMock = mockFetch();
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
    const http = new FreshdeskClient(testConfig, { fetch: fetchMock });
    const mcp = await connect({ tickets: new TicketService(http), contacts: new ContactService(http) });
    expect(errorOf(await call(mcp, "get_ticket", { ticket_id: 1 }))).toEqual({
      code: "NETWORK_ERROR",
      message: "Could not reach Freshdesk (network or DNS failure).",
      retryable: true,
    });
  });
});

describe("MCP server: normalized upstream errors", () => {
  it("404 becomes NOT_FOUND with a human-readable message", async () => {
    const { mcp } = await connectWithHttp(jsonResponse({}, { status: 404 }));
    expect(errorOf(await call(mcp, "get_ticket", { ticket_id: 12345 }))).toEqual({
      code: "NOT_FOUND",
      message: "The Freshdesk ticket with ID 12345 was not found.",
      retryable: false,
    });
  });

  it("429 becomes RATE_LIMITED with retryAfterSeconds", async () => {
    const { mcp } = await connectWithHttp(jsonResponse({}, { status: 429, headers: { "Retry-After": "30" } }));
    expect(errorOf(await call(mcp, "list_tickets", {}))).toEqual({
      code: "RATE_LIMITED",
      message: "Freshdesk's API rate limit was exceeded; retry after 30 seconds.",
      retryable: true,
      retryAfterSeconds: 30,
    });
  });

  it("401 becomes AUTHENTICATION_ERROR without leaking the key", async () => {
    const { mcp } = await connectWithHttp(jsonResponse({ code: "invalid_credentials" }, { status: 401 }));
    const result = await call(mcp, "get_contact", { contact_id: 1 });
    expect(errorOf(result).code).toBe("AUTHENTICATION_ERROR");
    expect(JSON.stringify(result)).not.toContain(FAKE_API_KEY);
  });

  it("unexpected internal errors are replaced with a generic message", async () => {
    const boom = () => Promise.reject(new Error("TypeError at /srv/app/src/secret.ts:42 token=abc"));
    const mcp = await connect({
      tickets: { get: boom, list: boom, search: boom },
      contacts: { get: boom, search: boom },
    });
    const result = await call(mcp, "get_ticket", { ticket_id: 1 });
    expect(errorOf(result)).toEqual({
      code: "INTERNAL_ERROR",
      message: "The connector hit an unexpected internal error. The request was not completed.",
      retryable: false,
    });
    expect(JSON.stringify(result)).not.toMatch(/secret\.ts|token=/);
  });
});
