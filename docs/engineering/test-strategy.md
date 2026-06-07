# Test Strategy

## Test Pyramid

- Unit tests cover pure business rules such as SQL safety, connection validation, usage windows,
  and auth/session persistence.
- Integration tests cover PostgreSQL behavior with a real database using Docker Compose once the
  developer machine has Docker available.
- E2E tests cover the desktop path: open app, create connection, execute SQL, inspect table output,
  view query history, and verify read-only blocking.
- Smoke tests are zero-dependency repository checks that can run even before Node package
  installation is available.

## M1 Business Scenarios

- Analyst connects to PostgreSQL and runs a safe `SELECT`.
- Analyst accidentally runs `DELETE` on a read-only connection and receives a blocked operation.
- Engineer runs a malformed query and sees a useful error without losing the SQL text.
- DBA reviews query history including status, elapsed time, row count, and safety classification.
- BYOK user enters without login and usage still records local rounds.

## Required Gates

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm smoke
```

## M0-M1.5 Release Readiness Risks

- Electron dependencies can pass package-level tests while still failing in the final desktop
  package because main-process code, preload code, native modules, and ASAR path handling are only
  exercised by the packaged app.
- PostgreSQL integration tests must run against a real PostgreSQL instance before a release
  candidate. Unit tests are enough for SQL safety and persistence helpers, but they do not validate
  driver behavior, SSL options, pool lifecycle, result type mapping, or error text from the server.
- Docker-backed PostgreSQL tests should be opt-in for local development and required in release CI
  once the CI environment has Docker. The test job should create an isolated database, apply any
  fixtures, run read-only and write-path scenarios, and tear the database down after the run.
- The packaged desktop app must be tested after `pnpm --filter @dbagent/desktop package`; a
  renderer dev-server smoke test is not a substitute for checking installed app startup, IPC
  registration, preload availability, and database connection behavior from the bundled artifact.
- Usage and auth persistence should remain covered by fast unit tests because those flows gate both
  BYOK mode and future subscription UX before the app has a full backend.

For release candidates:

```bash
pnpm --filter @dbagent/desktop package
```

Recommended release candidate sequence:

```bash
pnpm run ci
pnpm --filter @dbagent/core-db test:postgres
pnpm --filter @dbagent/desktop package
```

`test:postgres` is the intended gate name for the Docker-backed PostgreSQL suite. If the script is
not present yet, the release candidate should explicitly record that PostgreSQL integration testing
was not completed.

## PostgreSQL Integration Fixture

Use the local fixture in `scripts/dev-db` for M1 manual and automated integration checks:

```bash
docker compose -f scripts/dev-db/docker-compose.yml up -d
```

Default connection:

- Host: `127.0.0.1`
- Port: `5432`
- Database: `dbagent_demo`
- User: `postgres`
- Password: `postgres`

Business checks:

- `select * from users` returns seeded analyst-friendly data.
- `select u.city, sum(o.total_amount) from users u join orders o on o.user_id = u.id group by u.city`
  validates a realistic join.
- `delete from users` is blocked when the connection is read-only.
