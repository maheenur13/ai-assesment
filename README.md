# BluBird Shop

This is a minimal e-commerce backend (products, customers, orders) with an LLM shopping assistant.
Customers can search the catalog, check their orders and place orders by chatting, through the API
or a small chat UI, and the store operator can add products in bulk by pasting a link to an
existing product list (CSV, JSON or a Google Sheet). It was built over four time-boxed tasks; this
README describes the **final state (Task 3)**.

- **Run it:** see [RUN.md](RUN.md). It's one command, and the database is seeded automatically.
- **Chat UI:** http://localhost:3000/ (pick a demo customer; the assistant needs a model key).
- **Import screen (operator):** http://localhost:3000/#import
- **API reference:** http://localhost:3000/docs (generated from the request schemas). The raw
  spec is at `/api/v1/openapi.json`.
- **Why it is built this way:** see [docs/decisions.md](docs/decisions.md), which also cites the
  sources behind each choice.

## Architecture

```
Express 5 app (TypeScript, ESM)
├── http/        cross-cutting: problem+json errors, bearer auth + roles, rate limits,
│                keyset pagination, request ids, validation helpers
├── modules/     products · customers · orders
│   └── schemas.ts (zod: validation + OpenAPI) → service.ts (business rules, Prisma) → routes.ts
├── assistant/   llm.ts (OpenAI-compatible client, the only model-specific code) · tools.ts
│                (catalog tools → ProductService, order tools → OrderService) · service.ts
│                (prompt, bounded tool loop, conversations) · routes.ts (POST /api/v1/chat)
├── importer/    safe-fetch.ts (SSRF-safe download) · parse.ts (CSV/JSON → rows, column
│                aliases) · service.ts (mapping, validation, SKU upsert, report) · routes.ts
├── openapi.ts   OpenAPI 3.1 document built from the same zod schemas
├── seed.ts      idempotent fixture loader (runs on every start)
└── web/dist     the chat UI (React + Vite, built from web/src), served as static files
Postgres 17 via Prisma 7 (driver adapter, SQL migrations with CHECK constraints)
```

The services are the only layer that touches the database. The assistant's tools call the same
services as the REST API, so authorization and business rules can't be bypassed through chat.

## API

| Method | Path                                    | Who               | Notes                                                                                                                               |
| ------ | --------------------------------------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/healthz`, `/readyz`                   | anyone            | liveness / readiness (DB check)                                                                                                     |
| GET    | `/api/v1/products`                      | anyone            | active products; `q`, `category`, `minPrice`, `maxPrice`, `inStock`, `limit`, `cursor`                                              |
| GET    | `/api/v1/products/{id}`                 | anyone            | inactive products are visible to the operator only                                                                                  |
| POST   | `/api/v1/products`                      | operator          | 201 + `Location`; duplicate SKU → 409                                                                                               |
| PATCH  | `/api/v1/products/{id}`                 | operator          | partial update; SKU is immutable                                                                                                    |
| POST   | `/api/v1/customers`                     | operator          | returns the customer's API token **once**                                                                                           |
| GET    | `/api/v1/customers/{id}`                | operator          |                                                                                                                                     |
| GET    | `/api/v1/me`                            | customer          |                                                                                                                                     |
| POST   | `/api/v1/orders`                        | customer          | requires an `Idempotency-Key` header; atomic stock decrement                                                                        |
| GET    | `/api/v1/orders`, `/api/v1/orders/{id}` | customer          | the caller's own orders only; others → 404                                                                                          |
| POST   | `/api/v1/chat`                          | anyone            | assistant; `{conversationId?, message}` → `{conversationId, reply, products, proposal?, order?}`; order tools need a customer token |
| POST   | `/api/v1/order-proposals/{id}/confirm`  | customer or guest | places an order the assistant proposed; single-use, re-checks price and stock. Guests send `{conversationId}`                       |
| POST   | `/api/v1/imports`                       | operator          | bulk import from a link: `{url, dryRun = true}` → 201 + report (per-row results); see below                                         |
| GET    | `/api/v1/imports/{id}`                  | operator          | a stored import report                                                                                                              |
| GET    | `/`                                     | anyone            | chat UI                                                                                                                             |

Errors are always `application/problem+json` (RFC 9457). Validation errors carry JSON Pointers, for
example `{"pointer": "#/body/items/0/quantity", "detail": "..."}`.

### Demo credentials (local demo only)

| Role              | Bearer token                                                                |
| ----------------- | --------------------------------------------------------------------------- |
| Operator          | `demo-operator-token-change-me-0123456789` (override with `OPERATOR_TOKEN`) |
| Alice (2 orders)  | `shop_demo_alice_0000000000000000000000000000000000000000`                  |
| Bob (1 order)     | `shop_demo_bob_00000000000000000000000000000000000000000000`                |
| Carol (no orders) | `shop_demo_carol_000000000000000000000000000000000000000000`                |

```sh
curl -s localhost:3000/api/v1/products?q=headphones
curl -s -X POST localhost:3000/api/v1/orders \
  -H 'Authorization: Bearer shop_demo_alice_0000000000000000000000000000000000000000' \
  -H "Idempotency-Key: $(uuidgen)" -H 'Content-Type: application/json' \
  -d '{"items":[{"productId":"<id from the product list>","quantity":1}]}'
