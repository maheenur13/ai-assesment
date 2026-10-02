# BluBird Shop

This is a minimal e-commerce backend (products, customers, orders) with an LLM shopping assistant
that answers questions about the catalog. Later tasks add ordering through chat and operator bulk
import. It is built over four time-boxed tasks; this README describes the **current state
(Task 1)**.

- **Run it:** see [RUN.md](RUN.md). It's one command, and the database is seeded automatically.
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
│                (read-only catalog tools → ProductService) · service.ts (prompt, bounded tool
│                loop, conversations) · routes.ts (POST /api/v1/chat)
├── openapi.ts   OpenAPI 3.1 document built from the same zod schemas
└── seed.ts      idempotent fixture loader (runs on every start)
Postgres 17 via Prisma 7 (driver adapter, SQL migrations with CHECK constraints)
```

The services are the only layer that touches the database. The assistant's tools call the same
services as the REST API, so authorization and business rules can't be bypassed through chat.

## API

| Method | Path                                    | Who      | Notes                                                                                  |
| ------ | --------------------------------------- | -------- | -------------------------------------------------------------------------------------- |
| GET    | `/healthz`, `/readyz`                   | anyone   | liveness / readiness (DB check)                                                        |
| GET    | `/api/v1/products`                      | anyone   | active products; `q`, `category`, `minPrice`, `maxPrice`, `inStock`, `limit`, `cursor` |
| GET    | `/api/v1/products/{id}`                 | anyone   | inactive products are visible to the operator only                                     |
| POST   | `/api/v1/products`                      | operator | 201 + `Location`; duplicate SKU → 409                                                  |
| PATCH  | `/api/v1/products/{id}`                 | operator | partial update; SKU is immutable                                                       |
| POST   | `/api/v1/customers`                     | operator | returns the customer's API token **once**                                              |
| GET    | `/api/v1/customers/{id}`                | operator |                                                                                        |
| GET    | `/api/v1/me`                            | customer |                                                                                        |
| POST   | `/api/v1/orders`                        | customer | requires an `Idempotency-Key` header; atomic stock decrement                           |
| GET    | `/api/v1/orders`, `/api/v1/orders/{id}` | customer | the caller's own orders only; others → 404                                             |
| POST   | `/api/v1/chat`                          | anyone   | catalog assistant; `{conversationId?, message}` → `{conversationId, reply, products}`  |

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

**Live evals (measured 2026-10-03, `pnpm eval`, opt-in, real model):**

| Model                        | Result | Notes                                                                                     |
| ---------------------------- | ------ | ----------------------------------------------------------------------------------------- |
| `anthropic/claude-haiku-4.5` | 8/8    | 31 s for 8 questions; uses `**bold**` markdown despite the plain-text instruction         |
| `openai/gpt-4o-mini`         | 8/8    | first run 7/8: it filtered "in stock?" and wrongly said the SSD isn't sold → tool changed |

The 8 checks are: an exact catalog price, a search with a price limit, an out-of-stock product, a
nonexistent product (no invented price), an inactive product, an off-topic question, an ambiguous
question (asks for clarification) and a prompt-extraction attempt. The checks are coarse regexes,
and one run per model is a smoke test, not a benchmark.

## Tests

`pnpm test` runs **105 tests** (plus 8 opt-in live evals, skipped by default) with vitest + supertest against a real Postgres database (`shop_test`),
which is reset and re-seeded before every test.

- `tests/api/`: product, customer and order behaviour. This covers validation, pagination, pricing
  snapshots, insufficient stock and the atomic rollback, **concurrent orders not overselling**, and
  idempotent replay (including concurrent duplicates).
- `tests/assistant/`: the chat flow with a scripted `FakeLlm` (no network). It covers grounded
  answers, nonexistent and inactive products, filters, history and trimming, validation, provider
  failure → 503 with the conversation unchanged, a missing key, the tool-round cap, invalid or
  unknown tool calls, and empty model answers. It also has unit tests for the provider client
  (HTTP errors, malformed responses, timeouts).
- `tests/evals/`: opt-in live-model evals (`pnpm eval`). They are skipped in `pnpm test`.
- `tests/adversarial/`: BOLA (another customer's orders), mass assignment (`customerId`, prices,
  ids), token forgery and wrong roles, malformed or oversized or non-JSON bodies, injection-shaped
  input, prototype pollution, forged request ids, rate limiting, security headers, and no stack
  traces in responses. For the assistant: conversation isolation between customers and anonymous
  callers, forged history or roles or `customerId` in the body, user text never merged into the
  system prompt, prices stated without a tool producing no records, hostile product descriptions
  delivered as JSON tool data, description truncation, SQL-shaped search text and the chat rate
  limit.

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
- The SKU is the product's immutable business key (Task 3 imports will upsert by SKU).
- The assistant answers in the catalog's language (English). Prices are always in the store
  currency.
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
- **Chat UI:** planned for Task 2 together with order confirmation (curl and `/docs` are enough for
  catalog Q&A).

## Incomplete work

- None known for Task 1.
- The live evals are a single run per model with coarse checks. They show the grounding works but
  are not a statistically meaningful measurement.

## Third-party services

| Provider     | Service                                                                                          | Purpose           | Task |
| ------------ | ------------------------------------------------------------------------------------------------ | ----------------- | ---- |
| Docker Hub   | `node:22-slim`, `postgres:17-alpine` images                                                      | Runtime           | 0+   |
| npm registry | Packages (installed from the lockfile at build)                                                  | Build             | 0+   |
| jsDelivr     | CDN serving the pinned `@scalar/api-reference@1.72.4` script for `/docs` (loaded by the browser) | API reference UI  | 0+   |
| OpenRouter   | OpenAI-compatible chat completions with tool calling (`anthropic/claude-haiku-4.5` by default)   | Catalog assistant | 1+   |

The only outbound call the server makes is to the model provider, and only when `OPENAI_API_KEY` is
set. Its key is not shipped: it's a model key, so per the brief there is no `.env` in the
submission. Without the key, everything except `/chat` works. The `/docs` page loads a pinned
script from jsDelivr in the browser; the API works without it.

## Time spent

Times are self-reported from my own clock (UTC+6). The raw session transcripts carry the timestamps.

**Transcripts** (`transcripts/task-N.jsonl`, submission zip only) are the raw Claude Code session
logs, one session per task. When a session used subagents, their JSONL lines are appended verbatim
after the main session's lines. Each line carries its own `agentId`/`sessionId`, and nothing is
edited or removed.

| Task | Start            | End              | Duration | Notes                                                                                                                                                 |
| ---- | ---------------- | ---------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | 2026-10-03 02:17 | 2026-10-03 03:43 | 86 min   | ~23 min planning and research, ~34 min building and verifying the backend (first push at 03:14), ~29 min adding the Claude Code tooling in `.claude/` |
| 1    | 2026-10-03 03:49 | 2026-10-03 04:15 | 26 min   | ~15 min building and testing the assistant (incl. two live eval runs and a fix found by them), ~11 min clean-clone verification and finishing         |

**Note on Task 0's history:** `task-0` was first pushed at 03:14. I then decided the Claude Code
tooling was part of the foundation, so I amended the commit and re-pushed `main` and the `task-0`
tag (force push) before anything was submitted. It is still one commit for Task 0, and the
transcript shows both pushes.
