import { describe, expect, it } from "vitest";
import { FreshdeskClient } from "../src/freshdesk/client.js";
import { buildTicketQuery, TicketService, type TicketFilter } from "../src/freshdesk/tickets.js";
import { toUtcTimestamp } from "../src/freshdesk/validate.js";
import { rawTicket, UNEXPOSED_TICKET_FIELDS } from "./fixtures.js";
import { jsonResponse, mockFetch, requestedUrl, testConfig } from "./helpers.js";

function serviceWith(...responses: Response[]) {
  const fetchMock = mockFetch(...responses);
  return { fetchMock, tickets: new TicketService(new FreshdeskClient(testConfig, { fetch: fetchMock })) };
}

function searchParams(url: string): URLSearchParams {
  return new URL(url).searchParams;
}

describe("TicketService.get", () => {
  it("requests the ticket with its requester and returns a compact, labelled view", async () => {
    const raw = {
      ...rawTicket(),
      ...UNEXPOSED_TICKET_FIELDS,
      requester: { id: 5001, name: "Asha Example", email: "asha@example.test", phone: "+91-00000-00000", mobile: "000" },
    };
    const { fetchMock, tickets } = serviceWith(jsonResponse(raw));

    const ticket = await tickets.get(101);

    expect(requestedUrl(fetchMock)).toBe("https://acme-test.freshdesk.com/api/v2/tickets/101?include=requester");
    expect(ticket).toEqual({
      id: 101,
      subject: "Refund not received for order #A-1001",
      status: "open",
      priority: "high",
      type: "Refund",
      source: "email",
      requesterId: 5001,
      agentId: 9001,
      groupId: 77,
      companyId: null,
      tags: ["refund", "payments"],
      dueBy: "2026-09-30T10:00:00Z",
      createdAt: "2026-09-27T08:15:00Z",
      updatedAt: "2026-09-27T09:00:00Z",
      description: "Hi, I was promised a refund last week but have not received it.",
      descriptionTruncated: false,
      isEscalated: false,
      isSpam: false,
      firstResponseDueBy: "2026-09-28T10:00:00Z",
      requester: { id: 5001, name: "Asha Example", email: "asha@example.test" },
    });
  });

  it("does not forward HTML bodies, CC lists, attachments, custom fields or requester phone numbers", async () => {
    const raw = { ...rawTicket(), ...UNEXPOSED_TICKET_FIELDS, requester: { id: 1, name: "A", email: "a@example.test", phone: "+91-1" } };
    const { tickets } = serviceWith(jsonResponse(raw));
    const serialized = JSON.stringify(await tickets.get(101));
    for (const leaked of ["<div>", "finance-team@", "attachment_url", "cf_internal_note", "VIP", "+91-1"]) {
      expect(serialized).not.toContain(leaked);
    }
  });

  it("flags tickets Freshdesk has marked as spam, so the agent does not present them as normal", async () => {
    const { tickets } = serviceWith(jsonResponse(rawTicket({ spam: true })));
    expect((await tickets.get(101)).isSpam).toBe(true);
  });

  it("truncates long descriptions and says so", async () => {
    const { tickets } = serviceWith(jsonResponse(rawTicket({ description_text: "x".repeat(5_000) })));
    const ticket = await tickets.get(101);
    expect(ticket.description).toHaveLength(2_001);
    expect(ticket.descriptionTruncated).toBe(true);
  });

  it("labels custom statuses and unknown sources instead of guessing names", async () => {
    const { tickets } = serviceWith(jsonResponse(rawTicket({ status: 6, source: 42 })));
    const ticket = await tickets.get(101);
    expect(ticket.status).toBe("custom (6)");
    expect(ticket.source).toBe("other (42)");
  });

  it.each([0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2])("rejects invalid ticket ID %s without calling Freshdesk", async (id) => {
    const { fetchMock, tickets } = serviceWith();
    await expect(tickets.get(id)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns a clear message when the ticket does not exist", async () => {
    const { tickets } = serviceWith(jsonResponse({}, { status: 404 }));
    await expect(tickets.get(12345)).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "The Freshdesk ticket with ID 12345 was not found.",
    });
  });

  it("rejects a malformed upstream payload", async () => {
    const { tickets } = serviceWith(jsonResponse({ unexpected: true }));
    await expect(tickets.get(101)).rejects.toMatchObject({ code: "UPSTREAM_ERROR" });
  });
});

