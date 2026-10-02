# Decision log

Short ADR-style records. Each entry: decision, reason, consequence. Sources are listed at the end.

## Task 0 — Foundation

**D1. Modular monolith: Express 5 + TypeScript + Prisma 7 + Postgres 17.**
Chosen by the developer for familiarity and fit. One deployable with module boundaries
(`schemas → service → routes`) is enough for this scope; no microservices.
Prisma is pinned to 7.x: npm's `latest` tag points at an 8.0 release candidate with breaking changes.
TypeScript is pinned to 6.0.x because typescript-eslint does not support TS 7 yet.

**D2. Single `package.json`, no pnpm workspaces.** One server plus (from Task 2) a static React build.
A workspace adds lockfile and Docker complexity without benefit at this size.

**D3. API conventions.** Base path `/api/v1`; camelCase JSON; UUIDs (no enumerable ids); RFC 3339 UTC
timestamps; money as integer minor units `{ amount, currency }` with one store currency (USD);
keyset (cursor) pagination with `limit` default 20, clamped to 100; merge-patch semantics for `PATCH`.

**D4. Errors are RFC 9457 problem details** (`application/problem+json`) with a stable `type` slug,
`requestId`, and `errors[]` holding JSON Pointers into the request. Status codes follow RFC 9110:
400 malformed JSON, 422 schema/semantic validation, 401 with `WWW-Authenticate: Bearer`, 403 wrong
role, 404 for missing _or other customers'_ resources, 409 conflicts, 413/415, 429.
Malformed path ids are 404 (they cannot exist), not 422.

**D5. Authentication: opaque bearer tokens.** Customers get a `shop_`-prefixed 256-bit token, shown
once; only its SHA-256 is stored (a fast hash is fine for high-entropy tokens). The operator token
comes from the environment (min 32 chars) and is compared in constant time. A present-but-invalid
token is always 401, never downgraded to anonymous. No sessions, OAuth or passwords: out of scope.
Demo tokens for three customers are in `fixtures/seed/customers.json` so reviewers can try the API.

**D6. Authorization in the service layer.** Order queries include `customerId` in the `WHERE` clause
(OWASP API1/BOLA). The same services will back the assistant tools, so the LLM cannot bypass it.

**D7. Orders: atomic, server-priced, idempotent.**

- Prices are read from the catalog inside the transaction; clients cannot send prices (strict schemas).
- Stock is decremented with a conditional `UPDATE … WHERE stock >= qty` (Prisma `updateMany`), so
  concurrent orders cannot oversell under READ COMMITTED. Rows are locked in productId order to
  avoid deadlocks. Any failure rolls back the whole order.
- Name and unit price are snapshotted on order items.
- `Idempotency-Key` is required on `POST /orders` (IETF draft). The stored response is written in the
  same transaction as the order; a concurrent duplicate blocks on the unique `(customer, key)` index,
  rolls back, and replays the committed response. Same key with a different body → 422. Failed
  attempts store nothing, so a client may retry with the same key. Retention: 24 hours.
- An order cannot contain the same product twice (422: combine quantities); max 50 lines, 100 per line.
- Inactive products cannot be ordered; they remain visible to the operator and in order history.

**D8. Data integrity in the database too.** CHECK constraints (price > 0, stock ≥ 0, quantity > 0)
are added in migration SQL as a last line of defence behind application validation.

**D9. Seed is idempotent and non-destructive.** Runs on every container start, inserts only missing
rows (`skipDuplicates`), never overwrites operator edits or stock. Seeded historical orders do not
decrement stock.

**D10. Operational hardening.** helmet; `x-powered-by` off; no CORS (same-origin only); JSON body
limit 100 kB; 415 for non-JSON bodies; per-identity rate limits (pre-auth per IP, global, stricter for
orders); Postgres `statement_timeout` 5 s; Node request/header timeouts; `/healthz` (liveness, no DB)
and `/readyz` (DB check, 503 while shutting down); graceful SIGTERM shutdown; pino JSON logs with a
request id (accepted from `X-Request-Id` if well-formed) and no headers, bodies or tokens.

