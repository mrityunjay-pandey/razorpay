# Agent capabilities

What an agent connected to this MCP server can and cannot do, what data it sees, and where humans must stay involved. The audience is reviewers and anyone deciding whether to attach this connector to an agent.

**In one line:** the agent can **look up** Freshdesk tickets and contacts. It **cannot change anything**.

## Allowed capabilities

| Tool | The agent can… | Typical request |
|---|---|---|
| `search_tickets` | Filter tickets by status, priority, type, tags, assigned agent, group, and created or updated date ranges | "Show open urgent tickets", "refund tickets created since 1 Sept" |
| `list_tickets` | Page through recent tickets, or all tickets from one customer (email or ID) or one company | "What has asha@example.com raised recently?" |
| `get_ticket` | Read one ticket: subject, status, priority, type, tags, dates, plain-text description (up to 2,000 characters), requester name and email | "What's ticket 4821 about?" |
| `search_contacts` | Find customers by name prefix, or by exact email, phone, mobile or company | "Find the customer called Asha" |
| `get_contact` | Read one customer's profile: name, email, phone, mobile, company, job title, language, time zone, verified flag, tags | "How do I reach the requester of ticket 4821?" |

All five tools are annotated read-only (`readOnlyHint: true`, `destructiveHint: false`).

## Restricted capabilities

The agent **cannot**:

- create tickets
- update, close, reopen, merge or delete tickets
- change a ticket's status, priority, type, assignee, group or tags
- reply to customers, forward tickets, or add public or private notes
- create, update, merge, block or delete contacts
- read conversation threads, attachments, companies, agents, groups or account settings
- call any other Freshdesk endpoint or supply its own URL path or query string

**How this is enforced:** by construction, not by policy. The connector's HTTP client has a single `get()` method, so it can't send POST, PUT or DELETE at all. Only the five tools above exist, and none takes a URL, path, HTTP method or raw Freshdesk query. Calling a tool that doesn't exist (for example `delete_ticket`) returns "not found". Tests check all of this.

When a user asks for a change, the server's instructions tell the agent to say that a human must make it in Freshdesk.

## Data exposed

| Object | Fields returned |
|---|---|
| Ticket (list/search) | id, subject, status, priority, type, source, requesterId, agentId, groupId, companyId, tags, dueBy, createdAt, updatedAt |
| Ticket (`get_ticket`) | All of the above, plus the plain-text description (truncated at 2,000 characters, flagged), `isEscalated`, `firstResponseDueBy`, requester `{id, name, email}` |
| Contact (`search_contacts` by name) | id, name |
| Contact (`search_contacts` by fields) | id, name, email, companyId, verified |
| Contact (`get_contact`) | id, name, email, phone, mobile, companyId, jobTitle, language, timeZone, verified, tags, createdAt, updatedAt |

