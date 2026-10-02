import { ConnectorError } from "../middleware/errors.js";
import type { FreshdeskClient, QueryParams } from "./client.js";
import {
  assertEmail,
  assertIntInRange,
  assertIsoDate,
  assertPositiveId,
  expectArray,
  expectObjectWithId,
  toUtcTimestamp,
} from "./validate.js";

// ---- Documented Freshdesk enums (developers.freshdesk.com/api, Tickets) ----

export const TICKET_STATUSES = { open: 2, pending: 3, resolved: 4, closed: 5 } as const;
export const TICKET_PRIORITIES = { low: 1, medium: 2, high: 3, urgent: 4 } as const;
const TICKET_SOURCES: Record<number, string> = {
  1: "email",
  2: "portal",
  3: "phone",
  7: "chat",
  9: "feedback_widget",
  10: "outbound_email",
};

export type TicketStatusName = keyof typeof TICKET_STATUSES;
export type TicketPriorityName = keyof typeof TICKET_PRIORITIES;

// ---- Documented limits ----

/** List All Tickets: per_page max 100; at most 300 pages are served. */
export const LIST_MAX_PER_PAGE = 100;
export const LIST_MAX_PAGE = 300;
export const LIST_DEFAULT_PER_PAGE = 10;
/** Filter Tickets: fixed 30 results per page, at most 10 pages, query max 512 chars. */
export const SEARCH_PAGE_SIZE = 30;
export const SEARCH_MAX_PAGE = 10;
export const SEARCH_MAX_QUERY_LENGTH = 512;
export const DESCRIPTION_MAX_CHARS = 2_000;
export const SEARCH_MAX_TAGS = 10;
export const LIST_ORDER_BY = ["created_at", "due_by", "updated_at", "status"] as const;

// ---- Raw Freshdesk shapes (only the fields we read) ----

interface RawRequester {
  id: number;
  name?: string | null;
  email?: string | null;
}

export interface RawTicket {
  id: number;
  subject?: string | null;
  description_text?: string | null;
  status: number;
  priority: number;
  source?: number | null;
  type?: string | null;
  requester_id?: number | null;
  responder_id?: number | null;
  group_id?: number | null;
  company_id?: number | null;
  tags?: string[] | null;
  is_escalated?: boolean | null;
  spam?: boolean | null;
  due_by?: string | null;
  fr_due_by?: string | null;
  created_at: string;
  updated_at: string;
  requester?: RawRequester | null;
}

// ---- Normalized shapes returned to the agent ----