**D11. Container.** Multi-stage `node:22-slim`, production deps only, runs as `node`, `init: true`
(tini) so signals reach Node, `no-new-privileges`. Postgres is published on `127.0.0.1:55432` only,
so the host can run tests without the database being reachable from the network.

**D12. OpenAPI 3.1 generated from the zod schemas** (`@asteasolutions/zod-to-openapi`), served at
`/api/v1/openapi.json` with a Scalar reference UI at `/docs` (relaxed CSP on that route only). The UI script comes from
jsDelivr at a pinned version, so the browser never runs an unreviewed "latest".

**D13. Supply chain.** Committed lockfile, `--frozen-lockfile` in Docker, pnpm `minimumReleaseAge`
of 24 h, and install scripts allowed only for an explicit package list.

**D14. Code quality gates.** TypeScript strict (+ `noUncheckedIndexedAccess`,
`exactOptionalPropertyTypes`), ESLint type-checked rules, Prettier. Husky runs lint-staged and the
typecheck on commit and the test suite on push.

**D15. Claude Code configuration is part of the repo** (`.claude/`), following Anthropic's guidance
to commit shared project settings, hooks, rules, skills and agents. Hooks enforce what must never
happen: secrets printed into the submitted transcripts, or rewritten git history. Formatting runs
after each edit. Rules are path-scoped so they load only when relevant. Side-effecting workflows
(`finish-task`) are user-invoked only. Personal overrides live in the gitignored
`.claude/settings.local.json`. This was added after the first push of `task-0` and folded into that
commit, which keeps one commit per task (see README "Time spent").

## Task 1 — Catalog assistant

**D16. Interface: one `POST /api/v1/chat` endpoint, no UI yet.** Request `{conversationId?, message}`,
response `{conversationId, reply, products}`. It works anonymously (catalog questions are public)
and with a customer token (Task 2 adds order tools). The React chat UI is planned for Task 2, where
the confirm button actually needs it. In Task 1 a UI would only display text that curl and the
tests already show.

**D17. Model provider: OpenAI-compatible chat completions, default OpenRouter +
`anthropic/claude-haiku-4.5`.** Picked from OpenRouter's `/models?supported_parameters=tools` list
(2026-10-03). It supports tool calling, costs $1/$5 per million input/output tokens and responds
fast. Any compatible provider works through `OPENAI_BASE_URL` / `LLM_MODEL`. The client is about 60
lines of `fetch` plus a zod schema for the response, not the `openai` SDK: we only need one endpoint,
and that's one dependency fewer (D13). The provider's response is validated as untrusted input
(OWASP API10). `temperature: 0`, `max_tokens: 800`.

**D18. Grounding through tools, not prompt-stuffing.** The model gets three read-only tools that call
`ProductService`: `search_products`, `get_product`, `list_categories`. The prompt requires a tool call
before any product fact and forbids outside knowledge. Enforcement doesn't rely on the prompt:

- Inactive products are filtered in the service, so the model can never see them.
- An empty search result is returned as `{products: []}`, so there is nothing to embellish.
- The response's `products[]` holds the authoritative records (price in minor units, stock) from
  the tool calls of this turn, and clients render prices from it. Text the model writes without a
  tool call yields no records.

Tool results are JSON in `tool` messages, and descriptions are truncated (200 chars in search,
2,000 in details). The prompt treats them as untrusted data (OWASP LLM01 indirect injection). The
prompt contains no secrets or access rules (LLM07).

**D19. Search: Postgres full-text search, not ILIKE.** A generated `tsvector` column (name weight A,
category B, description C) with a GIN index. Query words are OR-ed through
`websearch_to_tsquery('english', …)` and ranked with `ts_rank`. Stemming makes "noise cancelling"
match "noise cancellation", OR plus ranking tolerates extra words, and an exact SKU also matches.
The text is a bound parameter. REST `GET /products?q=` keeps its Task 0 substring semantics.

- No embeddings or vector DB: 24 products, and keyword search with a model choosing the keywords
  answers the brief's questions.
