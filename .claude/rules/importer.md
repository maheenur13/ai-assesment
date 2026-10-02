---
paths:
  - 'server/src/importer/**/*.ts'
  - 'tests/importer/**/*.ts'
---

# Bulk import rules (OWASP SSRF Prevention Cheat Sheet)

- Only http/https, ports 80/443, no credentials in the URL. Parse with `new URL()`.
- Resolve DNS and reject unless every address is public unicast (`ipaddr.process(ip).range()`);
  connect to the vetted IP (the `lookup` option of `node:http`/`https`, `agent: false`) to defeat
  DNS rebinding. IP literals skip `lookup`, so they are checked separately. IPv6 must be in 2000::/3.
- `redirect: 'manual'`, max 3 hops, each re-validated. Timeout, streamed byte cap, content-type
  allowlist, row cap. Never forward auth headers.
- Client gets a generic error; the specific reason is logged.
- Imported values go through the same zod validation as the REST API; SKU upsert, per-row report,
  dry-run first. The LLM may suggest a column mapping only, never values.
- Tests never hit the network: inject the fetcher / DNS lookup.
