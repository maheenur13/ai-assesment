---
paths:
  - 'tests/**/*.ts'
---

# Testing rules

- Integration tests run against the real `shop_test` Postgres via supertest; call `resetDb(db)` in
  `beforeEach` so every test starts from the fixtures.
- Each behaviour gets a happy-path test and at least one adversarial test in `tests/adversarial/`
  (auth bypass, BOLA, mass assignment, injection, oversized/malformed input, abuse of limits).
- Assert status, `type` slug and JSON Pointer for problem responses, plus side effects in the DB
  (stock, counts) for anything that writes.
- No network, no real LLM in the default suite. Keep tests deterministic; no sleeps.
- New fixture data goes in `fixtures/`; keep it small, realistic and deterministic.
