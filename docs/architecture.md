# Architecture

This document explains how the connector is built and why. Section 10 collects the main trade-offs as questions and answers. Section 11 separates what this assignment **implements** from what a production deployment would **additionally need**.

## Contents

1. [Context and goals](#1-context-and-goals)
2. [Technology choices](#2-technology-choices)
3. [Layers](#3-layers)
4. [Authentication](#4-authentication)
5. [The Freshdesk client](#5-the-freshdesk-client)
6. [Tool layer and validation](#6-tool-layer-and-validation)
7. [Rate limiting and retries](#7-rate-limiting-and-retries)
8. [Errors](#8-errors)
9. [Pagination and response normalization](#9-pagination-and-response-normalization)
10. [Trade-offs (Q&A)](#10-trade-offs-qa)
11. [Production considerations](#11-production-considerations)
12. [How Freshdesk behaviour was verified](#12-how-freshdesk-behaviour-was-verified)

---

## 1. Context and goals

An Agent Studio agent supporting a merchant's support team needs to answer questions like "what's happening with ticket 4821?" or "show me this customer's open tickets". The connector's job is to make that **reliable, cheap and safe**:

| Goal | Design response |
|---|---|
| The agent can find the right data | Five intent-shaped tools whose descriptions say when to use each one and when to use another |
| The agent can't do damage | Read-only by construction; no generic endpoint access |
| The agent isn't confused | Compact, labelled output (`"open"` rather than `2`) and fix-it error messages |
| Freshdesk quirks stay hidden | Auth, pagination limits, rate limits and error mapping live inside the connector |
| Reviewable in an afternoon | About 1,400 lines of TypeScript excluding comments, few abstractions, two runtime dependencies |

## 2. Technology choices

**Freshdesk.** It's a widely used helpdesk among the kind of merchants Razorpay serves. Its REST API v2 is publicly documented: API-key auth, documented rate-limit headers, and a structured filter query language. Support tickets are also a natural first use case for an agent: high volume, read-heavy, and answering "where is my ticket?" is valuable even without write access.

**TypeScript on Node.js.** The official MCP TypeScript SDK is a mature implementation. Strict TypeScript catches contract drift at compile time; for example, `src/mcp/schemas.ts` fails to compile if an output schema stops matching the service's return type. Node 22+ includes `fetch`, `AbortSignal.timeout` and `--env-file`, so no HTTP or dotenv library is needed.

**MCP.** MCP is an open protocol (JSON-RPC 2.0) that lets an AI host discover and call tools exposed by a server. Each tool comes with a description, a JSON Schema for its input, an optional output schema, and behaviour annotations. Building on it means the connector works with any MCP-capable host, Agent Studio included, without custom glue. Discovery, schemas, structured results and an error convention come with the protocol rather than being invented here.

**Dependencies (versions pinned exactly):**

| Kind | Packages |
|---|---|
| Runtime | `@modelcontextprotocol/sdk` 1.31.0, `zod` 4.6.5 |
| Development | TypeScript 5.9.3 (typescript-eslint 8.71 doesn't yet support TypeScript ≥ 6.1), Vitest 5, tsx, ESLint 10 |

## 3. Layers

```
src/index.ts            wiring only: loadConfig → FreshdeskClient → services → createServer → stdio
src/mcp/                MCP-specific: tool names, descriptions, Zod schemas, result/error formatting
src/freshdesk/          Freshdesk-specific: endpoints, query building, validation, normalization
  client.ts             the only module that performs HTTP
src/middleware/         cross-cutting: retry/backoff, error types and mapping
```

Dependencies point downward only. The tool layer depends on this interface, not on Freshdesk:

```ts
interface ConnectorServices {
  tickets:  Pick<TicketService,  "get" | "list" | "search">;
  contacts: Pick<ContactService, "get" | "search">;
}
```

Supporting another helpdesk (Zoho Desk, say) means writing services that return the same normalized shapes. The MCP tests already drive the tool layer with stub services, which shows the seam works. `createServer()` is transport-agnostic: production uses stdio, and tests use the SDK's in-memory transport.

## 4. Authentication

Freshdesk API-key auth is **HTTP Basic, with the API key as the username and `X` as the password** (Freshdesk API docs, *Authentication*). I chose it over OAuth because the brief allows either, and Freshdesk's REST API documents API keys as its standard mechanism for server integrations.

How the credential is handled:

1. It's read only from the environment (`FRESHDESK_API_KEY`) and validated at startup. The server fails fast with a message listing every problem, and placeholder values copied from `.env.example` are rejected.
2. The `Authorization` header is computed once and stored in a **private class field** (`#authorization`), so `console.log(client)`, `util.inspect` and `JSON.stringify` don't reveal it (tested).
3. It can only be sent to `https://<label>.freshdesk.com/api/v2/...`. `FRESHDESK_DOMAIN` is checked against that pattern, so a typo or a tampered setting can't send the key to another host.
4. Requests use `redirect: "manual"`, and any 3xx response becomes a `CONFIGURATION_ERROR`. The key is never forwarded to a redirect target.
5. Error messages name *variables* (`FRESHDESK_API_KEY`), never values. Logs never include headers.

**What the key authorizes:** everything the corresponding Freshdesk agent can see. The connector adds a read-only boundary on top, but *data* scope is set by the Freshdesk role. Least privilege therefore means a dedicated agent account with a restricted role.

## 5. The Freshdesk client

`FreshdeskClient` (`src/freshdesk/client.ts`) is the single place that talks HTTP. It has **one public method, `get()`**.

```
get(path, {query, notFoundMessage})
  ├─ #buildUrl      path must match ^(/[A-Za-z0-9_-]+)+$  → rules out "..", "?", "//host", absolute URLs
  │                 query values encoded with encodeURIComponent (spaces → %20, as Freshdesk's examples show)
  └─ withRetry( #sendOnce )
        ├─ fetch(GET, Authorization, Accept, redirect: manual, AbortSignal.timeout)
        ├─ 3xx → CONFIGURATION_ERROR
        ├─ non-2xx → errorFromHttpStatus(status, body, Retry-After)
        ├─ 2xx but not JSON → UPSTREAM_ERROR
        └─ success → { data, hasNextPage (Link rel="next"), rateLimit {total, remaining} }
```

Services (`TicketService`, `ContactService`) never construct URLs from agent input. Numeric IDs are checked before being placed in a path, and everything else goes into encoded query parameters.

## 6. Tool layer and validation

Validation happens in **two layers**:

| Layer | Where | Catches | Why there |
|---|---|---|---|
| Schema | Zod `inputSchema` per tool (`src/mcp/inputs.ts`), enforced by the SDK before the handler runs | wrong types, out-of-range numbers, malformed dates and emails, **unknown arguments** | Fast feedback that matches the published JSON Schema, so the model sees the constraints up front |
| Service | `src/freshdesk/validate.ts` and the services | rules a JSON Schema can't express: name *or* fields, at least one filter, at most one requester scope, 512-character query limit, real calendar dates | Keeps the services safe for any caller, not only MCP |

Design points:

- **Strict objects.** A misspelled or unsupported argument is rejected, not ignored. Without this, `list_tickets({status: "open"})` would silently return unfiltered tickets, and the agent might present them as "the open tickets".
- **Error messages are prompts.** Each field has one fix-it message (`ticket_id must be a positive integer such as 12345 (a number, not a string).`), and unknown arguments point to the right tool (`… To filter by status … use search_tickets.`).
- **Descriptions are written for the model:** what the tool does, when to use it, what to use instead, and its limits (the 30-day default, prefix-only name search, indexing lag).
- **Annotations** on every tool: `readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true`, `openWorldHint: true`. Hosts may use these to skip confirmation prompts; they are hints, not the security boundary.
- **Server `instructions`** state that the server is read-only and that ticket and contact text is customer-supplied data, not instructions. That's a basic prompt-injection defence.

## 7. Rate limiting and retries

Freshdesk returns **HTTP 429** with a **`Retry-After`** header (seconds) when the account's limit is exceeded, and reports `X-RateLimit-Total` and `X-RateLimit-Remaining` on responses. Limits are set per plan and apply **account-wide**, regardless of agent or IP.

`withRetry` (`src/middleware/rateLimiter.ts`) wraps each attempt:

| Rule | Value |
|---|---|
| What is retried | Errors with `retryable: true`: 429, 500, 502, 503, 504, network errors, timeouts |
| Never retried | 400, 401, 403, 404, 405, 501, redirects, validation errors, programming errors |
| Wait when `Retry-After` is present | Exactly that long (delta-seconds or HTTP-date; malformed values ignored) |
| Wait otherwise | Full-jitter exponential backoff: `random(0, min(8 s, 500 ms × 2^attempt))` |
| Retry limit | `FRESHDESK_MAX_RETRIES`, default 3 (so at most 4 attempts) |
| Time budget | 45 s from the first attempt, **including** request time. A retry starts only if *wait + one full attempt timeout* still fits; otherwise stop immediately. With the per-attempt timeout capped at 30 s, worst-case total latency is 45 s |
| Final failure | Same error code and `retryable` flag, `retryAfterSeconds` kept, message gains "The connector retried N times…" |

Why each choice:

- **Retry-After wins** because the server knows when its window resets. Guessing either wastes a credit on another 429 or waits longer than needed.
- **Jitter** because the limit is shared across the whole account. Several agent sessions, or the merchant's other integrations, that hit 429 together would collide again if they all retried on the same schedule.
- **The 45 s budget** exists because the MCP SDK client times out a request after 60 s by default (`DEFAULT_REQUEST_TIMEOUT_MSEC`). Retrying after the caller has given up spends credits on an answer nobody receives. It's better to return `RATE_LIMITED` with `retryAfterSeconds` in time for the agent to tell the user. The budget check counts the *next attempt's* timeout, not just the wait, so a retry that couldn't finish in time is never started (a regression test pins the worst case at ≤ 45 s).
- **Retrying 5xx is safe only because every call is a GET**, which is idempotent. Write operations would need different rules (see 10.7).
- **No client-side throttling:** the connector can't know its share of an account-wide budget. It logs `freshdesk_rate_limit_low` when remaining quota drops below 10%, which gives operators an early warning.

All timing dependencies (`sleep`, `random`, `now`) are injected, so the tests check exact delays without waiting.

## 8. Errors

Every failure becomes a `ConnectorError { code, message, status?, retryable, retryAfterSeconds? }`. Its `message` is written **for the agent**.

| Code | Trigger | Retryable |
|---|---|---|
| `VALIDATION_ERROR` | Input breaks a connector rule | no |
| `INVALID_REQUEST` | Freshdesk 400 (its field-level messages are kept, capped at 500 characters) | no |
| `AUTHENTICATION_ERROR` | 401 | no |
| `PERMISSION_DENIED` | 403 | no |
| `NOT_FOUND` | 404, with a resource-specific message | no |
| `RATE_LIMITED` | 429 | yes |
| `UPSTREAM_ERROR` | 5xx, unexpected status, or a 2xx body that isn't JSON | 500/502/503/504 only |
| `NETWORK_ERROR` | DNS failure, connection reset, timeout | yes |
| `CONFIGURATION_ERROR` | 3xx redirect (wrong domain) | no |
| `INTERNAL_ERROR` | Anything that isn't a `ConnectorError` | no |

At the MCP boundary, failed calls return `isError: true` with the JSON text `{"error":{code,message,retryable,retryAfterSeconds?}}`. Two details come from reading the SDK source:

- **If a handler throws, the SDK sends `error.message` to the agent as-is.** Every handler therefore catches errors itself, and non-`ConnectorError`s become a generic `INTERNAL_ERROR`. The stack trace goes to stderr only.
- **The SDK client validates `structuredContent` against the output schema even on error results.** Error results therefore carry only `content`.

Schema violations are reported by the SDK itself as standard `Input validation error: …` text. Changing that format would mean overriding `private` SDK methods, so instead the message *content* is controlled through Zod (section 6).

## 9. Pagination and response normalization

**Pagination follows each endpoint's documented behaviour:**

| Endpoint | Page size | Page cap | `hasMore` source |
|---|---|---|---|
| List All Tickets | `per_page` 1–100 (connector default 10) | 300 (documented) | `Link: rel="next"` header |
| Filter Tickets | fixed 30 | 10 (documented) | `total` vs `page × 30`, capped at 300; `resultsCapped` flag |
| List All Contacts | `per_page` 1–100 (default 10) | 100 (**connector's own guard**; none documented) | `Link: rel="next"` header |
| Contact autocomplete | not documented | single response | more than 30 matches (connector cap) |

Out-of-range pages are rejected before any request, and `hasMore` is forced false at each cap, so an agent can't page forever. Freshdesk uses page numbers rather than cursors, so rows can shift between pages if data changes mid-scan. That's documented in the `list_tickets` description, and a stable sort is the mitigation.

**Normalization.** Services return compact objects instead of raw payloads:

| Raw Freshdesk | What the agent sees | Why |
|---|---|---|
| `status: 2`, `priority: 4`, `source: 1` | `"open"`, `"urgent"`, `"email"` | Models misremember numeric codes; unknown values become `"custom (6)"`, never a guessed name |
| `description` (HTML) and `description_text` | plain text only, at most 2,000 characters, with `descriptionTruncated` | Saves tokens; HTML adds noise |
| `cc_emails`, `to_emails`, attachments, `custom_fields` | not exposed | Third-party addresses, file links, and merchant-defined data that may be sensitive |
| requester `phone` / `mobile` on tickets | not exposed (available via `get_contact`) | Minimization: only pull PII when the task needs it |
| contact `address`, `description` (internal notes), `other_emails`, avatar, devices, social handles | not exposed | Not needed for support lookups |
| contact `active` | `verified` | Freshdesk defines it as "verified". `active: false` would mislead a model into thinking the account is disabled |

Tests assert the *absence* of these fields, so a future change can't quietly widen exposure.

## 10. Trade-offs (Q&A)

### 10.1 Why read-only?

The first version of an agent integration should have the smallest blast radius. Reading tickets delivers most of the value (status lookups, triage summaries, customer history) without these risks:
- an LLM replying to a customer with something wrong or unapproved;
- closing a ticket by mistake;
- being prompt-injected by a ticket body into taking an action.

Read-only is enforced **structurally**: the HTTP client can only issue GET. A deny-list ("block DELETE") can be bypassed by a code path nobody thought of, whereas a capability that doesn't exist can't be misused.

### 10.2 Why not expose the whole Freshdesk API (`request(path)`)?

That would make the agent's permissions equal to the API key's, writes and deletes included. It would also push Freshdesk's quirks (query syntax, pagination limits, enum codes) onto the model, which handles them badly. Five purpose-built tools with strict schemas are easier for the model to use correctly and safer by default.

### 10.3 Why structured search instead of passing a query string?

Freshdesk's filter language is a small query language. Accepting the agent's own query string would mean:
- **Injection risk:** for example, a ticket body crafted to make the agent widen a search.
- **Invented syntax:** models produce operators and fields Freshdesk doesn't support, which leads to confusing 400s.
- **No up-front checks:** the 512-character and 300-result limits couldn't be enforced or explained in advance.

The connector builds the query from typed fields, like a parameterized SQL query. Field names come from a fixed list, and values are type-checked or restricted to a safe character set.

### 10.4 Why normalize responses?

To save tokens, give the agent less irrelevant and sensitive data, and avoid confusing it with numeric codes or misleading field names. A typical raw ticket has 30+ fields, including HTML; the normalized one has about 20 short ones. Output schemas make the shape a published, validated contract.

### 10.5 Why put rate limiting in the client rather than in each tool?

There's one policy, one set of tests, and one place to change it, and the URL is validated once before any attempt. Every current and future tool gets correct handling of 429 and transient errors automatically. Tools describe *what* to fetch; the client handles *how* to fetch it reliably.

### 10.6 Why MCP rather than a custom REST endpoint?

A custom REST endpoint would still need tool descriptions, schemas, discovery and a calling convention, invented separately for each agent platform. MCP standardizes them:
- `tools/list` for discovery;
- JSON Schema for inputs and outputs;
- `structuredContent` for structured results;
- `isError` for errors;
- annotations such as `readOnlyHint`.

Any MCP host can use the connector as-is. The cost is a dependency on the SDK and protocol; I accepted that because both are open and widely adopted.

### 10.7 How would write operations be added safely?

Separate tools (for example `reply_to_ticket`, `add_private_note`, `update_ticket_status`), each:
- annotated `readOnlyHint: false`, plus `destructiveHint` where it applies;
- gated by **human approval** in the host before execution;
- given **idempotency protection**, because retrying a POST can duplicate a reply. Either don't retry writes, or retry only with a client-generated idempotency key and a check for an existing result;
- **audit-logged** (who, what, when, which ticket);
- run with a **separate, write-scoped credential**, disabled by default per merchant.

Private notes would come before customer-visible replies.

### 10.8 Why stdio rather than HTTP?

Stdio is the simplest MCP transport. The host owns the process, there's no network port to secure, and credentials stay in the process environment. A hosted multi-tenant service would use the SDK's Streamable HTTP transport with per-request authentication (section 11). `createServer()` doesn't depend on the transport, so that's a change to the entry point only.

### 10.9 Why validate twice?

The Zod schema is the published contract, so the model sees the constraints and gets instant feedback. The service checks protect any non-MCP caller and enforce rules JSON Schema can't express. They're cheap and they fail closed.

## 11. Production considerations

> This assignment implements the core connector and demonstrates the architecture. A production deployment for many merchants would additionally require centralized secret management, tenant isolation, observability and deployment-specific controls.

| Area | Implemented in this assignment | Recommended for production |
|---|---|---|
| **Credential isolation** | One API key per process, from the environment; host restricted to `*.freshdesk.com`; key kept in a private field and never logged | One credential per merchant, resolved per request from a secrets manager; never shared across tenants; dedicated restricted Freshdesk agent per merchant |
| **Secrets management** | `.env` (git-ignored) for local use | Vault or a cloud KMS/Secrets Manager; short-lived access for the service; no secrets in host configs |
| **OAuth / rotation** | API-key auth (Freshdesk's documented REST mechanism) | Rotation runbook and automated rotation; OAuth or delegated auth if Freshdesk offers it for this use case; revocation on merchant offboarding |
| **Tenant isolation** | n/a (single tenant) | Tenant ID bound to the authenticated Agent Studio session, never taken from tool arguments; per-tenant rate and concurrency limits; no cross-tenant caches |
| **Access control** | Read-only tools; data scope set by the Freshdesk agent's role | Per-merchant tool allow-lists; role-based tool exposure inside Agent Studio; write tools off by default |
| **Logging** | Structured JSON on stderr: path, status, error code, duration; no headers, query values or payloads | Centralized logs with request and tenant IDs; PII redaction policy; retention limits |
| **Audit** | Not implemented | Immutable audit log of every tool call (tenant, user, agent, tool, arguments hash, outcome); required before any write tools |
| **Metrics** | Not implemented (low-quota warning log only) | Calls, latency and errors per tool and per code; 429 rate; retry counts; remaining-quota gauge per tenant |
| **Tracing** | Not implemented | OpenTelemetry spans from tool call to Freshdesk request, correlated with Agent Studio traces |
| **Monitoring / alerting** | Not implemented | Alerts on spikes in auth errors (revoked keys), sustained 429s, 5xx and latency service-level objectives |
| **Rate limiting** | Reactive: Retry-After, jittered backoff, retry limit, 45 s budget | Distributed per-tenant limiter (for example Redis token bucket) sized below the account's plan limit, so the connector never starves the merchant's other integrations |
| **Retries / circuit breaker** | Bounded retries for idempotent GETs | Circuit breaker per tenant and upstream to stop hammering an outage; idempotency rules for writes |
| **Caching** | None | Short-TTL caching of slow-changing reference data (agents, groups, ticket fields); **not** of ticket or contact content without a clear PII policy |
| **Data retention / PII** | Minimized responses; no persistence; fixtures fictional | Data-processing agreement; no storage of tool results beyond the session unless required; PII classification of exposed fields; merchant-configurable field exposure |
| **Transport / deployment** | stdio, single process | Streamable HTTP behind authentication, horizontally scaled stateless instances, health checks, versioned rollout |
| **Testing** | 240 hermetic tests, coverage thresholds, mock-mode demo, real-process stdio test, read-only live suite (passed 8/8 once, run manually) | Live tests in CI against a dedicated sandbox; contract tests to detect Freshdesk API changes; load tests for rate-limit behaviour |

**Scaling.** The server holds no state between calls, so it scales horizontally. The real constraint is Freshdesk's **per-account** rate limit, not connector CPU. Scaling therefore means sharing each merchant's quota well: a distributed limiter per tenant, caching reference data, and preferring cheap calls (for example `list_tickets` without `include`, which costs extra API credits).

## 12. How Freshdesk behaviour was verified

All Freshdesk-specific behaviour was taken from the official API v2 documentation (developers.freshdesk.com/api, read October 2026). I extracted the relevant sections verbatim where summaries were ambiguous. Specifically checked:
- Basic auth with `X` as the password;
- HTTPS only;
- `per_page` maximum of 100;
- the List Tickets 30-day default and 300-page cap;
- Filter Tickets and Filter Contacts query format: double-quoted, 512 characters, `AND`/`OR`, inclusive `:>`/`:<`, `YYYY-MM-DD` dates, 30 per page, 10 pages, indexing delay;
- the supported filter fields;
- the status, priority and source codes;
- the `include=requester` fields and credit cost;
- autocomplete semantics and response shape;
- List Contacts filter combination;
- 429 with `Retry-After` and the `X-RateLimit-*` headers;
- the error body shape.

**Live verification (2 October 2026).** `npm run test:live` passed **8/8** against a real Freshdesk account, through the full MCP path (real MCP client, connector, Freshdesk API). Only counts were recorded, never ticket or contact contents.

| Assumption from the docs | Confirmed live |
|---|---|
| Basic auth with `key:X` is accepted; a wrong key returns 401 → `AUTHENTICATION_ERROR` | ✓ |
| Real List Tickets, View Ticket (`include=requester`) and View Contact payloads pass the published output schemas (the MCP client validates them) | ✓ |
| Freshdesk accepts the filter query the connector generates (quoted, `OR` groups inside parentheses) | ✓ |
| `include=requester` returns the requester's email, and List Contacts `email=` finds that contact | ✓ |
| Contact autocomplete responds in the documented `[{id, name}]` shape | ✓ |
| A non-existent ticket returns 404 → `NOT_FOUND` | ✓ |
| `X-RateLimit-Total` / `X-RateLimit-Remaining` headers are returned (the trial account reported a total of **50**, so an agent loop would hit 429 quickly and bounded retries matter) | ✓ |
| Real View Ticket payloads include a `spam` boolean, now surfaced as `isSpam` | ✓ |

**Still unverified live** (the account was small, and these weren't triggered deliberately): real 429 responses and `Retry-After` values (covered only by tests and the simulated demo); pagination across many pages; custom ticket statuses; very long descriptions; phone and mobile matching formats. The hermetic suite covers these against the documented behaviour.