export interface TicketSummary {
  id: number;
  subject: string;
  status: string;
  priority: string;
  type: string | null;
  source: string | null;
  requesterId: number | null;
  agentId: number | null;
  groupId: number | null;
  companyId: number | null;
  tags: string[];
  dueBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TicketDetail extends TicketSummary {
  description: string | null;
  descriptionTruncated: boolean;
  isEscalated: boolean;
  /** Freshdesk marked the ticket as spam; get_ticket can return these, list_tickets does not. */
  isSpam: boolean;
  firstResponseDueBy: string | null;
  /** Name and email only; phone numbers are left to get_contact. */
  requester: { id: number; name: string | null; email: string | null } | null;
}

export interface TicketPage {
  tickets: TicketSummary[];
  pagination: { page: number; perPage: number; hasMore: boolean };
}

export interface TicketSearchResult {
  tickets: TicketSummary[];
  query: string;
  pagination: {
    page: number;
    pageSize: number;
    total: number;
    hasMore: boolean;
    /** Freshdesk serves at most 300 results (10 pages) for a filter query. */
    resultsCapped: boolean;
  };
}

// ---- Inputs ----

export interface ListTicketsParams {
  page?: number;
  perPage?: number;
  requesterId?: number;
  requesterEmail?: string;
  companyId?: number;
  updatedSince?: string;
  orderBy?: (typeof LIST_ORDER_BY)[number];
  orderType?: "asc" | "desc";
}

export interface TicketFilter {
  status?: TicketStatusName[];
  priority?: TicketPriorityName[];
  type?: string;
  tags?: string[];
  agentId?: number;
  groupId?: number;
  createdFrom?: string;
  createdTo?: string;
  updatedFrom?: string;
  updatedTo?: string;
}

// ---- Normalization ----

function enumLabel(map: Record<string, number>, value: number): string {
  const entry = Object.entries(map).find(([, code]) => code === value);
  return entry ? entry[0] : `custom (${value})`;
}

export function toTicketSummary(raw: RawTicket): TicketSummary {
  return {
    id: raw.id,
    subject: raw.subject ?? "",
    status: enumLabel(TICKET_STATUSES, raw.status),
    priority: enumLabel(TICKET_PRIORITIES, raw.priority),
    type: raw.type ?? null,
    source: raw.source == null ? null : (TICKET_SOURCES[raw.source] ?? `other (${raw.source})`),
    requesterId: raw.requester_id ?? null,
    agentId: raw.responder_id ?? null,
    groupId: raw.group_id ?? null,
    companyId: raw.company_id ?? null,
    tags: raw.tags ?? [],
    dueBy: raw.due_by ?? null,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
  };
}

export function toTicketDetail(raw: RawTicket): TicketDetail {
  const text = raw.description_text?.trim() ?? null;
  const truncated = text !== null && text.length > DESCRIPTION_MAX_CHARS;
  return {
    ...toTicketSummary(raw),
    description: truncated ? `${text.slice(0, DESCRIPTION_MAX_CHARS)}…` : text,
    descriptionTruncated: truncated,
    isEscalated: raw.is_escalated ?? false,
    isSpam: raw.spam ?? false,
    firstResponseDueBy: raw.fr_due_by ?? null,
    requester: raw.requester
      ? { id: raw.requester.id, name: raw.requester.name ?? null, email: raw.requester.email ?? null }
      : null,
  };
}

// ---- Filter query builder ----

/** Tag and type values: letters, digits, spaces and a few separators. No quotes: Freshdesk documents no escaping. */
const SAFE_TERM = /^[\p{L}\p{N} _.\-&/]{1,64}$/u;

function assertSafeTerm(name: string, value: string): void {
  if (!SAFE_TERM.test(value)) {
    throw new ConnectorError(
      "VALIDATION_ERROR",
      `${name} may only contain letters, numbers, spaces and _ . - & / (max 64 characters); got "${value.slice(0, 80)}".`,
    );
  }
}

function anyOf(clauses: string[]): string {
  return clauses.length === 1 ? clauses.join("") : `(${clauses.join(" OR ")})`;
}

/**
 * Builds a Freshdesk Filter Tickets query from typed criteria only, so the
 * agent can never inject arbitrary query syntax. Values within a field are
 * OR-ed; fields are AND-ed. `:>` / `:<` are inclusive per the Freshdesk docs.
 */
export function buildTicketQuery(filter: TicketFilter): string {
  const clauses: string[] = [];

  if (filter.status?.length) {
    clauses.push(anyOf([...new Set(filter.status)].map((s) => `status:${TICKET_STATUSES[s]}`)));
  }
  if (filter.priority?.length) {
    clauses.push(anyOf([...new Set(filter.priority)].map((p) => `priority:${TICKET_PRIORITIES[p]}`)));
  }
  if (filter.type !== undefined) {
    assertSafeTerm("type", filter.type);
    clauses.push(`type:'${filter.type}'`);
  }
  if (filter.tags?.length) {
    if (filter.tags.length > SEARCH_MAX_TAGS) {
      throw new ConnectorError("VALIDATION_ERROR", `At most ${SEARCH_MAX_TAGS} tags can be combined in one search.`);
    }
    filter.tags.forEach((tag) => assertSafeTerm("tag", tag));
    clauses.push(anyOf([...new Set(filter.tags)].map((tag) => `tag:'${tag}'`)));
  }
  if (filter.agentId !== undefined) {
    assertPositiveId("agent_id", filter.agentId);
    clauses.push(`agent_id:${filter.agentId}`);
  }
  if (filter.groupId !== undefined) {
    assertPositiveId("group_id", filter.groupId);
    clauses.push(`group_id:${filter.groupId}`);
  }

  const dateBounds: [keyof TicketFilter, string, ":>" | ":<"][] = [
    ["createdFrom", "created_at", ":>"],
    ["createdTo", "created_at", ":<"],
    ["updatedFrom", "updated_at", ":>"],
    ["updatedTo", "updated_at", ":<"],
  ];
  for (const [key, field, operator] of dateBounds) {
    const value = filter[key];
    if (typeof value !== "string") continue;
    assertIsoDate(key, value);
    clauses.push(`${field}${operator}'${value}'`);
  }

  if (clauses.length === 0) {
    throw new ConnectorError(
      "VALIDATION_ERROR",
      "search_tickets needs at least one filter (status, priority, type, tags, agent_id, group_id or a date range).",
    );
  }

  const query = `"${clauses.join(" AND ")}"`;
  if (query.length > SEARCH_MAX_QUERY_LENGTH) {
    throw new ConnectorError(
      "VALIDATION_ERROR",
      `The combined filter is too long for Freshdesk (${query.length} > ${SEARCH_MAX_QUERY_LENGTH} characters); use fewer values.`,
    );
  }
  return query;
}

// ---- Service ----

export class TicketService {
  constructor(private readonly client: FreshdeskClient) {}

