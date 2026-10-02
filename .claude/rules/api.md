---
paths:
  - 'server/src/**/*.ts'
---

# API rules

- New endpoint = `/api/v1/...`, plural kebab-case resource, camelCase JSON, UUID ids. Use the
  `add-endpoint` skill.
- Validate every input with a `.strict()` zod schema (`parse(schema, input, 'body'|'query')`).
  Never pass `req.body` to Prisma; map fields explicitly. Return explicit DTOs (never raw rows).
- Errors: throw `Problem` / `problems.*` from `server/src/http/problem.ts`. 400 malformed,
  422 validation, 401 no/invalid token, 403 wrong role, 404 missing or not owned, 409 conflict.
- Ownership goes into the query (`where: { id, customerId }`); customerId comes from `req.auth`.
- Money: integer minor units in the DB, `{ amount, currency }` on the wire. No floats.
- Multi-row writes that must be consistent run inside `db.$transaction`; stock changes use the
  conditional `updateMany(... stock: { gte } ...)` pattern from `orders/service.ts`.
- Register every route in `server/src/openapi.ts`. Log security events with an `event` field;
  never log bodies, tokens, emails or chat text.
