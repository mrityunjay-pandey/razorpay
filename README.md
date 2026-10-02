# Freshdesk Agent Connector

A **read-only** [Model Context Protocol (MCP)](https://modelcontextprotocol.io) server that lets an AI agent, such as an Agent Studio agent, look up **tickets** and **contacts** in a merchant's Freshdesk helpdesk.

> **Status:** take-home assignment. It implements the core connector and shows the architecture. It is verified by 236 automated tests against mocked HTTP that follows the documented Freshdesk API. On 2 October 2026 the read-only live suite also **passed 8/8 against a real Freshdesk account** (see [verification](docs/architecture.md#12-how-freshdesk-behaviour-was-verified)). It is **not** production-ready; see [Production considerations](docs/architecture.md#11-production-considerations).

---

## Problem

Merchants run customer support in tools like Freshdesk. An AI agent helping a merchant's support team ("What's the status of ticket 4821?", "Show this customer's open tickets", "Which urgent tickets came in this week?") needs reliable, safe access to that data. Giving it raw API access has three problems:

- **Too much power:** the same API key can create, reply to, close and delete tickets.
- **Too much data:** raw payloads include HTML bodies, CC lists, attachments and custom fields. That wastes tokens and exposes data the agent doesn't need.
- **Too fragile:** models invent query syntax, ignore pagination, and stall on rate limits.

## Solution

A small MCP server exposing **five read-only tools** with strict input schemas, compact normalized output, and the Freshdesk-specific details (auth, pagination, rate limits, error mapping) handled inside the connector.

```
 Agent (Agent Studio / any MCP host)
   │  MCP tools/call  (JSON-RPC over stdio)
   ▼
 ┌───────────────────────── MCP server ─────────────────────────┐
 │ src/mcp/      5 tools · strict Zod input schemas · output    │
 │               schemas · read-only annotations · safe errors  │
 ├──────────────────────────────────────────────────────────────┤
 │ src/freshdesk/ TicketService · ContactService                │
 │               query building · validation · normalization    │
 ├──────────────────────────────────────────────────────────────┤
 │ FreshdeskClient (GET only)                                   │
 │   auth · timeout · retry/backoff (middleware/rateLimiter)    │
 │   error normalization (middleware/errors)                    │
 └──────────────────────────────┬───────────────────────────────┘
                                │ HTTPS, Basic auth (API key)
                                ▼
                    Freshdesk REST API v2
```

The MCP layer depends only on a small `ConnectorServices` interface, so another helpdesk could be swapped in without touching the tool layer. Details: [docs/architecture.md](docs/architecture.md).

## Features

- **API-key authentication** using Freshdesk's documented HTTP Basic scheme (key as username, `X` as password)
- **Ticket search** with structured filters (status, priority, type, tags, agent, group, date ranges); no raw query strings
- **Ticket listing** with pagination, requester/company scoping, `updated_since` and sorting
- **Ticket retrieval** including the plain-text description and the requester's name and email
- **Contact search** by name prefix, or exact email, phone, mobile or company
- **Contact retrieval**
- **Pagination** with Freshdesk's documented limits enforced and `hasMore` taken from Freshdesk itself
- **Rate-limit handling:** honours `Retry-After`, otherwise exponential backoff with jitter; retry limit plus a time budget
- **Input validation:** strict schemas whose error messages tell the model how to fix the call
- **Normalized errors:** 10 error codes, a `retryable` flag, and no leaked credentials or internals
- **MCP tools:** official TypeScript SDK, input and output schemas, read-only annotations

## Prerequisites

- **Node.js 22.12 or newer** (developed and tested on Node 24)
- For real use: a **Freshdesk account** and an agent's **API key**. A free trial account with fictional data is enough. Unit tests need neither.

## Installation

```bash
git clone <repository-url>
cd freshdesk-agent-connector
npm install          # or `npm ci` to install exactly the versions in package-lock.json
cp .env.example .env
```

## Configuration

Edit `.env` (it is git-ignored, never commit it):

| Variable | Required | Default | Description |
|---|---|---|---|
| `FRESHDESK_DOMAIN` | yes | none | Your helpdesk subdomain: `acme`, `acme.freshdesk.com` or `https://acme.freshdesk.com`. Must be `*.freshdesk.com` over HTTPS. |
| `FRESHDESK_API_KEY` | yes | none | The API key of the Freshdesk agent the connector acts as |
| `FRESHDESK_TIMEOUT_MS` | no | `10000` | Per-request timeout (1000–60000) |
| `FRESHDESK_MAX_RETRIES` | no | `3` | Retries for 429, transient 5xx and network errors (0–5) |
| `FRESHDESK_LIVE_TEST` | no | unset | Set to `1` to enable `npm run test:live` |

**Getting the API key:** in Freshdesk, click your profile picture, open **Profile settings**, then **View API Key**. The connector can see exactly what that agent can see, so for least privilege, create a dedicated agent with a restricted role (for example, access only to the relevant groups) and use its key.

The server validates configuration at startup and exits with a clear message listing every problem. Error messages never include the key.

## Running

The connector is an MCP **stdio** server: an MCP host starts it as a child process and talks to it over stdin/stdout. It isn't meant to be used directly in a terminal.

```bash
npm run build      # compile TypeScript to dist/
npm start          # run dist/index.js (loads .env if present)
npm run dev        # run from source with auto-reload (loads .env if present)
```

**Connecting an MCP host.** Hosts that use the common `mcpServers` JSON format (for example Claude Desktop) take an entry like this. Use an absolute path, and keep real keys in the host's secret store where it has one:

```json
{
  "mcpServers": {
    "freshdesk": {
      "command": "node",
      "args": ["/absolute/path/to/freshdesk-agent-connector/dist/index.js"],
      "env": { "FRESHDESK_DOMAIN": "your-company", "FRESHDESK_API_KEY": "<your key>" }
    }
  }
}
```

To explore the tools interactively, run the [MCP Inspector](https://github.com/modelcontextprotocol/inspector) (`npx @modelcontextprotocol/inspector`) and add a stdio server with command `node` and argument `dist/index.js`.

> How Razorpay Agent Studio registers MCP servers isn't covered here; this connector follows the standard MCP stdio contract. See [Assumptions](#assumptions).

## Testing

| Command | What it does |
|---|---|
| `npm test` | 236 hermetic tests (about 2 s). All HTTP is mocked, so there's **no network and no credentials**. |
| `npm run test:coverage` | Same, plus a coverage report (`coverage/`). Fails below 95% lines, statements and functions, or 85% branches. |
| `npm run test:live` | **Optional.** About 8 read-only calls against a real account. Needs `FRESHDESK_LIVE_TEST=1` and real credentials in `.env`. Prints counts only, never data. Use a demo account with fictional data. |
| `npm run typecheck` | `tsc --noEmit` over source and tests (strict mode) |
| `npm run lint` | ESLint with strict typescript-eslint rules; `any` is banned, and stdout logging is banned |
| `npm run spec` | Regenerates [docs/mcp-tools.json](docs/mcp-tools.json) from the server's `tools/list` |

Test layers:
- **Unit tests:** services, client, retry logic with a fake clock.
- **Protocol tests:** the real MCP client against the real server, in memory.
- **Process test:** the server spawned as a real child process over stdio, which also proves nothing but protocol messages reaches stdout.

## Demo

A script drives every tool through a **real MCP client** connected to the **real connector**, showing authentication, discovery, listing with pagination, search, ticket and contact retrieval, rate-limit recovery and normalized errors.

| Command | Freshdesk side | Notes |
|---|---|---|
| `npm run demo` | **Mock:** a fictional in-process simulation ([demo/mock-freshdesk.ts](demo/mock-freshdesk.ts)). No network, no account. | Output is clearly labelled MOCK MODE. Step 7 *simulates* 429 responses (one with `Retry-After`, one without) to show retry and give-up behaviour. |
| `npm run demo:live` | **Live:** the account in `.env` | Read-only. Prints the account's records, so use a demo account with fictional data. The rate-limit step is skipped so a real quota isn't exhausted on purpose. |

Recorded mock output: [docs/demo-output.md](docs/demo-output.md). The mock lives in `demo/`, not `src/`; it can't be enabled in the production entry point.

## MCP Tools

| Tool | Purpose | Required input | Key optional input |
|------|---------|----------------|--------------------|
| `search_tickets` | Filter tickets by structured criteria | at least one filter | `status[]`, `priority[]`, `type`, `tags[]`, `agent_id`, `group_id`, `created_from`/`created_to`, `updated_from`/`updated_to`, `page` (1–10) |
| `list_tickets` | Page through recent tickets, or one customer's or company's tickets | none | `page` (1–300), `per_page` (1–100, default 10), one of `requester_email` / `requester_id` / `company_id`, `updated_since`, `order_by`, `order_type` |
| `get_ticket` | Retrieve one ticket | `ticket_id` | none |
| `search_contacts` | Find contacts | `name` **or** at least one of `email`, `phone`, `mobile`, `company_id` | `page`, `per_page` (field search only) |
| `get_contact` | Retrieve one contact | `contact_id` | none |

**Full specification:** [docs/mcp-tools.json](docs/mcp-tools.json) holds every tool's description, input and output JSON Schema, and annotations, exactly as the server returns them from `tools/list`. It's generated by `npm run spec`, and a test fails if it drifts from the code.

All tools are annotated `readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true`. Successful calls return `structuredContent` that matches a published output schema, plus the same data as JSON text. Failed calls return `isError: true` with:

```json
{ "error": { "code": "NOT_FOUND", "message": "The Freshdesk ticket with ID 12345 was not found.", "retryable": false } }
```

Schema violations (wrong type, unknown argument, out of range) are reported by the MCP SDK as standard `Input validation error` text, using fix-it messages such as `ticket_id must be a positive integer such as 12345 (a number, not a string).`

## Security

- **Read-only by construction.** The HTTP client has a single `get()` method, and there are no write tools and no "call any endpoint" tool.
- **Credentials:** come only from the environment and are checked at startup. They're held in one private field, sent only to `https://*.freshdesk.com`, and never forwarded on redirects. They never appear in errors or logs, and tests check all of this.
- **Data minimization:** the agent gets compact objects. HTML bodies, CC lists, attachments, custom fields, contact addresses and internal notes are never returned.
- **No injection surface:** the agent never supplies URL paths or Freshdesk query syntax.
- **Logs** are structured JSON on stderr with paths and status codes only. No headers, no query values (which can contain customer emails).

## Agent Capabilities

| The agent CAN | The agent CANNOT |
|---|---|
| Search, list and read tickets; search and read contacts | Create, update, close, reopen or delete tickets; reply to customers; add notes; change status or priority; modify contacts; call arbitrary endpoints |

Full details, including data exposed or withheld and human-approval rules: [docs/agent-capabilities.md](docs/agent-capabilities.md).

## Assumptions

- **One helpdesk:** one Freshdesk account per server process, and one API key acting as one Freshdesk agent. Multi-tenant hosting is out of scope (see production notes).
- **Hostname:** the helpdesk is reached at `<subdomain>.freshdesk.com`. Custom domains are deliberately rejected so the key can't be sent elsewhere.
- **Agent Studio:** it can host a standard MCP server over stdio. Exposing it over Streamable HTTP would be a transport change, not a redesign.
- **Freshdesk behaviour** follows the [official API v2 documentation](https://developers.freshdesk.com/api/) as read in October 2026. Where the docs are silent, I chose the safer option:
  - List Tickets requester and company filters are not combined, because unlike List Contacts the docs don't say they can be.
  - Quotes in filter values are rejected, because no escaping is documented.
  - Custom statuses are shown as `"custom (N)"`.

## Limitations

- **No free-text ticket search.** Freshdesk's filter API supports only structured fields.
- **`search_tickets` caps:** at most 300 results (10 pages of 30). It can't filter by requester (use `list_tickets`), excludes archived tickets, and can lag recent updates by a few minutes because of indexing.
- **`list_tickets` window:** returns only tickets **created in the last 30 days** unless `updated_since` is given (Freshdesk's default). Page-number pagination can shift if tickets change while paging.
- **Contact search:** name search is a word-prefix match ("Ash" finds "Asha Rao", "sha" doesn't) and returns at most 30 matches with ID and name only. Phone and mobile lookups are exact string matches against the stored value.
- **Not exposed:** conversation threads, notes, attachments, companies, agents, groups and custom fields.
- **Statuses:** custom ticket statuses can't be searched by name.
- **Rate limits:** the limit is per Freshdesk **account** and shared with the merchant's other integrations. The connector reacts to 429 but can't reserve capacity.
- **Transport:** stdio only, in a single process. No caching, metrics or tracing (see production notes).

## Future Improvements

- Read-only tools for conversations (`get_ticket_conversations`), companies, agents and groups, so IDs can be shown as names
- Streamable HTTP transport with per-request auth for hosted, multi-tenant deployment
- OAuth or delegated credentials where available, with a secrets manager and rotation
- Write operations (reply, add note, change status) behind explicit human approval; see [agent-capabilities.md](docs/agent-capabilities.md#human-approval-requirements)
- Metrics and tracing, a circuit breaker, and a distributed rate limiter per tenant
- Discovering custom fields and statuses via Freshdesk's ticket-field endpoints

## Repository layout

```
src/
  index.ts              stdio entry point: config → client → services → MCP server
  config.ts             environment loading and validation
  logger.ts             structured JSON logs on stderr
  freshdesk/
    client.ts           FreshdeskClient: the only HTTP code (GET only)
    tickets.ts          TicketService, filter query builder, ticket normalization
    contacts.ts         ContactService, contact normalization
    validate.ts         shared input and response-shape guards
  mcp/
    server.ts           createServer(): McpServer plus instructions
    tools.ts            the five tool registrations
    inputs.ts           Zod input builders with agent-oriented error messages
    schemas.ts          output schemas (compile-time checked against service types)
  middleware/
    rateLimiter.ts      Retry-After parsing, backoff, withRetry
    errors.ts           ConnectorError, HTTP status mapping, tool error payloads
tests/                  hermetic tests; tests/live/ holds the optional real-account tests
demo/
  run-demo.ts           end-to-end demo (mock or live)
  mock-freshdesk.ts     fictional in-process Freshdesk simulation (demo only)
  generate-tool-spec.ts writes docs/mcp-tools.json from the live tools/list response
docs/
  mcp-tools.json        MCP tool specification (generated)
  architecture.md       design, trade-offs, production considerations
  agent-capabilities.md what the agent can and cannot do
  demo-output.md        recorded mock-mode demo run
```

## License

[MIT](LICENSE)
