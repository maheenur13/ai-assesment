#!/bin/sh
# Brings the database to the current schema, inserts any missing fixture data, then hands
# PID 1 (under tini via compose `init: true`) to Node so SIGTERM reaches the graceful shutdown.
set -eu
./node_modules/.bin/prisma migrate deploy
node dist/seed.js
exec node dist/server.js