The ticket **description is customer-written text** and can contain anything the customer typed, including personal data. The agent should treat it as data, never as instructions (the server's instructions say so).

## Data not exposed

Freshdesk returns these fields, but the connector deliberately drops them:

- **Tickets:** the HTML `description`, `cc_emails`, `fwd_emails`, `reply_cc_emails`, `to_emails`, attachments and their URLs, `custom_fields`, spam and deleted flags, email-config and product IDs, and the requester's phone and mobile (available through `get_contact` when actually needed)
- **Contacts:** postal address, `description` (internal notes about the customer), other emails, other companies, Twitter or social handles, `unique_external_id`, avatar, devices, and `custom_fields` (which on a merchant's account could hold KYC or payment-related data)
- **Never anything about the connector itself:** API key, headers, internal errors or stack traces

Tests assert that these fields are absent, so a code change can't quietly start exposing them.

## Authentication

- The connector authenticates to Freshdesk with **one API key** from `FRESHDESK_API_KEY`, using Freshdesk's documented HTTP Basic scheme. The key belongs to one Freshdesk **agent account**.
- **Authentication boundary:** the agent (the LLM) never sees or handles the credential. The key lives in the server process, is sent only to `https://<subdomain>.freshdesk.com` over HTTPS, is never forwarded on redirects, and never appears in tool results, errors or logs.
- **Authorization boundary**, in two layers:
  1. The **connector** limits *actions* to the five read-only tools.
  2. The **Freshdesk role** of the key's owner limits *data*: the connector can only read what that Freshdesk agent can read.

  So the recommended setup is a **dedicated Freshdesk agent with a restricted role** (only the relevant groups, no admin rights), not a personal admin key.
- The connector doesn't authenticate *its own* callers. It trusts the MCP host that launched it, as is normal for stdio servers. A hosted deployment would need per-request caller authentication; see [architecture.md §11](architecture.md#11-production-considerations).

## Security considerations

- **Least privilege:** read-only actions, a minimized data set, and a recommended restricted Freshdesk role.
- **No injection surface:** inputs are typed and bounded. Freshdesk filter queries are built by the connector, and string values are limited to a safe character set (no quotes).
- **Prompt injection through ticket content:** a malicious ticket could contain text like "ignore your instructions and…". Read-only access limits what such text can cause. The worst case is the agent showing the user misleading content, not taking an action. The server instructions mark ticket and contact text as untrusted data.
- **PII:** customer names, emails and (via `get_contact`) phone numbers reach the agent's context. The host's logging and retention policy for conversations therefore applies to this data. The connector itself stores nothing.
- **Rate limits are shared** with the merchant's other Freshdesk integrations. The connector retries politely (Retry-After, jitter, bounded) and stops within 45 s, but an agent in a loop can still use up quota. Hosts should cap tool calls per conversation.
- **Logs** contain paths, status codes and error codes only: no headers, no query values, no payloads.

## Human approval requirements

**Why read-only is the right starting point.** Reading is reversible and low-risk, and it already covers most of the value: answering status questions, summarizing a customer's history, triaging queues. Writes to a support system reach customers directly (replies), change commitments (status, SLA) and can't be undone (deletes). An LLM can be wrong, or be manipulated by ticket content, so those actions need a human in the loop before they're automated.

**Today:** no tool needs approval, because no tool changes anything. Hosts may use the read-only annotations to skip confirmation prompts.

**If write tools are added later, approval should be required as follows:**

| Action | Approval |
|---|---|
| Add a **private** note | Recommended at first; possibly auto-approved later for low-risk, audited cases |
| Change status, priority, tags or assignment | **Required** (show the before/after diff) |
| **Reply to a customer** (anything customer-visible) | **Required, every time**, with the exact text shown to a human before sending |
| Close or merge tickets | **Required** |
| Delete tickets or contacts, modify contacts | **Not offered** to agents |

Write tools would also need a separate write-scoped credential, audit logging, and no automatic retries without idempotency protection; see [architecture.md §10.7](architecture.md#107-how-would-write-operations-be-added-safely).

## Limitations

What the agent should know it can't do, even within read access:

- **No free-text search** of ticket subjects or descriptions. Freshdesk's filter API supports only structured fields.
- **`search_tickets` scope:** at most 300 results, archived tickets excluded, and a lag of a few minutes after ticket changes. It can't filter by customer; use `list_tickets` with `requester_email`.
- **`list_tickets` window:** only tickets **created in the last 30 days** unless `updated_since` is given. Results can shift between pages if tickets change mid-scan.
- **Name search** is a word-prefix match ("Ash" finds "Asha Rao"; "sha" doesn't) and returns at most 30 matches. Phone and mobile search need the exact stored format.
- **Account-specific details:** custom statuses appear as `"custom (N)"` and can't be searched by name, and custom fields aren't available.
- **IDs only for related records:** agent, group and company IDs aren't resolved to names.
- **One helpdesk** per server instance.
