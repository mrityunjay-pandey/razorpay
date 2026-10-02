/**
 * MOCK FRESHDESK, for the demo only. A tiny, fictional, in-process simulation of
 * the six read endpoints the connector uses, shaped after the documented
 * Freshdesk API v2 responses. It is NOT Freshdesk: the filter-query parser
 * understands only the subset of syntax this connector generates. All data is fictional.
 */

interface MockTicket {
  id: number;
  subject: string;
  description_text: string;
  description: string;
  status: number;
  priority: number;
  source: number;
  type: string | null;
  requester_id: number;
  responder_id: number | null;
  group_id: number | null;
  company_id: number | null;
  tags: string[];
  is_escalated: boolean;
  due_by: string;
  fr_due_by: string;
  created_at: string;
  updated_at: string;
  // Present in real payloads; the connector must drop these.
  cc_emails: string[];
  custom_fields: Record<string, unknown>;
}

interface MockContact {
  id: number;
  name: string;
  email: string;
  phone: string | null;
  mobile: string | null;
  company_id: number | null;
  job_title: string | null;
  language: string;
  time_zone: string;
  active: boolean;
  tags: string[];
  created_at: string;
  updated_at: string;
  address: string | null;
  description: string | null;
}

const CONTACTS: MockContact[] = [
  {
    id: 5001,
    name: "Asha Example",
    email: "asha@example.com",
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
    address: "12 Example Street, Fictional City",
    description: "Internal note: prefers email",
  },
  {
    id: 5002,
    name: "Ravi Sample",
    email: "ravi@example.com",
    phone: null,
    mobile: "+91 00000 00002",
    company_id: 302,
    job_title: "Finance Lead",
    language: "en",
    time_zone: "Chennai",
    active: true,
    tags: [],
    created_at: "2026-02-14T09:00:00Z",
    updated_at: "2026-08-20T12:00:00Z",
    address: null,
    description: null,
  },
  {
    id: 5003,
    name: "Meera Test",
    email: "meera@example.com",
    phone: null,
    mobile: null,
    company_id: 301,
    job_title: null,
    language: "hi",
    time_zone: "Chennai",
    active: false,
    tags: [],
    created_at: "2026-03-01T09:00:00Z",
    updated_at: "2026-03-01T09:00:00Z",
    address: null,
    description: null,
  },
];

function ticket(t: Partial<MockTicket> & Pick<MockTicket, "id" | "subject" | "status" | "priority" | "requester_id" | "created_at">): MockTicket {
  return {
    description_text: `Fictional description for: ${t.subject}`,
    description: `<div>Fictional description for: ${t.subject}</div>`,
    source: 1,
    type: null,
    responder_id: null,
    group_id: 77,
    company_id: null,
    tags: [],
    is_escalated: false,
    due_by: "2026-10-05T10:00:00Z",
    fr_due_by: "2026-10-03T10:00:00Z",
    updated_at: t.created_at,
    cc_emails: ["finance-team@example.com"],
    custom_fields: { cf_internal_risk_score: 7 },
    ...t,
  };
}

const TICKETS: MockTicket[] = [
  ticket({ id: 1001, subject: "Refund not received for order #A-1001", status: 2, priority: 3, type: "Refund", tags: ["refund"], requester_id: 5001, company_id: 301, responder_id: 9001, created_at: "2026-09-29T08:15:00Z" }),
  ticket({ id: 1002, subject: "Settlement delayed for 2 days", status: 2, priority: 4, type: "Settlement", tags: ["settlement", "urgent"], requester_id: 5002, company_id: 302, is_escalated: true, created_at: "2026-09-30T10:00:00Z" }),
  ticket({ id: 1003, subject: "How do I add a new bank account?", status: 3, priority: 1, type: "Question", requester_id: 5001, company_id: 301, created_at: "2026-09-25T11:30:00Z" }),
  ticket({ id: 1004, subject: "Payment link expired too early", status: 4, priority: 2, type: "Incident", requester_id: 5003, company_id: 301, created_at: "2026-09-20T14:00:00Z" }),
  ticket({ id: 1005, subject: "Duplicate charge on customer card", status: 2, priority: 4, type: "Refund", tags: ["refund", "payments"], requester_id: 5002, company_id: 302, created_at: "2026-10-01T07:45:00Z" }),
];

export interface MockOptions {
  apiKey: string;
  host: string;
}

export interface MockFreshdesk {
  fetch: typeof fetch;
  /** Make the next `count` requests answer 429, with Retry-After when given. */
  rateLimitNext(count: number, retryAfterSeconds?: number): void;
  readonly requestCount: number;
}

const PLAN_LIMIT = 400;

