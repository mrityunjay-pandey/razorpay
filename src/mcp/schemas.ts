import { z } from "zod";
import type { ContactDetail, ContactSearchResult } from "../freshdesk/contacts.js";
import type { TicketDetail, TicketPage, TicketSearchResult } from "../freshdesk/tickets.js";

/**
 * Output schemas advertised to MCP clients. The type assertions at the bottom
 * fail compilation if these drift from the service return types.
 */

const nullableString = z.string().nullable();
const nullableId = z.number().int().nullable();

export const ticketSummarySchema = z.object({
  id: z.number().int(),
  subject: z.string(),
  status: z.string().describe('open | pending | resolved | closed, or "custom (N)" for account-specific statuses'),
  priority: z.string().describe("low | medium | high | urgent"),
  type: nullableString,
  source: nullableString.describe("Channel the ticket came from, e.g. email, portal, phone, chat"),
  requesterId: nullableId.describe("Contact ID of the customer; pass to get_contact for details"),
  agentId: nullableId.describe("ID of the assigned agent, if any"),
  groupId: nullableId,
  companyId: nullableId,
  tags: z.array(z.string()),
  dueBy: nullableString.describe("Resolution due time (ISO 8601 UTC)"),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const ticketDetailSchema = ticketSummarySchema.extend({
  description: nullableString.describe("Plain-text ticket body, truncated if descriptionTruncated is true"),
  descriptionTruncated: z.boolean(),
  isEscalated: z.boolean(),
  firstResponseDueBy: nullableString,
  requester: z.object({ id: z.number().int(), name: nullableString, email: nullableString }).nullable(),
});

export const ticketPageSchema = z.object({
  tickets: z.array(ticketSummarySchema),
  pagination: z.object({
    page: z.number().int(),
    perPage: z.number().int(),
    hasMore: z.boolean().describe("True if another page exists; request page + 1 to continue"),
  }),
});

export const ticketSearchResultSchema = z.object({
  tickets: z.array(ticketSummarySchema),
  query: z.string().describe("The Freshdesk filter query the connector built from your criteria"),
  pagination: z.object({
    page: z.number().int(),
    pageSize: z.number().int(),
    total: z.number().int().describe("Total tickets matching the filter"),
    hasMore: z.boolean(),
    resultsCapped: z.boolean().describe("True if more tickets match than Freshdesk will page through (300)"),
  }),
});

export const contactDetailSchema = z.object({
  id: z.number().int(),
  name: nullableString,
  email: nullableString,
  phone: nullableString,
  mobile: nullableString,
  companyId: nullableId,
  jobTitle: nullableString,
  language: nullableString,
  timeZone: nullableString,
  verified: z.boolean().describe("Whether the contact has verified their email with Freshdesk"),
  tags: z.array(z.string()),
  createdAt: nullableString,
  updatedAt: nullableString,
});

export const contactSearchResultSchema = z.object({
  matchedBy: z.enum(["name", "fields"]).describe("name = prefix match on name; fields = exact match on email/phone/mobile/company"),
  contacts: z.array(
    z.object({
      id: z.number().int(),
      name: nullableString,
      email: nullableString.optional(),
      companyId: nullableId.optional(),
      verified: z.boolean().optional(),
    }),
  ),
  pagination: z.object({ page: z.number().int(), perPage: z.number().int(), hasMore: z.boolean() }),
});

// ---- Compile-time drift checks ----

type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Assert<T extends true> = T;

export type SchemaChecks = [
  Assert<Equals<z.infer<typeof ticketDetailSchema>, TicketDetail>>,
  Assert<Equals<z.infer<typeof ticketPageSchema>, TicketPage>>,
  Assert<Equals<z.infer<typeof ticketSearchResultSchema>, TicketSearchResult>>,
  Assert<Equals<z.infer<typeof contactDetailSchema>, ContactDetail>>,
  Assert<Equals<z.infer<typeof contactSearchResultSchema>, ContactSearchResult>>,
];
