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

## Sources

- RFC 9457 Problem Details — https://www.rfc-editor.org/rfc/rfc9457.html
- RFC 9110 HTTP Semantics — https://www.rfc-editor.org/rfc/rfc9110.html
- Idempotency-Key header draft — https://datatracker.ietf.org/doc/draft-ietf-httpapi-idempotency-key-header/
- Zalando RESTful API Guidelines — https://opensource.zalando.com/restful-api-guidelines/
- Google AIP-158 Pagination — https://google.aip.dev/158
- Microsoft REST API Guidelines — https://github.com/microsoft/api-guidelines
- OWASP API Security Top 10 (2023) — https://owasp.org/API-Security/editions/2023/en/0x11-t10/
- OWASP Top 10 for LLM Applications (2025) — https://genai.owasp.org/llm-top-10/
- OWASP Authentication / REST Security / Logging cheat sheets — https://cheatsheetseries.owasp.org/
- Express production best practices (security) — https://expressjs.com/en/advanced/best-practice-security.html
- Prisma 7 transactions — https://www.prisma.io/docs/orm/v7/prisma-client/queries/transactions
- pnpm settings — https://pnpm.io/10.x/settings
- Claude Code best practices / memory / hooks / skills / subagents —
  https://code.claude.com/docs/en/best-practices , https://code.claude.com/docs/en/memory ,
  https://code.claude.com/docs/en/hooks-guide , https://code.claude.com/docs/en/skills ,
  https://code.claude.com/docs/en/sub-agents