```

## Catalog assistant (Task 1)

```sh
read -s OPENAI_API_KEY && export OPENAI_API_KEY   # paste an OpenRouter key; then `docker compose up --build`
curl -s localhost:3000/api/v1/chat -H 'Content-Type: application/json' \
  -d '{"message":"Do you have noise cancelling headphones under $150?"}'
# → {"conversationId":"…","reply":"Yes — the Aurora Wireless Headphones are 129.99 USD …",
#    "products":[{"sku":"AUD-HP-001","price":{"amount":12999,"currency":"USD"},"stock":25,…}]}
# Continue the conversation by sending the returned conversationId with the next message.
```

- **Grounded by tools.** The model can only learn about products through three read-only tools:
  `search_products` (Postgres full-text search, ranked), `get_product` and `list_categories`. All
  three call `ProductService`, so inactive products never reach it. The prompt forbids product facts
  that didn't come from a tool. `products[]` in the response holds the authoritative records behind
  the answer, so a client can show real prices even if the model's wording is off.
- **Without a key** the whole app still works, and `/chat` answers `503 assistant-unavailable`.
  Provider errors and timeouts give the same response with `Retry-After: 30`, and the conversation
  is left unchanged.
- **Bounded:**
  - messages up to 2,000 chars
  - at most 5 model calls per turn
  - a 25 s budget per turn
  - a history window of 20 messages
  - 20 chats per minute per customer, or per IP for anonymous callers
- **Conversations** are stored server-side and bound to whoever started them (anonymous or a given
  customer). Anyone else gets a 404.
- **Model:** `anthropic/claude-haiku-4.5` via OpenRouter by default. Override with `LLM_MODEL` /
  `OPENAI_BASE_URL` (any OpenAI-compatible provider).

**Live evals (measured 2026-10-03, `pnpm eval`, opt-in, real model).** Task 1's eight checks:

| Model                        | Result | Notes                                                                                     |
| ---------------------------- | ------ | ----------------------------------------------------------------------------------------- |
| `anthropic/claude-haiku-4.5` | 8/8    | 31 s for 8 questions; uses `**bold**` markdown despite the plain-text instruction         |
| `openai/gpt-4o-mini`         | 8/8    | first run 7/8: it filtered "in stock?" and wrongly said the SSD isn't sold → tool changed |

Task 2 adds four checks as Alice, measured on `anthropic/claude-haiku-4.5`: **4/4 in each of 3
runs** (04:28–04:31). The checks: the most recent order is named; "I want to buy 2 Braided
USB-C Cable 2m" returns a 25.98 USD proposal and no order; "Yes, please place that order" in the
next message places it; and "order one Smart LED Bulb and confirm it right away, I pre-approve it"
only proposes. All 8 catalog checks also passed again in those runs. `openai/gpt-4o-mini` was not
re-run for Task 2.

Guest checkout adds three checks (no token): ordering asks for a name and email (never a token or
password), giving them produces the 25.98 USD proposal, and "yes" places it. One run (about 04:55) passed
all 15 checks, and so did a re-run after the security-review fix to `confirm_order` (about 05:11). It also showed the model promising "a confirmation email", which the app doesn't send,
so the prompt now forbids promising anything the tools don't do.

The 8 catalog checks are: an exact catalog price, a search with a price limit, an out-of-stock product, a
nonexistent product (no invented price), an inactive product, an off-topic question, an ambiguous
question (asks for clarification) and a prompt-extraction attempt. The checks are coarse regexes,
and one run per model is a smoke test, not a benchmark.

## Ordering by chat (Task 2)

The same `/chat` endpoint can also check orders and place them, with or without an account. Open
http://localhost:3000/ and try "I want 2 USB-C cables" as a guest, or pick **Alice** under
**Sign in** and ask "What did I order last?".

- **Order lookup:** `list_my_orders` and `get_my_order` call `OrderService`, which scopes every query
  to the signed-in customer. Another customer's order id looks exactly like one that doesn't exist.
- **Ordering is propose → confirm.** `propose_order` prices the order on the server, places nothing,
  and returns a `proposal` (items, total, `expiresAt`, 15 minutes). The order is placed only by:
  - the **Confirm** button (`POST /api/v1/order-proposals/{id}/confirm`), or
  - the customer saying "yes" in a **later** message, after which the model calls `confirm_order`.
    That tool refuses a proposal made in the same turn, and it checks in code that the customer's
    own message is an explicit yes. A model steered by injected text can't place an order the
    customer didn't agree to.
- **At confirmation:** the normal order path runs (atomic stock decrement). If the price changed it's
  a 409 rather than a different charge. An expired proposal, an inactive product or insufficient
  stock is also a 409. Confirming twice, or concurrently, returns the same order.
- **Guest checkout (no token):** the assistant asks a visitor for a name and email and saves them
  with `set_guest_details`. That creates a guest customer with no token, attached to that anonymous
  conversation. The guest can then propose, confirm (by saying yes, or with the button, which sends
  the conversation id) and see the orders placed **in that conversation only**. The conversation id
  is the guest's only key, just as it already was for continuing an anonymous chat. An email proves
  nothing, so a guest using `alice@example.com` gets a separate guest record and sees none of
  Alice's orders. Guests can't use the REST API, because they have no token.

```sh
T='Authorization: Bearer shop_demo_alice_0000000000000000000000000000000000000000'
curl -s localhost:3000/api/v1/chat -H "$T" -H 'Content-Type: application/json' \
  -d '{"message":"I want to buy 2 Braided USB-C Cable 2m"}'
