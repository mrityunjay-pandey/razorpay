import type { RawContact } from "../src/freshdesk/contacts.js";
import type { RawTicket } from "../src/freshdesk/tickets.js";

/** Fictional contact shaped like Freshdesk's documented View a Contact payload. */
export function rawContact(overrides: Partial<RawContact> = {}): RawContact {
  return {
    id: 5001,
    name: "Asha Example",
    email: "asha@example.test",
    phone: "+91 00000 00001",
    mobile: null,
    company_id: 301,
    job_title: "Store Owner",
    language: "en",
    time_zone: "Chennai",
    active: true,
    tags: ["merchant"],
    created_at: "2026-01-10T09:00:00Z",
    updated_at: "2026-09-01T12:00:00Z",
    ...overrides,
  };
}

/** Contact fields Freshdesk returns that the connector must NOT forward to the agent. */
export const UNEXPOSED_CONTACT_FIELDS = {
  address: "12 Example Street, Fictional City",
  description: "Internal note: do not share",
  other_emails: ["asha.alt@example.test"],
  twitter_id: "twitter_handle_example",
  custom_fields: { cf_kyc_status: "pending" },
  avatar: { avatar_url: "https://files.example.test/avatar.png" },
  devices: [{ device_make: "Apple" }],
};

/** Fictional data shaped like Freshdesk's documented ticket payload. No real customers. */
export function rawTicket(overrides: Partial<RawTicket> = {}): RawTicket {
  return {
    id: 101,
    subject: "Refund not received for order #A-1001",
    description_text: "Hi, I was promised a refund last week but have not received it.",
    status: 2,
    priority: 3,
    source: 1,
    type: "Refund",
    requester_id: 5001,
    responder_id: 9001,
    group_id: 77,
    company_id: null,
    tags: ["refund", "payments"],
    is_escalated: false,
    due_by: "2026-09-30T10:00:00Z",
    fr_due_by: "2026-09-28T10:00:00Z",
    created_at: "2026-09-27T08:15:00Z",
    updated_at: "2026-09-27T09:00:00Z",
    ...overrides,
  };
}

/** Fields Freshdesk returns that the connector must NOT forward to the agent. */
export const UNEXPOSED_TICKET_FIELDS = {
  description: "<div>Hi, I was promised a refund...</div>",
  cc_emails: ["finance-team@example.test"],
  to_emails: ["support@example.test"],
  attachments: [{ id: 1, attachment_url: "https://files.example.test/secret.pdf" }],
  custom_fields: { cf_internal_note: "VIP customer" },
};