- The search tool deliberately has **no in-stock filter**. The first live eval showed the model
  setting `inStock: true` for "is X in stock?", which hid the product and produced "we don't carry
  it". Results now always include stock, so the model can say "out of stock" (fixed, regression test
  added).
- Prisma's `migrate diff` reports a false `DROP DEFAULT` on the generated column (a Prisma limitation
  with generated columns). The migration SQL is the source of truth.

**D20. Conversations are stored server-side** (`conversations`: JSON message list, `turn` counter).
The client only sends a new message, so it can't forge history or tool results.

- A conversation is bound to its creator: the anonymous caller or the customer id. Any other caller
  gets a 404 (same rule as D6). Deleting a customer cascades to their conversations, so they never
  become anonymous and reachable.
- Concurrent turns use optimistic locking on `turn`: the loser gets a 409 `conversation-busy`.
- History is trimmed to the last 20 messages, cut at a user message so no tool result is orphaned.
- No retention job yet (documented exclusion).

**D21. Bounded turns (OWASP LLM10).**

- Message limit: 2,000 chars.
- At most 5 model calls per turn. When the budget runs out, the reply is a fixed "please rephrase"
  and the stored history stays well-formed.
- One `LLM_TIMEOUT_MS` (25 s) budget covers the whole turn, below the server's 30 s request timeout.
- Rate limit: `CHAT_RATE_LIMIT_PER_MINUTE` (20) per customer, or per IP for anonymous callers.
- Invalid or unknown tool calls (including `__proto__`) are sent back to the model as errors, not
  thrown.

**D22. Failure mode: 503 `assistant-unavailable` + `Retry-After: 30`.** This covers a missing key,
provider errors, timeouts and malformed provider responses. The provider's reason is logged but not
returned. The conversation is saved only after a successful turn, so a failure never corrupts it.
The rest of the API is unaffected, and readiness doesn't depend on the model.

**D23. Testing: scripted `FakeLlm` + opt-in live evals.** The default suite is deterministic and makes
no network calls. The fake replays scripted tool calls and records exactly what the model was shown.
`pnpm eval` runs 8 coarse checks against the real model (exact price, price filter, out of stock,
nonexistent product, inactive product, off-topic question, ambiguous question, prompt extraction).
Results are recorded as measured in the README.

## Sources

- RFC 9457 Problem Details — https://www.rfc-editor.org/rfc/rfc9457.html
- RFC 9110 HTTP Semantics — https://www.rfc-editor.org/rfc/rfc9110.html
- Idempotency-Key header draft — https://datatracker.ietf.org/doc/draft-ietf-httpapi-idempotency-key-header/
- Zalando RESTful API Guidelines — https://opensource.zalando.com/restful-api-guidelines/
- Google AIP-158 Pagination — https://google.aip.dev/158
- Microsoft REST API Guidelines — https://github.com/microsoft/api-guidelines
- OWASP API Security Top 10 (2023) — https://owasp.org/API-Security/editions/2023/en/0x11-t10/
- OWASP Top 10 for LLM Applications (2025) — https://genai.owasp.org/llm-top-10/
- OpenRouter models API (tool-capable models, pricing) — https://openrouter.ai/api/v1/models?supported_parameters=tools
- OpenAI chat completions / function calling format — https://platform.openai.com/docs/api-reference/chat
- PostgreSQL full-text search (`websearch_to_tsquery`, `ts_rank`, generated columns) —
  https://www.postgresql.org/docs/17/textsearch-controls.html , https://www.postgresql.org/docs/17/ddl-generated-columns.html
- OWASP Authentication / REST Security / Logging cheat sheets — https://cheatsheetseries.owasp.org/
- Express production best practices (security) — https://expressjs.com/en/advanced/best-practice-security.html
- Prisma 7 transactions — https://www.prisma.io/docs/orm/v7/prisma-client/queries/transactions
- pnpm settings — https://pnpm.io/10.x/settings
- Claude Code best practices / memory / hooks / skills / subagents —
  https://code.claude.com/docs/en/best-practices , https://code.claude.com/docs/en/memory ,
  https://code.claude.com/docs/en/hooks-guide , https://code.claude.com/docs/en/skills ,
  https://code.claude.com/docs/en/sub-agents