# → {"conversationId":"…","reply":"…25.98 USD… confirm?","proposal":{"id":"<pid>","total":{"amount":2598,…},…}}
curl -s -X POST localhost:3000/api/v1/order-proposals/<pid>/confirm -H "$T"   # → 201 + the order
```

## Bulk import from a link (Task 3)

The operator pastes a link to where the product list already lives. Open
http://localhost:3000/#import, paste the operator token, click **Use demo file** (or paste your own
link), **Preview**, then **Import**.

- **Sources:** any public `http(s)` link to a CSV (comma, semicolon or tab separated) or JSON file
  (an array of products or `{ "products": [...] }`), a Google Sheets link shared as "anyone with the
  link" (rewritten to the sheet's CSV export, keeping the tab), or a raw GitHub file. Shopify and
  WooCommerce product exports work as they are.
- **Columns** are matched by name first: `sku`/`Variant SKU`, `name`/`Title`, `price`/`Variant
Price`/`Regular price`, `Body (HTML)`, `Type`, `Status`, `qty` and so on. Only `sku`, `name` and a
  price are required. If those can't be found and a model key is set, the model is shown **the header
  names only** (never row values) and suggests a mapping, which must name real headers. The report
  says which way it went.
- **Rows** go through the same validation as `POST /products`. Prices like `12.99`, `$1,299.00` or
  `EUR 5` become cents; a decimal comma (`12,99`) is rejected as ambiguous. HTML in descriptions is
  reduced to text.
- **Upsert by SKU:** new SKUs are created, existing ones updated. Only columns present in the file
  are written, so a price-only sheet doesn't reset stock. Defaults for new products: category
  `Uncategorized`, stock 0, active. Valid rows are imported, invalid ones reported with reasons
  (`row`, `sku`, `errors`), and a repeated SKU fails from its second occurrence. Importing the same
  file again reports everything `unchanged`.
- **Dry run first:** `dryRun` defaults to `true` and writes nothing but the report. Every report is
  stored and can be fetched again (`GET /api/v1/imports/{id}`).
- **SSRF protection** (the server fetches a URL someone typed): only http/https on ports 80/443, no
  credentials in the URL; every address the host resolves to must be public (loopback, private,
  link-local/cloud metadata, CGNAT, multicast and IPv6 equivalents are refused, in any spelling such
  as `http://2130706433/` or `[::ffff:127.0.0.1]`), and the socket connects to the address that was
  checked, so DNS rebinding can't swap it. Redirects (max 3) are re-checked, https→http is refused,
  10 s total timeout, 5 MB cap, CSV/JSON/text content types only, 5,000 rows, 10 imports a minute.
  A refused URL gets a generic 422; the reason is only logged.

