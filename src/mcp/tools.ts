import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import {
  CONTACT_LIST_DEFAULT_PER_PAGE,
  CONTACT_LIST_MAX_PAGE,
  CONTACT_LIST_MAX_PER_PAGE,
  NAME_SEARCH_MAX_LENGTH,
  NAME_SEARCH_MIN_LENGTH,
  type ContactService,
} from "../freshdesk/contacts.js";
import {
  LIST_DEFAULT_PER_PAGE,
  LIST_MAX_PAGE,
  LIST_MAX_PER_PAGE,
  LIST_ORDER_BY,
  SEARCH_MAX_PAGE,
  SEARCH_MAX_TAGS,
  TICKET_PRIORITIES,
  TICKET_STATUSES,
  type TicketPriorityName,
  type TicketService,
  type TicketStatusName,
} from "../freshdesk/tickets.js";
import { silentLogger, type Logger } from "../logger.js";
import { toToolErrorPayload } from "../middleware/errors.js";
import {
  boundedInt,
  boundedString,
  email,
  enumList,
  enumOf,
  isoDate,
  positiveId,
  stringList,
  toolInput,
} from "./inputs.js";
import {
  contactDetailSchema,
  contactSearchResultSchema,
  ticketDetailSchema,
  ticketPageSchema,
  ticketSearchResultSchema,
} from "./schemas.js";

/** The read-only operations the tool layer depends on; swapping Freshdesk means providing these. */
export interface ConnectorServices {
  tickets: Pick<TicketService, "get" | "list" | "search">;
  contacts: Pick<ContactService, "get" | "search">;
}

/** Every tool only reads from an external system. */
const READ_ONLY: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

export const TOOL_NAMES = ["search_tickets", "list_tickets", "get_ticket", "search_contacts", "get_contact"] as const;

const STATUS_NAMES = Object.keys(TICKET_STATUSES) as [TicketStatusName, ...TicketStatusName[]];
const PRIORITY_NAMES = Object.keys(TICKET_PRIORITIES) as [TicketPriorityName, ...TicketPriorityName[]];

// ---- Hints for arguments sent to the wrong tool ----

const USE_SEARCH_TICKETS = "To filter by status, priority, type, tags, agent, group or dates, use search_tickets.";
const USE_LIST_TICKETS_FOR_REQUESTER =
  "search_tickets cannot filter by customer; use list_tickets with requester_email or requester_id.";
const NO_FREE_TEXT = "Freshdesk's API offers no free-text ticket search; express the request as structured filters.";

const LIST_TICKETS_REDIRECTS = Object.fromEntries(
  ["status", "priority", "type", "tags", "tag", "agent_id", "group_id", "created_from", "created_to"].map((key) => [
    key,
    USE_SEARCH_TICKETS,
  ]),
);
const SEARCH_TICKETS_REDIRECTS = {
  ...Object.fromEntries(["requester_email", "requester_id", "email", "company_id"].map((k) => [k, USE_LIST_TICKETS_FOR_REQUESTER])),
  ...Object.fromEntries(["query", "keyword", "text", "subject"].map((k) => [k, NO_FREE_TEXT])),
};
const ID_REDIRECT = (field: string) =>
  Object.fromEntries(["id", "ticketId", "contactId", "ticket", "contact"].map((key) => [key, `Pass the ID as ${field}.`]));

// ---- Result helpers ----

/** Structured result plus a JSON text copy for clients that do not read structuredContent. */
function success(result: object): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(result) }],
    structuredContent: result as Record<string, unknown>,
  };
}

/**
 * Error results carry no structuredContent: the MCP client validates
 * structuredContent against the success outputSchema even when isError is set.
 */
function failure(tool: string, error: unknown, log: Logger): CallToolResult {
  const payload = toToolErrorPayload(error);
  const internal = payload.error.code === "INTERNAL_ERROR";
  log(internal ? "error" : "warn", "tool_call_failed", {
    tool,
    code: payload.error.code,
    // Internal errors are logged in full (server-side only) so they can be debugged.
    ...(internal ? { reason: error instanceof Error ? error.stack : String(error) } : {}),
  });
  return { content: [{ type: "text", text: JSON.stringify(payload) }], isError: true };
}

function run<T extends object>(tool: string, log: Logger, operation: () => Promise<T>): Promise<CallToolResult> {
  return operation().then(success, (error: unknown) => failure(tool, error, log));
}

