import { ConnectorError } from "../middleware/errors.js";
import type { FreshdeskClient } from "./client.js";
import { assertEmail, assertIntInRange, assertPositiveId, expectArray, expectObjectWithId } from "./validate.js";

// Freshdesk documents per_page max 100 for list endpoints but no page ceiling
// for contacts; the page cap is the connector's own guard against runaway paging.
export const CONTACT_LIST_MAX_PER_PAGE = 100;
export const CONTACT_LIST_DEFAULT_PER_PAGE = 10;
export const CONTACT_LIST_MAX_PAGE = 100;
export const NAME_SEARCH_MIN_LENGTH = 2;
export const NAME_SEARCH_MAX_LENGTH = 100;
/** Autocomplete has no documented page size; cap what reaches the agent. */
export const NAME_SEARCH_MAX_RESULTS = 30;

// ---- Raw Freshdesk shapes (only the fields we read) ----

export interface RawContact {
  id: number;
  name?: string | null;
  email?: string | null;
  phone?: string | null;
  mobile?: string | null;
  company_id?: number | null;
  job_title?: string | null;
  language?: string | null;
  time_zone?: string | null;
  active?: boolean | null;
  tags?: string[] | null;
  created_at?: string | null;
  updated_at?: string | null;
}

interface RawAutocompleteMatch {
  id: number;
  name?: string | null;
}

// ---- Normalized shapes returned to the agent ----

export interface ContactDetail {
  id: number;
  name: string | null;
  email: string | null;
  phone: string | null;
  mobile: string | null;
  companyId: number | null;
  jobTitle: string | null;
  language: string | null;
  timeZone: string | null;
  /** Freshdesk's `active`: true once the contact has been verified. */
  verified: boolean;
  tags: string[];
  createdAt: string | null;
  updatedAt: string | null;
}

/** Search results omit phone numbers; use get_contact for a single contact's full details. */
export interface ContactMatch {
  id: number;
  name: string | null;
  email?: string | null;
  companyId?: number | null;
  verified?: boolean;
}

export interface ContactSearchResult {
  matchedBy: "name" | "fields";
  contacts: ContactMatch[];
  pagination: { page: number; perPage: number; hasMore: boolean };
}

// ---- Inputs ----

export interface ContactFieldFilter {
  email?: string;
  phone?: string;
  mobile?: string;
  companyId?: number;
}

/** Either `name`, or one or more field filters. page/perPage apply to field search only. */
export interface ContactSearchParams extends ContactFieldFilter {
  name?: string;
  page?: number;
  perPage?: number;
}

// ---- Normalization ----

export function toContactDetail(raw: RawContact): ContactDetail {
  return {
    id: raw.id,
    name: raw.name ?? null,
    email: raw.email ?? null,
    phone: raw.phone ?? null,
    mobile: raw.mobile ?? null,
    companyId: raw.company_id ?? null,
    jobTitle: raw.job_title ?? null,
    language: raw.language ?? null,
    timeZone: raw.time_zone ?? null,
    verified: raw.active ?? false,
    tags: raw.tags ?? [],
    createdAt: raw.created_at ?? null,
    updatedAt: raw.updated_at ?? null,
  };
}

function toContactMatch(raw: RawContact): ContactMatch {
  return {
    id: raw.id,
    name: raw.name ?? null,
    email: raw.email ?? null,
    companyId: raw.company_id ?? null,
    verified: raw.active ?? false,
  };
}

// ---- Validation helpers ----

const PHONE = /^\+?[0-9 ()-]{4,20}$/;

function assertPhone(name: string, value: string): void {
  if (!PHONE.test(value)) {
    throw new ConnectorError(
      "VALIDATION_ERROR",
      `${name} must be 4-20 characters of digits, spaces, "-", "(" or ")", optionally starting with "+".`,
    );
  }
}

