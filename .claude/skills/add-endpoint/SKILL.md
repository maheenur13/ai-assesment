---
name: add-endpoint
description: Add or change a REST endpoint following the repo pattern (zod schemas -> service -> routes -> OpenAPI -> tests incl. adversarial). Use whenever a task needs a new API route or a new field on an existing one.
---

Follow the existing modules (`server/src/modules/orders/` is the reference) exactly.

1. **Schemas** `modules/<name>/schemas.ts`: request schemas with `.strict()`, explicit limits
   (`max`, `min`, int), money via `moneySchema`, ids via `z.uuid()`; response schema with
   `.meta({ id: '<Name>' })`. Avoid `.default()` on fields reused by `.partial()` (zod keeps defaults).
2. **Service** `modules/<name>/service.ts`: all business rules and all Prisma access. Take identity
   as a parameter (never read it from input), scope queries by owner, throw `problems.*`,
   use `$transaction` for multi-row consistency, return DTOs via a `toDto` mapper.
3. **Routes** `modules/<name>/routes.ts`: thin. `parse(schema, req.body|req.query, ...)`,
   `idParam(req.params.id, '<Name>')`, role middleware (`requireCustomer` / `requireOperator`),
   `customerIdOf(req.auth)`. Creates return `201` + `Location`. Log state changes with an `event`.
4. **Wire up** in `server/src/app.ts` (stricter rate limiter if the route is costly) and register
   the path, request and responses (incl. problem responses) in `server/src/openapi.ts`.
5. **Tests**: `tests/api/<name>.test.ts` (happy paths, validation 422 with pointers, 404,
   409, side effects in the DB) and cases in `tests/adversarial/` (no token, wrong role,
   another customer's resource, mass-assignment fields, oversized/malformed input).
6. **Docs**: endpoint table in `README.md`; a `docs/decisions.md` entry if a design choice
   was made.
7. Verify: `pnpm lint && pnpm typecheck && pnpm test`, and show the output.
