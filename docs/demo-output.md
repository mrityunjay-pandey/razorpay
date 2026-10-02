# Demo output (mock mode)

> **This is a MOCK run, not a real Freshdesk integration run.** The connector code is the real production code: config validation, `FreshdeskClient`, services and MCP server, driven by a real MCP client. The Freshdesk side is the fictional in-process simulation in [`demo/mock-freshdesk.ts`](../demo/mock-freshdesk.ts). All names, emails and tickets are fictional. The rate-limit responses in step 7 are deliberately simulated.
>
> Reproduce with `npm run demo`. To run the same steps against a real (demo) account, use `npm run demo:live` (see the README).

```text
╔═════════════════════════════════════════════════════════════════════════╗
║ MOCK MODE: simulated Freshdesk, fictional data, no network calls.       ║
║ The connector code is real; the Freshdesk server is a local simulation. ║
║ This is NOT a run against a real Freshdesk account.                     ║
╚═════════════════════════════════════════════════════════════════════════╝

── STEP 1 · Authentication ──────────────────────────────────────────────
   Config validated at startup: baseUrl=https://demo-mock.freshdesk.com/api/v2, API key loaded (never printed)
   Auth scheme: HTTP Basic, API key as username, 'X' as password (per Freshdesk docs).
   Misconfiguration is refused at startup:
     Invalid Freshdesk configuration:
     - FRESHDESK_DOMAIN must use HTTPS; Freshdesk only serves its API over HTTPS.
     - FRESHDESK_API_KEY is not set (Freshdesk > Profile Settings > View API Key).
   A deliberately wrong API key:
   → list_tickets {"per_page":1}
   ← isError: {"error":{"code":"AUTHENTICATION_ERROR","message":"Freshdesk rejected the connector's credentials. The operator should check FRESHDESK_API_KEY and FRESHDESK_DOMAIN.","retryable":false}}

── STEP 2 · MCP discovery (tools/list) ──────────────────────────────────
   search_tickets   readOnlyHint=true  Search Freshdesk tickets
   list_tickets     readOnlyHint=true  List Freshdesk tickets
   get_ticket       readOnlyHint=true  Get a Freshdesk ticket
   search_contacts  readOnlyHint=true  Search Freshdesk contacts
   get_contact      readOnlyHint=true  Get a Freshdesk contact

── STEP 3 · list_tickets (pagination) ───────────────────────────────────
   → list_tickets {"per_page":3,"updated_since":"2015-01-01"}
      #1005  [open/urgent]  Duplicate charge on customer card  (requester 5002)
      #1002  [open/urgent]  Settlement delayed for 2 days  (requester 5002)
      #1001  [open/high]  Refund not received for order #A-1001  (requester 5001)
   pagination.hasMore = true
   → list_tickets {"per_page":3,"page":2,"updated_since":"2015-01-01"}
      #1003  [pending/low]  How do I add a new bank account?  (requester 5001)
      #1004  [resolved/medium]  Payment link expired too early  (requester 5003)
   pagination.hasMore = false

── STEP 4 · search_tickets (structured filter) ──────────────────────────
   → search_tickets {"status":["open"],"priority":["high","urgent"]}
   Freshdesk query built by the connector: "status:2 AND (priority:3 OR priority:4)"
      #1001  [open/high]  Refund not received for order #A-1001  (requester 5001)
      #1002  [open/urgent]  Settlement delayed for 2 days  (requester 5002)
      #1005  [open/urgent]  Duplicate charge on customer card  (requester 5002)
   total = 3

── STEP 5 · get_ticket (normalized detail) ──────────────────────────────
   → get_ticket {"ticket_id":1001}
      {
        "id": 1001,
        "subject": "Refund not received for order #A-1001",
        "status": "open",
        "priority": "high",
        "type": "Refund",
        "source": "email",
        "requesterId": 5001,
        "agentId": 9001,
        "groupId": 77,
        "companyId": 301,
        "tags": [
          "refund"
        ],
        "dueBy": "2026-10-05T10:00:00Z",
        "createdAt": "2026-09-29T08:15:00Z",
        "updatedAt": "2026-09-29T08:15:00Z",
        "description": "Fictional description for: Refund not received for order #A-1001",
        "descriptionTruncated": false,
        "isEscalated": false,
        "isSpam": false,
        "firstResponseDueBy": "2026-10-03T10:00:00Z",
        "requester": {
          "id": 5001,
          "name": "Asha Example",
          "email": "asha@example.com"
        }
      }
   Dropped from the raw payload: HTML description, cc_emails, attachments, custom_fields, requester phone.

── STEP 6 · get_contact / search_contacts ───────────────────────────────
   → get_contact {"contact_id":5001}
      {
        "id": 5001,
        "name": "Asha Example",
        "email": "asha@example.com",
        "phone": "+91 00000 00001",
        "mobile": null,
        "companyId": 301,
        "jobTitle": "Store Owner",
        "language": "en",
        "timeZone": "Chennai",
        "verified": true,
        "tags": [
          "merchant"
        ],
        "createdAt": "2026-01-10T09:00:00Z",
        "updatedAt": "2026-09-01T12:00:00Z"
      }
   Dropped: address, internal notes (description), other emails, custom fields, avatar.
   → search_contacts {"name":"Ash"}
   ← {"matchedBy":"name","contacts":[{"id":5001,"name":"Asha Example"}],"pagination":{"page":1,"perPage":30,"hasMore":false}}
   → search_contacts {"email":"asha@example.com"}
   ← {"matchedBy":"fields","contacts":[{"id":5001,"name":"Asha Example","email":"asha@example.com","companyId":301,"verified":true}],"pagination":{"page":1,"perPage":10,"hasMore":false}}

── STEP 7 · Rate-limit handling (HTTP 429) ──────────────────────────────
   SIMULATION: the mock answers the next request with 429 + Retry-After: 1
   → get_ticket {"ticket_id":1001}
     [connector log] freshdesk_retry {"path":"/tickets/1001","attempt":1,"delayMs":1000,"code":"RATE_LIMITED","status":429}
   ← recovered after retry: isError=false
   SIMULATION: the mock answers every request with 429 and no Retry-After
   → get_ticket {"ticket_id":1001}
     [connector log] freshdesk_retry {"path":"/tickets/1001","attempt":1,"delayMs":314,"code":"RATE_LIMITED","status":429}
     [connector log] freshdesk_retry {"path":"/tickets/1001","attempt":2,"delayMs":219,"code":"RATE_LIMITED","status":429}
     [connector log] freshdesk_retry {"path":"/tickets/1001","attempt":3,"delayMs":939,"code":"RATE_LIMITED","status":429}
   ← isError: {"error":{"code":"RATE_LIMITED","message":"Freshdesk's API rate limit was exceeded. The connector retried 3 times without success.","retryable":true}}

── STEP 8 · Validation and normalized errors ────────────────────────────
   → get_ticket {"ticket_id":987654321}
   ← isError: {"error":{"code":"NOT_FOUND","message":"The Freshdesk ticket with ID 987654321 was not found.","retryable":false}}
   → get_ticket {"ticket_id":"abc"}
   ← isError: MCP error -32602: Input validation error: Invalid arguments for tool get_ticket: ticket_id must be a positive integer such as 12345 (a number, not a string). at ticket_id
   → list_tickets {"status":["open"]}
   ← isError: MCP error -32602: Input validation error: Invalid arguments for tool list_tickets: list_tickets does not accept "status". Allowed arguments: page, per_page, requester_email, requester_id, company_id, updated_since, order_by, order_type. To filter by status, priority, type, tags, agent, group or dates, use search_tickets.
   → search_contacts {"name":"Asha","email":"asha@example.com"}
   ← isError: {"error":{"code":"VALIDATION_ERROR","message":"Search contacts by name OR by email/phone/mobile/company_id, not both in one call.","retryable":false}}
   → delete_ticket {"ticket_id":1001}
   ← isError: MCP error -32602: Tool delete_ticket not found

Done (mock). HTTP requests handled by the simulation: 15.
```