function assertName(value: string): string {
  const name = value.trim();
  // eslint-disable-next-line no-control-regex -- rejecting control characters is the point
  if (name.length < NAME_SEARCH_MIN_LENGTH || name.length > NAME_SEARCH_MAX_LENGTH || /[\u0000-\u001f\u007f]/.test(name)) {
    throw new ConnectorError(
      "VALIDATION_ERROR",
      `name must be ${NAME_SEARCH_MIN_LENGTH}-${NAME_SEARCH_MAX_LENGTH} printable characters.`,
    );
  }
  return name;
}

// ---- Service ----

export class ContactService {
  constructor(private readonly client: FreshdeskClient) {}

  async get(contactId: number): Promise<ContactDetail> {
    assertPositiveId("contact_id", contactId);
    const { data } = await this.client.get<unknown>(`/contacts/${contactId}`, {
      notFoundMessage: `The Freshdesk contact with ID ${contactId} was not found.`,
    });
    return toContactDetail(expectObjectWithId<RawContact>(data, "the contact"));
  }

  /**
   * Two documented lookups behind one primitive:
   * - name   -> /contacts/autocomplete (case-insensitive word-prefix match, returns id + name only)
   * - fields -> /contacts?email=&phone=&mobile=&company_id= (exact match; filters are documented as combinable)
   * The beta Filter Contacts API is deliberately not used: it is index-backed and lags recent updates.
   */
  async search(params: ContactSearchParams): Promise<ContactSearchResult> {
    if (params.name !== undefined) {
      const { email, phone, mobile, companyId } = params;
      if ([email, phone, mobile, companyId].some((value) => value !== undefined)) {
        throw new ConnectorError(
          "VALIDATION_ERROR",
          "Search contacts by name OR by email/phone/mobile/company_id, not both in one call.",
        );
      }
      return this.#searchByName(assertName(params.name));
    }
    return this.#searchByFields(params);
  }

  async #searchByName(name: string): Promise<ContactSearchResult> {
    const { data } = await this.client.get<unknown>("/contacts/autocomplete", { query: { term: name } });
    const matches = expectArray<RawAutocompleteMatch>(data, "contact name search")
      .filter((match) => typeof match?.id === "number")
      .map((match) => ({ id: match.id, name: match.name ?? null }));

    return {
      matchedBy: "name",
      contacts: matches.slice(0, NAME_SEARCH_MAX_RESULTS),
      pagination: { page: 1, perPage: NAME_SEARCH_MAX_RESULTS, hasMore: matches.length > NAME_SEARCH_MAX_RESULTS },
    };
  }

  async #searchByFields(params: ContactSearchParams): Promise<ContactSearchResult> {
    const { email, phone, mobile, companyId } = params;
    if (email === undefined && phone === undefined && mobile === undefined && companyId === undefined) {
      throw new ConnectorError(
        "VALIDATION_ERROR",
        "search_contacts needs a name, or at least one of email, phone, mobile or company_id.",
      );
    }
    if (email !== undefined) assertEmail("email", email);
    if (phone !== undefined) assertPhone("phone", phone);
    if (mobile !== undefined) assertPhone("mobile", mobile);
    if (companyId !== undefined) assertPositiveId("company_id", companyId);

    const page = params.page ?? 1;
    const perPage = params.perPage ?? CONTACT_LIST_DEFAULT_PER_PAGE;
    assertIntInRange("page", page, 1, CONTACT_LIST_MAX_PAGE);
    assertIntInRange("per_page", perPage, 1, CONTACT_LIST_MAX_PER_PAGE);

    const { data, hasNextPage } = await this.client.get<unknown>("/contacts", {
      query: { email, phone, mobile, company_id: companyId, page, per_page: perPage },
    });
    return {
      matchedBy: "fields",
      contacts: expectArray<RawContact>(data, "the contact list").map(toContactMatch),
      pagination: { page, perPage, hasMore: hasNextPage && page < CONTACT_LIST_MAX_PAGE },
    };
  }
}
