import { describe, expect, it } from "vitest";
import { toContactDetail } from "../src/freshdesk/contacts.js";
import { toTicketDetail, toTicketSummary } from "../src/freshdesk/tickets.js";
import { errorFromHttpStatus } from "../src/middleware/errors.js";
import { contactDetailSchema, ticketDetailSchema } from "../src/mcp/schemas.js";

/** Real Freshdesk payloads are full of nulls and missing optional fields; normalization must not choke on them. */
describe("normalization of sparse payloads", () => {
  const sparseTicket = { id: 1, status: 2, priority: 1, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" };

  it("fills a minimal ticket with explicit nulls and empty values", () => {
    const detail = toTicketDetail(sparseTicket);
    expect(detail).toEqual({
      id: 1,
      subject: "",
      status: "open",
      priority: "low",
      type: null,
      source: null,
      requesterId: null,
      agentId: null,
      groupId: null,
      companyId: null,
      tags: [],
      dueBy: null,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      description: null,
      descriptionTruncated: false,
      isEscalated: false,
      firstResponseDueBy: null,
      requester: null,
    });
    // And the result still satisfies the advertised MCP output schema.
    expect(ticketDetailSchema.safeParse(detail).success).toBe(true);
  });

  it("handles explicit nulls from Freshdesk the same as missing fields", () => {
    const withNulls = {
      ...sparseTicket,
      subject: null,
      description_text: null,
      source: null,
      tags: null,
      requester: { id: 5, name: null, email: null },
    };
    expect(toTicketDetail(withNulls)).toMatchObject({ subject: "", description: null, tags: [], requester: { id: 5, name: null, email: null } });
    expect(toTicketSummary(withNulls).source).toBeNull();
  });

  it("trims whitespace-only descriptions", () => {
    expect(toTicketDetail({ ...sparseTicket, description_text: "  hello \n" }).description).toBe("hello");
  });

  it("fills a minimal contact with explicit nulls and empty values", () => {
    const detail = toContactDetail({ id: 9 });
    expect(detail).toEqual({
      id: 9,
      name: null,
      email: null,
      phone: null,
      mobile: null,
      companyId: null,
      jobTitle: null,
      language: null,
      timeZone: null,
      verified: false,
      tags: [],
      createdAt: null,
      updatedAt: null,
    });
    expect(contactDetailSchema.safeParse(detail).success).toBe(true);
  });
});

describe("Freshdesk 400 body parsing is defensive", () => {
  it.each([
    [{ errors: [null, 7, { field: "x" }, { message: "kept" }] }, "Freshdesk rejected the request: kept"],
    [{ description: 42, errors: "nope" }, "Freshdesk rejected the request."],
    ["plain string body", "Freshdesk rejected the request."],
    [undefined, "Freshdesk rejected the request."],
  ])("%j -> %s", (body, message) => {
    expect(errorFromHttpStatus(400, body).message).toBe(message);
  });

  it("caps very long upstream detail", () => {
    const body = { description: "x".repeat(5_000) };
    expect(errorFromHttpStatus(400, body).message.length).toBeLessThan(600);
  });
});
