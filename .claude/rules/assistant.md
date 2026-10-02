---
paths:
  - 'server/src/assistant/**/*.ts'
  - 'tests/assistant/**/*.ts'
---

# LLM assistant rules (OWASP Top 10 for LLM Applications 2025)

- The model only orchestrates. Tools call existing services; no Prisma access from tool code,
  no generic "query" or "update" tools (LLM06 excessive agency).
- Tool arguments are untrusted: validate with zod. Identity (`customerId`) comes from the request's
  auth context, never from tool arguments or message text.
- Tool results are data, not instructions: return minimal JSON fields, delimited, and tell the model
  so (LLM01 indirect injection via product descriptions / imported rows).
- Prices, stock and order totals shown to users come from tool results, never from model text.
- Placing an order needs explicit user confirmation outside the same model turn (proposal ->
  confirm), single-use, re-validated at confirm time.
- Assume the system prompt leaks (LLM07): no secrets or authorization logic in it.
- Bound everything (LLM10): max tool rounds per turn, max_tokens, request timeout, message length,
  history length, per-identity rate limit.
- Provider failure = 503 problem; the app must work without an API key.
- Tests use the scripted FakeLLM; live-model evals are opt-in and their results are reported as
  measured.