describe("TicketService.list", () => {
  it("uses a token-friendly default page size and reports hasMore from the Link header", async () => {
    const { fetchMock, tickets } = serviceWith(
      jsonResponse([rawTicket({ id: 1 }), rawTicket({ id: 2 })], {
        headers: { Link: '<https://acme-test.freshdesk.com/api/v2/tickets?page=2&per_page=10>; rel="next"' },
      }),
    );
    const page = await tickets.list();

    const params = searchParams(requestedUrl(fetchMock));
    expect(params.get("page")).toBe("1");
    expect(params.get("per_page")).toBe("10");
    expect(page.tickets.map((t) => t.id)).toEqual([1, 2]);
    expect(page.pagination).toEqual({ page: 1, perPage: 10, hasMore: true });
  });

  it("passes requester email, updated_since and ordering through", async () => {
    const { fetchMock, tickets } = serviceWith(jsonResponse([]));
    const page = await tickets.list({
      page: 3,
      perPage: 100,
      requesterEmail: "asha@example.test",
      updatedSince: "2026-01-15",
      orderBy: "updated_at",
      orderType: "asc",
    });

    const params = searchParams(requestedUrl(fetchMock));
    expect(Object.fromEntries(params)).toEqual({
      page: "3",
      per_page: "100",
      email: "asha@example.test",
      updated_since: "2026-01-15T00:00:00Z",
      order_by: "updated_at",
      order_type: "asc",
    });
    expect(page.pagination.hasMore).toBe(false);
  });

  it("never reports more pages beyond Freshdesk's 300-page cap", async () => {
    const { tickets } = serviceWith(jsonResponse([rawTicket()], { headers: { Link: '<x>; rel="next"' } }));
    expect((await tickets.list({ page: 300 })).pagination.hasMore).toBe(false);
  });

  it.each([
    [{ page: 0 }, /page must be an integer between 1 and 300/],
    [{ page: -2 }, /page must be/],
    [{ page: 301 }, /page must be/],
    [{ perPage: 101 }, /per_page must be an integer between 1 and 100/],
    [{ perPage: 0 }, /per_page/],
    [{ requesterId: 1, companyId: 2 }, /only one of requester_id, requester_email or company_id/],
    [{ requesterEmail: "not-an-email" }, /valid email/],
    [{ requesterId: -5 }, /requester_id must be a positive integer/],
    [{ updatedSince: "last week" }, /updated_since must be a date/],
    [{ updatedSince: "2026-02-30" }, /updated_since/],
  ])("rejects %j before calling Freshdesk", async (params, message) => {
    const { fetchMock, tickets } = serviceWith();
    await expect(tickets.list(params)).rejects.toMatchObject({ code: "VALIDATION_ERROR", message: expect.stringMatching(message) });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a non-array upstream payload", async () => {
    const { tickets } = serviceWith(jsonResponse({ tickets: [] }));
    await expect(tickets.list()).rejects.toMatchObject({ code: "UPSTREAM_ERROR" });
  });
});