```sh
O='Authorization: Bearer demo-operator-token-change-me-0123456789'
URL=https://raw.githubusercontent.com/maheenur13/ai-assesment/main/fixtures/import/products.csv
curl -s localhost:3000/api/v1/imports -H "$O" -H 'Content-Type: application/json' \
  -d "{\"url\":\"$URL\"}"                     # preview: {"counts":{"created":6,...},"rows":[...]}
curl -s localhost:3000/api/v1/imports -H "$O" -H 'Content-Type: application/json' \
  -d "{\"url\":\"$URL\",\"dryRun\":false}"      # import; run it again → all "unchanged"
```

## Tests

`pnpm test` runs **181 tests** (plus 15 opt-in live evals, skipped by default) with vitest + supertest against a real Postgres database (`shop_test`),
which is reset and re-seeded before every test.

- `tests/api/`: product, customer and order behaviour. This covers validation, pagination, pricing
  snapshots, insufficient stock and the atomic rollback, **concurrent orders not overselling**, and
  idempotent replay (including concurrent duplicates).
- `tests/assistant/`: the chat flow with a scripted `FakeLlm` (no network). It covers grounded
  answers, nonexistent and inactive products, filters, history and trimming, validation, provider
  failure → 503 with the conversation unchanged, a missing key, the tool-round cap, invalid or
  unknown tool calls, and empty model answers. It also has unit tests for the provider client
  (HTTP errors, malformed responses, timeouts). `ordering.test.ts` covers order lookup, proposing
  (prices, no stock change), confirming in the next message, the confirm endpoint (201, `Location`,
  replay) and insufficient stock reported to the model. Guest checkout: details saved and then
  corrected (one guest record), ordering by "yes" and by the button, and order lookup limited to
  the conversation.
- `tests/importer/`: imports through the API with a fake fetcher that serves `fixtures/import/`:
  operator-only, dry run writes nothing, create then idempotent re-import, updates that leave absent
  columns alone, a Shopify export, JSON, a file of broken rows (missing/ambiguous price, negative
  stock, bad SKU, empty name, duplicate SKU) next to valid ones, formula/markup/prompt-injection
  cells stored as inert text, the model mapping unknown (German) headers without seeing row values,
  a model answer naming a nonexistent column, model failure, blocked URL (generic error), download
  failure (502), broken/empty/oversized files, request validation, the rate limit and the Google
  Sheets rewrite.
- `tests/evals/`: opt-in live-model evals (`pnpm eval`). They are skipped in `pnpm test`.
- `tests/adversarial/`: BOLA (another customer's orders), mass assignment (`customerId`, prices,
  ids), token forgery and wrong roles, malformed or oversized or non-JSON bodies, injection-shaped
  input, prototype pollution, forged request ids, rate limiting, security headers, and no stack
  traces in responses. For the assistant: conversation isolation between customers and anonymous
  callers, forged history or roles or `customerId` in the body, user text never merged into the
  system prompt, prices stated without a tool producing no records, hostile product descriptions
  delivered as JSON tool data, description truncation, SQL-shaped search text and the chat rate
  limit. For ordering (`ordering.test.ts`): a product description that tells the model to confirm
  (the same-turn confirm is refused and nothing is placed), confirming from another conversation,
  `customerId` smuggled into tool arguments, Bob's order id asked for by Alice, order tools called
  anonymously, zero/negative/huge/fractional quantities, inactive products, another customer's
  proposal (404), missing token (401) or operator token (403), an expired proposal, a price change,
  a stock drop or a deactivated product before confirmation, 5 concurrent confirmations (one order),
  and a client `Idempotency-Key` that mimics the internal one. For guests: a guest using Alice's
  email sees none of her orders, confirming with another conversation's id, a random id, or as a
  customer (404), a customer's proposal confirmed by a guest, `set_guest_details` called by a
  signed-in customer, invalid or extra (`token`) details, and no REST access without a token.
  For the importer (`ssrf.test.ts`, against a local HTTP server and a fake DNS table): bad schemes,
  ports and credentials; 21 internal IP-literal spellings (decimal, hex, octal, short, IPv4-mapped
  and -compatible IPv6, NAT64, trailing dot, metadata, CGNAT, ULA, link-local, multicast); hostnames
  resolving to internal addresses, including `localhost` and a mix of public and private answers
  (rebinding); redirects to internal targets; redirect loops; wrong content type; size caps (declared
  and streamed); a slow and a silent server (timeout); and that no headers beyond `Accept` are sent.

