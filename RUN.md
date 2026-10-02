# Run

Requires Docker (with Compose v2). From the repository root (`code/` in the submission zip):

```sh
docker compose up --build
```

From the root of the unzipped submission, the equivalent single command is:

```sh
docker compose -f code/docker-compose.yml up --build
```

This builds the app, starts Postgres, applies migrations, loads the fixture data, and serves:

- API: http://localhost:3000/api/v1/products
- API reference: http://localhost:3000/docs
- Health: http://localhost:3000/readyz

Ports 3000 and 127.0.0.1:55432 must be free. Demo tokens are listed in the README.

**Clean state:** `docker compose down -v` deletes the database volume. The next `up` re-seeds it from
`fixtures/`.

**Development and tests** (Node 22, pnpm 10):

```sh
docker compose up -d db && cp .env.example .env && pnpm install
pnpm test        # 64 tests against the shop_test database
pnpm dev         # hot-reload server on :3000
```