export function createMockFreshdesk({ apiKey, host }: MockOptions): MockFreshdesk {
  const expectedAuth = `Basic ${Buffer.from(`${apiKey}:X`).toString("base64")}`;
  let pending429 = 0;
  let pendingRetryAfter: number | undefined;
  let requests = 0;

  const json = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), {
      status,
      headers: {
        "Content-Type": "application/json",
        "X-RateLimit-Total": String(PLAN_LIMIT),
        "X-RateLimit-Remaining": String(Math.max(0, PLAN_LIMIT - requests)),
        "X-RateLimit-Used-CurrentRequest": "1",
        ...extra,
      },
    });

  const paginate = <T>(items: T[], url: URL, path: string) => {
    const page = Number(url.searchParams.get("page") ?? "1");
    const perPage = Number(url.searchParams.get("per_page") ?? "30");
    const slice = items.slice((page - 1) * perPage, page * perPage);
    const hasNext = page * perPage < items.length;
    const link: Record<string, string> = hasNext
      ? { Link: `<https://${host}/api/v2${path}?page=${page + 1}&per_page=${perPage}>; rel="next"` }
      : {};
    return json(slice, 200, link);
  };

  const mockFetch: typeof fetch = async (input, init) => {
    requests++;
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);

    if (url.host !== host) throw new TypeError("fetch failed (mock: unknown host)");
    if (init?.method && init.method !== "GET") return json({ code: "method_not_allowed" }, 405);
    if (headers.get("authorization") !== expectedAuth) {
      return json({ code: "invalid_credentials", message: "You have to be logged in to perform this action." }, 401);
    }
    if (pending429 > 0) {
      pending429--;
      return json({}, 429, pendingRetryAfter === undefined ? {} : { "Retry-After": String(pendingRetryAfter) });
    }

    const path = url.pathname.replace(/^\/api\/v2/, "");
    let match: RegExpExecArray | null;

    if ((match = /^\/tickets\/(\d+)$/.exec(path))) {
      const found = TICKETS.find((t) => t.id === Number(match?.[1]));
      if (!found) return json({ code: "not_found" }, 404);
      if (url.searchParams.get("include") !== "requester") return json(found);
      const r = CONTACTS.find((c) => c.id === found.requester_id);
      return json({ ...found, requester: r && { id: r.id, name: r.name, email: r.email, phone: r.phone, mobile: r.mobile } });
    }
    if (path === "/tickets") {
      const email = url.searchParams.get("email");
      const requester = email ? CONTACTS.find((c) => c.email === email)?.id : Number(url.searchParams.get("requester_id")) || undefined;
      const company = Number(url.searchParams.get("company_id")) || undefined;
      const rows = TICKETS.filter((t) => (email || requester ? t.requester_id === requester : true) && (company ? t.company_id === company : true))
        .sort((a, b) => b.created_at.localeCompare(a.created_at));
      return paginate(rows, url, path);
    }
    if (path === "/search/tickets") {
      const query = (url.searchParams.get("query") ?? "").replace(/^"|"$/g, "");
      const rows = TICKETS.filter((t) => matchesQuery(t, query));
      const page = Number(url.searchParams.get("page") ?? "1");
      return json({ total: rows.length, results: rows.slice((page - 1) * 30, page * 30) });
    }
    if ((match = /^\/contacts\/(\d+)$/.exec(path))) {
      const found = CONTACTS.find((c) => c.id === Number(match?.[1]));
      return found ? json(found) : json({ code: "not_found" }, 404);
    }
    if (path === "/contacts/autocomplete") {
      const term = (url.searchParams.get("term") ?? "").toLowerCase();
      const rows = CONTACTS.filter((c) => c.name.toLowerCase().split(/\s+/).some((word) => word.startsWith(term)));
      return json(rows.map((c) => ({ id: c.id, name: c.name })));
    }
    if (path === "/contacts") {
      const p = url.searchParams;
      const rows = CONTACTS.filter(
        (c) =>
          (!p.get("email") || c.email === p.get("email")) &&
          (!p.get("phone") || c.phone === p.get("phone")) &&
          (!p.get("mobile") || c.mobile === p.get("mobile")) &&
          (!p.get("company_id") || c.company_id === Number(p.get("company_id"))),
      );
      return paginate(rows, url, path);
    }
    return json({ code: "not_found" }, 404);
  };

  return {
    fetch: mockFetch,
    rateLimitNext(count, retryAfterSeconds) {
      pending429 = count;
      pendingRetryAfter = retryAfterSeconds;
    },
    get requestCount() {
      return requests;
    },
  };
}

/** Evaluates only the clause forms this connector emits: field:N, field:'s', field:>'d', field:<'d', joined by AND/OR. */
function matchesQuery(t: MockTicket, query: string): boolean {
  return query.split(" AND ").every((group) =>
    group
      .replace(/^\(|\)$/g, "")
      .split(" OR ")
      .some((clause) => {
        const m = /^(\w+):([<>]?)'?([^']*)'?$/.exec(clause.trim());
        if (!m) return false;
        const [, field = "", op, value = ""] = m;
        switch (field) {
          case "status":
            return t.status === Number(value);
          case "priority":
            return t.priority === Number(value);
          case "type":
            return t.type === value;
          case "tag":
            return t.tags.includes(value);
          case "agent_id":
            return t.responder_id === Number(value);
          case "group_id":
            return t.group_id === Number(value);
          case "created_at":
          case "updated_at": {
            const day = t[field].slice(0, 10);
            return op === ">" ? day >= value : day <= value;
          }
          default:
            return false;
        }
      }),
  );
}
