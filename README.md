# BluBird Shop

This is a minimal e-commerce backend (products, customers, orders). Later tasks add an LLM shopping
assistant and operator bulk import. It is built over four time-boxed tasks; this README describes
the **current state (Task 0)**.

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
├── openapi.ts   OpenAPI 3.1 document built from the same zod schemas
└── seed.ts      idempotent fixture loader (runs on every start)
Postgres 17 via Prisma 7 (driver adapter, SQL migrations with CHECK constraints)
```

The services are the only layer that touches the database. The assistant in Tasks 1–2 will call the
same services, so authorization and business rules can't be bypassed through chat.

## API (Task 0)

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

## Tests

`pnpm test` runs **64 tests** with vitest + supertest against a real Postgres database (`shop_test`),
which is reset and re-seeded before every test.

- `tests/api/`: product, customer and order behaviour. This covers validation, pagination, pricing
  snapshots, insufficient stock and the atomic rollback, **concurrent orders not overselling**, and
  idempotent replay (including concurrent duplicates).
- `tests/adversarial/`: BOLA (another customer's orders), mass assignment (`customerId`, prices,
  ids), token forgery and wrong roles, malformed or oversized or non-JSON bodies, injection-shaped
  input, prototype pollution, forged request ids, rate limiting, security headers, and no stack
  traces in responses.

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

## Exclusions (deliberate)

- **User accounts, passwords, OAuth and sessions:** out of scope. Opaque bearer tokens demonstrate
  authentication and authorization without that machinery.
- **Deleting products:** use `isActive: false` instead. It keeps order history consistent.
- **Multi-instance concerns:** the rate-limit store is in memory.
- **Token revocation and rotation:** not implemented.

## Incomplete work

- None known for Task 0.

## Third-party services

| Provider     | Service                                                                                          | Purpose          | Task |
| ------------ | ------------------------------------------------------------------------------------------------ | ---------------- | ---- |
| Docker Hub   | `node:22-slim`, `postgres:17-alpine` images                                                      | Runtime          | 0+   |
| npm registry | Packages (installed from the lockfile at build)                                                  | Build            | 0+   |
| jsDelivr     | CDN serving the pinned `@scalar/api-reference@1.72.4` script for `/docs` (loaded by the browser) | API reference UI | 0+   |

The server makes no outbound calls in Task 0, and no API keys are required. Only the `/docs` page
loads a pinned script from jsDelivr in the browser; the API works without it.

## Time spent

Times are self-reported from my own clock (UTC+6). The raw session transcripts carry the timestamps.

**Transcripts** (`transcripts/task-N.jsonl`, submission zip only) are the raw Claude Code session
logs, one session per task. When a session used subagents, their JSONL lines are appended verbatim
after the main session's lines. Each line carries its own `agentId`/`sessionId`, and nothing is
edited or removed.

| Task | Start            | End              | Duration | Notes                                                                                                                                                 |
| ---- | ---------------- | ---------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | 2026-10-03 02:17 | 2026-10-03 03:43 | 86 min   | ~23 min planning and research, ~34 min building and verifying the backend (first push at 03:14), ~29 min adding the Claude Code tooling in `.claude/` |

**Note on Task 0's history:** `task-0` was first pushed at 03:14. I then decided the Claude Code
tooling was part of the foundation, so I amended the commit and re-pushed `main` and the `task-0`
tag (force push) before anything was submitted. It is still one commit for Task 0, and the
transcript shows both pushes.