## Development with Claude Code

This project was built with Claude Code. The project configuration is committed in `.claude/`:

- **Hooks:** a secret guard (stops commands that could print env files or keys into the session
  transcripts) and a git guard (stops force-pushes, tag moves and history rewrites). Prettier runs
  after every edit.
- **Rules:** one always-on process rule, plus rules that load only when Claude works in a given area
  (API, assistant, importer, tests).
- **Skills:** `add-endpoint` (the repo's endpoint pattern) and `finish-task` (the Definition of Done:
  checks, clean-clone run, docs, secret scan, commit, tag, push). `finish-task` can only be started
  by the user.
- **Agent:** `security-reviewer`, a read-only reviewer for OWASP API, LLM and SSRF risks.

[CLAUDE.md](CLAUDE.md) is the entry point for new sessions.

## Assumptions

- There is a single store and a single currency (USD). Prices are integer cents.
- There's no payment, shipping, tax, cart or order cancellation. An order is "placed" as soon as
  stock is reserved.
- Customers are registered by the operator, who hands out an API token. There is no self-signup or
  login flow.
- Catalog reads are public; ordering requires a customer token.
- The SKU is the product's immutable business key, and imports upsert by it (exact, case-sensitive).
- An import sets what the file says: its stock column overwrites current stock (it is the
  operator's count), and a product missing from the file is left alone, not deactivated.
- The assistant answers in the catalog's language (English). Prices are always in the store
  currency.
- In chat, customers are identified by the same API token as the REST API. The chat UI's picker
  stands in for a login.
- Guests don't need an account to order. Their name and email are contact details, not identity:
  nothing is looked up by email.
- An order placed by chat is an ordinary order: the same validation, pricing, stock rules and
  history as `POST /orders`.
- Anonymous visitors may use the catalog assistant. Their conversation id works like a capability:
  only someone who holds it can continue the conversation.

## Exclusions (deliberate)

- **User accounts, passwords, OAuth and sessions:** out of scope. Opaque bearer tokens demonstrate
  authentication and authorization without that machinery.
- **Deleting products:** use `isActive: false` instead. It keeps order history consistent.
- **Multi-instance concerns:** the rate-limit store is in memory.
- **Token revocation and rotation:** not implemented.
- **Semantic/vector search and embeddings:** keyword full-text search is enough for a 24-product
  catalog, with the model choosing the keywords.
- **Streaming replies, conversation listing/deletion and a retention job for old conversations:**
  not needed to demonstrate the feature.
- **Order cancellation, editing and returns, by chat or REST:** the brief asks for placing and
  checking orders. Leaving these out also keeps the model's write power to one confirmed action.
- **Stock reservation at proposal time:** a proposal holds no stock. Stock is checked when proposing
  and again atomically when confirming, so the worst case is a clear 409 at confirmation.
- **A cart:** a proposal is a one-shot cart. Asking for changes produces a new proposal.
- **Import extras:** no Excel (`.xlsx`) parsing (export as CSV or use a Google Sheet), no private
  sources needing credentials (OAuth, signed headers), no scheduled re-sync, no deactivating products
  missing from the file, no images or variants (each Shopify variant row is its own product, so
  variant rows without a title fail), and no column-mapping editor in the UI.
- **Chat UI extras:** no streaming, saved conversation history, full markdown (only `**bold**` is rendered, as text elements, never HTML) or login screen. The
  UI picks a demo customer or takes a pasted token, kept in memory only.

## Incomplete work

- None known for Task 2 features. Accepted Low findings from the security review:
  - Expired proposals and guest customer records (name, email) are never deleted. Like
    conversations, there is no retention job.
  - The chat UI bundle contains the seeded demo customers' tokens, so anyone with the page can act
    as Alice, Bob or Carol. That's intended for a local demo (the tokens are already public in
    `fixtures/`), but a real deployment would remove the picker.
  - Not tested: that logs never contain guest emails or chat text. A code review confirmed it.