// ---- Registration ----

export function registerTools(server: McpServer, services: ConnectorServices, log: Logger = silentLogger): void {
  const { tickets, contacts } = services;

  server.registerTool(
    "search_tickets",
    {
      title: "Search Freshdesk tickets",
      description: [
        "Filter Freshdesk tickets by structured criteria: status, priority, type, tags, assigned agent, group, and created/updated date ranges.",
        "Use this when the user asks for tickets matching conditions, e.g. 'open urgent tickets' or 'refund tickets created this week'.",
        "Values within one field are OR-ed; different fields are AND-ed. Date bounds are inclusive, YYYY-MM-DD in UTC. At least one criterion is required.",
        "Returns 30 tickets per page and at most 10 pages (300 tickets); check pagination.hasMore and pagination.resultsCapped.",
        "Cannot: search free text in subject or description, filter by requester (use list_tickets with requester_email), or see archived tickets.",
        "Results can lag very recent changes by a few minutes. Read-only: cannot modify tickets.",
      ].join(" "),
      inputSchema: toolInput(
        "search_tickets",
        {
          status: enumList("status", STATUS_NAMES, "Match any of these statuses").optional(),
          priority: enumList("priority", PRIORITY_NAMES, "Match any of these priorities").optional(),
          type: boundedString("type", 1, 64, "Ticket type exactly as configured in Freshdesk, e.g. 'Refund'").optional(),
          tags: stringList("tags", SEARCH_MAX_TAGS, 64, "Match tickets with any of these tags").optional(),
          agent_id: positiveId("agent_id", "9001", "Only tickets assigned to this agent ID").optional(),
          group_id: positiveId("group_id", "77", "Only tickets in this group ID").optional(),
          created_from: isoDate("created_from", "Created on or after").optional(),
          created_to: isoDate("created_to", "Created on or before").optional(),
          updated_from: isoDate("updated_from", "Updated on or after").optional(),
          updated_to: isoDate("updated_to", "Updated on or before").optional(),
          page: boundedInt("page", 1, SEARCH_MAX_PAGE, 1, `Page number, 1-${SEARCH_MAX_PAGE}`),
        },
        SEARCH_TICKETS_REDIRECTS,
      ),
      outputSchema: ticketSearchResultSchema,
      annotations: { title: "Search Freshdesk tickets", ...READ_ONLY },
    },
    (args) =>
      run("search_tickets", log, () =>
        tickets.search(
          {
            status: args.status,
            priority: args.priority,
            type: args.type,
            tags: args.tags,
            agentId: args.agent_id,
            groupId: args.group_id,
            createdFrom: args.created_from,
            createdTo: args.created_to,
            updatedFrom: args.updated_from,
            updatedTo: args.updated_to,
          },
          args.page,
        ),
      ),
  );

  server.registerTool(
    "list_tickets",
    {
      title: "List Freshdesk tickets",
      description: [
        "List Freshdesk tickets page by page, newest first by default.",
        "Use this for 'recent tickets', or all tickets from one customer (requester_email or requester_id) or one company (company_id); use only one of those three per call.",
        "Freshdesk only returns tickets created in the last 30 days unless updated_since is set; pass updated_since to reach older tickets.",
        "To filter by status, priority, tags or dates, use search_tickets instead. Page contents can shift if tickets change while paging.",
        "Read-only: cannot modify tickets.",
      ].join(" "),
      inputSchema: toolInput(
        "list_tickets",
        {
          page: boundedInt("page", 1, LIST_MAX_PAGE, 1, `Page number, 1-${LIST_MAX_PAGE}`),
          per_page: boundedInt("per_page", 1, LIST_MAX_PER_PAGE, LIST_DEFAULT_PER_PAGE, `Tickets per page, 1-${LIST_MAX_PER_PAGE}`),
          requester_email: email("requester_email", "Only tickets raised by the contact with this email").optional(),
          requester_id: positiveId("requester_id", "5001", "Only tickets raised by this contact ID").optional(),
          company_id: positiveId("company_id", "301", "Only tickets from this company ID").optional(),
          updated_since: boundedString(
            "updated_since",
            10,
            40,
            "Only tickets updated at or after this time: YYYY-MM-DD or ISO 8601 date-time with timezone",
          ).optional(),
          order_by: enumOf("order_by", LIST_ORDER_BY, "Sort field (default created_at)").optional(),
          order_type: enumOf("order_type", ["asc", "desc"], "Sort direction (default desc)").optional(),
        },
        LIST_TICKETS_REDIRECTS,
      ),
      outputSchema: ticketPageSchema,
      annotations: { title: "List Freshdesk tickets", ...READ_ONLY },
    },
    (args) =>
      run("list_tickets", log, () =>
        tickets.list({
          page: args.page,
          perPage: args.per_page,
          requesterEmail: args.requester_email,
          requesterId: args.requester_id,
          companyId: args.company_id,
          updatedSince: args.updated_since,
          orderBy: args.order_by,
          orderType: args.order_type,
        }),
      ),
  );

  server.registerTool(
    "get_ticket",
    {
      title: "Get a Freshdesk ticket",
      description: [
        "Retrieve one Freshdesk ticket by its numeric ticket ID, including the plain-text description (truncated at 2,000 characters) and the requester's name and email.",
        "Use this when the user refers to a specific ticket number, or to read details of a ticket found via search_tickets or list_tickets.",
        "Does not return conversation replies, attachments or internal notes. Read-only: cannot reply to, update or close the ticket.",
      ].join(" "),
      inputSchema: toolInput(
        "get_ticket",
        { ticket_id: positiveId("ticket_id", "12345", "The Freshdesk ticket ID, e.g. 12345") },
        ID_REDIRECT("ticket_id"),
      ),
      outputSchema: ticketDetailSchema,
      annotations: { title: "Get a Freshdesk ticket", ...READ_ONLY },
    },
    (args) => run("get_ticket", log, () => tickets.get(args.ticket_id)),
  );

  server.registerTool(
    "search_contacts",
    {
      title: "Search Freshdesk contacts",
      description: [
        "Find Freshdesk contacts (customers). Provide EITHER name OR one or more exact-match fields (email, phone, mobile, company_id), not both.",
        "name is a case-insensitive prefix match on any word of the name: 'Asha' or 'Ash' finds 'Asha Rao', but 'sha' does not. It returns only id and name, at most 30 matches.",
        "Field search is an exact match and returns id, name, email, company and verification status, with pagination.",
        "Phone numbers are never included in search results; call get_contact with the id for full details. Read-only.",
      ].join(" "),
      inputSchema: toolInput("search_contacts", {
        name: boundedString("name", NAME_SEARCH_MIN_LENGTH, NAME_SEARCH_MAX_LENGTH, "Name or name prefix to look up").optional(),
        email: email("email", "Exact email address").optional(),
        phone: boundedString("phone", 4, 20, "Exact phone number as stored in Freshdesk").optional(),
        mobile: boundedString("mobile", 4, 20, "Exact mobile number as stored in Freshdesk").optional(),
        company_id: positiveId("company_id", "301", "Only contacts whose primary company is this ID").optional(),
        page: boundedInt("page", 1, CONTACT_LIST_MAX_PAGE, 1, "Page number (field search only)"),
        per_page: boundedInt(
          "per_page",
          1,
          CONTACT_LIST_MAX_PER_PAGE,
          CONTACT_LIST_DEFAULT_PER_PAGE,
          "Contacts per page (field search only)",
        ),
      }),
      outputSchema: contactSearchResultSchema,
      annotations: { title: "Search Freshdesk contacts", ...READ_ONLY },
    },
    (args) =>
      run("search_contacts", log, () =>
        contacts.search({
          name: args.name,
          email: args.email,
          phone: args.phone,
          mobile: args.mobile,
          companyId: args.company_id,
          page: args.page,
          perPage: args.per_page,
        }),
      ),
  );

  server.registerTool(
    "get_contact",
    {
      title: "Get a Freshdesk contact",
      description: [
        "Retrieve one Freshdesk contact (customer) by numeric contact ID: name, email, phone, mobile, company, job title, language, time zone, verification status and tags.",
        "Use this when you need a customer's details, e.g. for the requesterId of a ticket.",
        "Does not return address, internal notes or custom fields. Read-only: cannot modify the contact.",
      ].join(" "),
      inputSchema: toolInput(
        "get_contact",
        { contact_id: positiveId("contact_id", "5001", "The Freshdesk contact ID") },
        ID_REDIRECT("contact_id"),
      ),
      outputSchema: contactDetailSchema,
      annotations: { title: "Get a Freshdesk contact", ...READ_ONLY },
    },
    (args) => run("get_contact", log, () => contacts.get(args.contact_id)),
  );
}