  async get(ticketId: number): Promise<TicketDetail> {
    assertPositiveId("ticket_id", ticketId);
    // View a Ticket returns description_text by default; include=requester costs one extra API credit.
    const { data } = await this.client.get<unknown>(`/tickets/${ticketId}`, {
      query: { include: "requester" },
      notFoundMessage: `The Freshdesk ticket with ID ${ticketId} was not found.`,
    });
    return toTicketDetail(expectObjectWithId<RawTicket>(data, "the ticket"));
  }

  async list(params: ListTicketsParams = {}): Promise<TicketPage> {
    const page = params.page ?? 1;
    const perPage = params.perPage ?? LIST_DEFAULT_PER_PAGE;
    assertIntInRange("page", page, 1, LIST_MAX_PAGE);
    assertIntInRange("per_page", perPage, 1, LIST_MAX_PER_PAGE);

    const scopes = [params.requesterId, params.requesterEmail, params.companyId].filter((v) => v !== undefined);
    if (scopes.length > 1) {
      throw new ConnectorError(
        "VALIDATION_ERROR",
        "Use only one of requester_id, requester_email or company_id per list_tickets call.",
      );
    }
    if (params.requesterId !== undefined) assertPositiveId("requester_id", params.requesterId);
    if (params.companyId !== undefined) assertPositiveId("company_id", params.companyId);
    if (params.requesterEmail !== undefined) assertEmail("requester_email", params.requesterEmail);

    const query: QueryParams = {
      page,
      per_page: perPage,
      requester_id: params.requesterId,
      email: params.requesterEmail,
      company_id: params.companyId,
      updated_since: params.updatedSince === undefined ? undefined : toUtcTimestamp("updated_since", params.updatedSince),
      order_by: params.orderBy,
      order_type: params.orderType,
    };

    const { data, hasNextPage } = await this.client.get<unknown>("/tickets", { query });
    const tickets = expectArray<RawTicket>(data, "the ticket list").map(toTicketSummary);
    return {
      tickets,
      pagination: { page, perPage, hasMore: hasNextPage && page < LIST_MAX_PAGE },
    };
  }

  async search(filter: TicketFilter, page = 1): Promise<TicketSearchResult> {
    assertIntInRange("page", page, 1, SEARCH_MAX_PAGE);
    const query = buildTicketQuery(filter);

    const { data } = await this.client.get<unknown>("/search/tickets", { query: { query, page } });
    const body = data as { total?: unknown; results?: unknown };
    const results = expectArray<RawTicket>(body?.results, "ticket search results");
    const total = typeof body.total === "number" ? body.total : results.length;
    const reachable = Math.min(total, SEARCH_PAGE_SIZE * SEARCH_MAX_PAGE);

    return {
      tickets: results.map(toTicketSummary),
      query,
      pagination: {
        page,
        pageSize: SEARCH_PAGE_SIZE,
        total,
        hasMore: page * SEARCH_PAGE_SIZE < reachable,
        resultsCapped: total > reachable,
      },
    };
  }
}