describe("buildTicketQuery", () => {
  it.each<[TicketFilter, string]>([
    [{ status: ["open"] }, '"status:2"'],
    [{ status: ["open", "pending"], priority: ["urgent"] }, '"(status:2 OR status:3) AND priority:4"'],
    [{ status: ["open", "open"] }, '"status:2"'],
    [{ tags: ["refund", "vip"], type: "Refund" }, "\"type:'Refund' AND (tag:'refund' OR tag:'vip')\""],
    [{ agentId: 9001, groupId: 77 }, '"agent_id:9001 AND group_id:77"'],
    [
      { createdFrom: "2026-09-01", createdTo: "2026-09-30", updatedFrom: "2026-09-15" },
      "\"created_at:>'2026-09-01' AND created_at:<'2026-09-30' AND updated_at:>'2026-09-15'\"",
    ],
  ])("builds %j as %s", (filter, expected) => {
    expect(buildTicketQuery(filter)).toBe(expected);
  });

  it.each<[TicketFilter, RegExp]>([
    [{}, /at least one filter/],
    [{ status: [] }, /at least one filter/],
    [{ tags: ["it's"] }, /tag may only contain/],
    [{ type: 'Refund" OR status:5' }, /type may only contain/],
    [{ tags: ["x".repeat(65)] }, /tag may only contain/],
    [{ createdFrom: "2026-02-30" }, /createdFrom must be a valid date/],
    [{ createdFrom: "01/09/2026" }, /createdFrom must be a valid date/],
    [{ agentId: 0 }, /agent_id must be a positive integer/],
    [{ tags: ["a", "b", "c", "d", "e", "f", "g"].map((c) => c.repeat(64)) }, /too long for Freshdesk/],
    [{ tags: Array.from({ length: 11 }, (_, i) => `t${i}`) }, /At most 10 tags/],
  ])("rejects %j", (filter, message) => {
    expect(() => buildTicketQuery(filter)).toThrow(message);
  });
});

describe("TicketService.search", () => {
  it("sends the built query with page and reports totals", async () => {
    const { fetchMock, tickets } = serviceWith(jsonResponse({ total: 45, results: [rawTicket({ id: 7 })] }));
    const result = await tickets.search({ status: ["open"], priority: ["high", "urgent"] }, 1);

    const url = requestedUrl(fetchMock);
    expect(url).toContain("/search/tickets?query=%22status%3A2%20AND%20(priority%3A3%20OR%20priority%3A4)%22&page=1");
    expect(result.query).toBe('"status:2 AND (priority:3 OR priority:4)"');
    expect(result.tickets.map((t) => t.id)).toEqual([7]);
    expect(result.pagination).toEqual({ page: 1, pageSize: 30, total: 45, hasMore: true, resultsCapped: false });
  });

  it("stops reporting more pages at Freshdesk's 10-page / 300-result cap", async () => {
    const { tickets } = serviceWith(jsonResponse({ total: 1_000, results: [rawTicket()] }));
    const result = await tickets.search({ status: ["open"] }, 10);
    expect(result.pagination).toMatchObject({ page: 10, total: 1_000, hasMore: false, resultsCapped: true });
  });

  it.each([0, 11, -1, 2.5])("rejects page %s before calling Freshdesk", async (page) => {
    const { fetchMock, tickets } = serviceWith();
    await expect(tickets.search({ status: ["open"] }, page)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects an empty filter before calling Freshdesk", async () => {
    const { fetchMock, tickets } = serviceWith();
    await expect(tickets.search({})).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("surfaces Freshdesk's own validation message for a rejected query", async () => {
    const body = { description: "Validation failed", errors: [{ field: "type", message: "Invalid value", code: "invalid_value" }] };
    const { tickets } = serviceWith(jsonResponse(body, { status: 400 }));
    await expect(tickets.search({ type: "Nonexistent" })).rejects.toMatchObject({
      code: "INVALID_REQUEST",
      message: "Freshdesk rejected the request: Validation failed; type: Invalid value",
    });
  });

  it("rejects a response without a results array", async () => {
    const { tickets } = serviceWith(jsonResponse({ total: 1 }));
    await expect(tickets.search({ status: ["open"] })).rejects.toMatchObject({ code: "UPSTREAM_ERROR" });
  });
});

describe("toUtcTimestamp", () => {
  it.each([
    ["2026-01-15", "2026-01-15T00:00:00Z"],
    ["2026-01-15T10:30:00Z", "2026-01-15T10:30:00Z"],
    ["2026-01-15T10:30:00.123Z", "2026-01-15T10:30:00Z"],
    ["2026-01-15T16:00:00+05:30", "2026-01-15T10:30:00Z"],
  ])("normalizes %s to %s", (input, expected) => {
    expect(toUtcTimestamp("updated_since", input)).toBe(expected);
  });

  it.each(["2026-01-15T10:30:00", "2026-13-01", "2026-02-30T00:00:00Z", "yesterday", ""])("rejects %j", (input) => {
    expect(() => toUtcTimestamp("updated_since", input)).toThrow(/updated_since/);
  });
});