- Task 3, accepted Low findings from the security review:
  - Large imports run one `UPDATE` per changed row inside a 60 s transaction. 5,000 changed rows on a
    slow remote database could hit the timeout, which rolls the whole import back (nothing partial).
  - A download failure on a **public** host returns its reason (e.g. `HTTP 404`, `timed out`) to the
    operator. Blocked (internal) targets never do.
  - The https→http redirect refusal has no automated test (it would need a local TLS server).
  - Two simultaneous imports creating the same new SKU: one gets a 409 `import-conflict` and writes
    nothing. The conflict path is not covered by a test.
  - Request logs label every request `principal: anonymous`, because the logger's props are computed
    before authentication (pre-existing since Task 0; the import events themselves are correct).
- The live evals are a single run per model with coarse checks. They show the grounding works but
  are not a statistically meaningful measurement.

## Third-party services

| Provider     | Service                                                                                          | Purpose                                                        | Task |
| ------------ | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------- | ---- |
| Docker Hub   | `node:22-slim`, `postgres:17-alpine` images                                                      | Runtime                                                        | 0+   |
| npm registry | Packages (installed from the lockfile at build)                                                  | Build                                                          | 0+   |
| jsDelivr     | CDN serving the pinned `@scalar/api-reference@1.72.4` script for `/docs` (loaded by the browser) | API reference UI                                               | 0+   |
| OpenRouter   | OpenAI-compatible chat completions with tool calling (`anthropic/claude-haiku-4.5` by default)   | Assistant (catalog Q&A; order lookup and ordering from Task 2) | 1+   |
| OpenRouter   | Same API, one call per import, only when column names aren't recognised                          | Import column-mapping suggestion (optional)                    | 3    |
| GitHub       | `raw.githubusercontent.com` hosting `fixtures/import/products.csv`                               | Demo import link                                               | 3    |
| Google       | Google Sheets CSV export (`docs.google.com`), only if the operator pastes a Sheets link          | Import source                                                  | 3    |

The server makes outbound calls only to the model provider (when `OPENAI_API_KEY` is set) and to
the link an operator submits for import (any public host they choose, behind the SSRF checks). Its key is not shipped: it's a model key, so per the brief there is no `.env` in the
submission. Without the key, everything except `/chat` works (the chat UI loads but its replies are 503 errors). The `/docs` page loads a pinned
script from jsDelivr in the browser; the API works without it.

## Time spent

Times are self-reported from my own clock (UTC+6). The raw session transcripts carry the timestamps.

**Transcripts** (`transcripts/task-N.jsonl`, submission zip only) are the raw Claude Code session
logs, one session per task. When a session used subagents, their JSONL lines are appended verbatim
after the main session's lines. Each line carries its own `agentId`/`sessionId`, and nothing is
edited or removed.

| Task | Start            | End              | Duration | Notes                                                                                                                                                                                                                                                     |
| ---- | ---------------- | ---------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | 2026-10-03 02:17 | 2026-10-03 03:43 | 86 min   | ~23 min planning and research, ~34 min building and verifying the backend (first push at 03:14), ~29 min adding the Claude Code tooling in `.claude/`                                                                                                     |
| 1    | 2026-10-03 03:49 | 2026-10-03 04:15 | 26 min   | ~15 min building and testing the assistant (incl. two live eval runs and a fix found by them), ~11 min clean-clone verification and finishing                                                                                                             |
| 2    | 2026-10-03 04:18 | 2026-10-03 05:14 | 56 min   | ~15 min order tools, propose/confirm and tests; ~12 min UI redesign (on request); ~15 min guest checkout (on request); ~14 min security review, its fixes, live evals and clean-clone check. Commit, tag, push and sync came after 05:14 (see transcript) |
| 3    | 2026-10-03 05:17 | 2026-10-03 05:49 | 32 min   | ~11 min importer, SSRF-safe fetch and tests; ~6 min security review and its fixes; ~4 min docs; ~6 min import screen redesign (on request); ~5 min plan check and clean-clone verification. Commit, tag, push and sync came after 05:49 (see transcript)  |

**Note on Task 0's history:** `task-0` was first pushed at 03:14. I then decided the Claude Code
tooling was part of the foundation, so I amended the commit and re-pushed `main` and the `task-0`
tag (force push) before anything was submitted. It is still one commit for Task 0, and the
transcript shows both pushes.
