# CLAUDE.md

E-commerce backend (BluBird assessment). Four tasks build on one system: T0 REST backend → T1 catalog
assistant → T2 chat search/orders/ordering → T3 operator bulk import from a URL. Read `README.md`
(scope, assumptions) and `docs/decisions.md` (why things are the way they are) before changing design.

## Commands

```sh
docker compose up -d db        # Postgres on 127.0.0.1:55432 (needed for dev + tests)
cp .env.example .env           # once
pnpm db:migrate && pnpm db:seed
pnpm dev                       # http://localhost:3000, docs at /docs
pnpm build                     # server → dist/, chat UI → web/dist (served at / by Express)
pnpm dev:web                   # chat UI with hot reload on :5173
pnpm test                      # vitest + supertest against the shop_test database
pnpm eval                      # opt-in live-model evals (real provider; needs OPENAI_API_KEY)
pnpm lint && pnpm typecheck && pnpm format:check
docker compose up --build      # full system from a clean clone (what reviewers run)
```

## Layout

- `server/src/http/` cross-cutting HTTP concerns: problem+json errors, auth, pagination, rate limits.
- `server/src/modules/<name>/{schemas,service,routes}.ts`: zod schemas (validation + OpenAPI),
  service = business logic (the only code that touches Prisma), routes = thin HTTP adapters.
- `server/src/assistant/`: `llm.ts` (provider boundary), `tools.ts` (zod-typed tools → services;
  `guestOnly` tools, i.e. `set_guest_details`, are offered only in anonymous chats), `service.ts` (prompt, bounded tool
  loop, conversation storage; 4xx `Problem`s from tools go back to the model as data), `routes.ts`.
- Ordering by chat = `OrderService.propose` → `confirmProposal` (button endpoint or `confirm_order`
  in a later turn). Never add a tool that places, edits or cancels orders without that confirmation.
- `web/`: React + Vite chat UI (one component, `fetch` + `useState`). Render model text as text.
- `server/src/openapi.ts` registers every route; keep it in sync when adding endpoints.
- `server/prisma/` schema + SQL migrations (CHECK constraints are hand-written in migration SQL).
- `fixtures/seed/` deterministic demo data, loaded idempotently on every start.
- `tests/api`, `tests/assistant`, `tests/adversarial`: one file per area; each test resets the DB
  via `resetDb`. Assistant tests script `tests/helpers/fake-llm.ts`; `tests/evals` is live, opt-in.

## Rules

- Business rules live in services, never in routes or in LLM prompts. LLM tools (T1+) call services.
- Customer identity comes only from the authenticated principal (`req.auth`), never from input.
- Other customers' resources return 404 (not 403). Inputs use `.strict()` zod schemas.
- Errors are thrown as `Problem` (`server/src/http/problem.ts`); never send ad-hoc error JSON.
- Money is integer minor units; API shape `{ amount, currency }`.
- Never log tokens, request bodies, or chat contents. Never commit `.env` or keys.
- Every behaviour change ships with tests, including adversarial cases.
- Pinned versions: Prisma 7.x (npm `latest` points at an 8.0 RC — do not upgrade), TypeScript 6.0.x
  (typescript-eslint does not support TS 7 yet).
- Process: one commit per task, tagged `task-N`; update README (time, assumptions, services) each task.

## Assessment workspace

- Start Claude Code sessions **in this repo** (one session per task, no `/clear`). The parent folder
  is the submission.zip root with a fixed layout: `REPO_URL.txt`, `code/` (this repo), `README.md`,
  `transcripts/`, `fixtures/`, `tests/`, `RUN.md` (+ a zip-root env file only if a non-model key is
  ever needed). Never add other visible files there; `scripts/sync-submission.sh` copies README, RUN,
  tests and fixtures up.
- Transcripts (`../transcripts/task-N.jsonl`) are raw and unedited: never paste or print secrets.

## Claude tooling (`.claude/`)

- `settings.json`: permissions + hooks. `hooks/secret-guard.py` blocks commands that could print env
  files, environment variables or resolved container config (deliberately strict: use Edit/Write,
  not shell heredocs, for docs that mention env files). `hooks/git-safety.py` blocks force-push,
  tag moves/deletes, history rewrites and amending a tagged commit. `hooks/format-on-edit.py`
  runs Prettier after edits. Reads of `node_modules`, `dist` and the generated Prisma client are denied.
- `rules/`: `process.md` (always) and path-scoped `api.md`, `assistant.md`, `importer.md`, `testing.md`.
- `skills/add-endpoint`: endpoint recipe. `skills/finish-task`: `/finish-task N` (user-only).
- `agents/security-reviewer.md`: read-only OWASP review before tagging tasks 2 and 3.
- Personal overrides go in `.claude/settings.local.json` (gitignored).
