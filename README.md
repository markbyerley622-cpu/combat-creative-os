# Combat Creative OS

Orchestrator-driven platform for producing short-form combat-sports
advertisements. See `docs/architecture.md` for the full system design and
`docs/adr/` for architecture decisions.

**Current milestone: repository foundation and local infrastructure.** No
specialist agent and no real external provider integration is implemented
yet — see `CLAUDE.md` for what's in scope right now.

## Prerequisites

- Node.js >= 20 (tested with v24)
- pnpm (see "Install pnpm" below if you don't have it)
- Docker Desktop (or another Docker Compose-compatible runtime) — required
  for Postgres, Temporal, and MinIO. Not required to install dependencies,
  typecheck, lint, or run unit tests.

### Install pnpm

If `pnpm --version` fails:

```sh
corepack enable
corepack prepare pnpm@latest --activate
```

If `corepack enable` fails with a permissions error (writing to a system
Node install directory), install pnpm as a regular npm global package
instead:

```sh
npm install -g pnpm
```

## First-time setup

```sh
# 1. Install dependencies for every package/app in the workspace
pnpm install

# 2. Create your local env file (placeholders only — see .env.example)
cp .env.example .env

# 3. Generate the Prisma client (does not require a running database)
pnpm db:generate

# 4. Start local infrastructure — Postgres, Temporal (server + Web UI), MinIO
docker compose -f infrastructure/docker-compose.yml up -d

# 5. Apply the initial database migration (requires the Postgres container from step 4)
pnpm db:migrate

# 6. Seed the single-workspace MVP (one workspace, one OWNER_ADMIN user)
pnpm --filter @combat/database run seed
```

## Running the apps

Each app runs directly on the host (not inside Docker). `apps/api` and
`apps/worker` load config from the root `.env` via Node's `--env-file` flag
(already wired into their `dev`/`start` scripts) — make sure step 2 above
(`cp .env.example .env`) has been done first.

```sh
pnpm --filter api run dev         # apps/api        → http://localhost:4000/health
pnpm --filter worker run dev      # apps/worker      → http://localhost:4100/health (readiness)
pnpm --filter dashboard run dev   # apps/dashboard   → http://localhost:3000
```

Or start all three at once from the repo root:

```sh
pnpm dev
```

`apps/worker` will retry its Temporal connection every 5 seconds and report
`temporal: "disconnected"` at its readiness endpoint until step 4 above has
been run — this is expected, not a crash.

## Verification commands

```sh
pnpm typecheck     # TypeScript strict-mode check, every package/app
pnpm lint          # ESLint, every package/app
pnpm test          # Vitest unit/integration tests, every package/app
pnpm build         # Compile every package/app
pnpm format:check  # Prettier check (pnpm format to fix)

# Dashboard end-to-end (builds + boots the app itself, no separate step needed)
pnpm --filter dashboard test:e2e
```

## Local infrastructure

```sh
docker compose -f infrastructure/docker-compose.yml up -d     # start
docker compose -f infrastructure/docker-compose.yml ps        # status
docker compose -f infrastructure/docker-compose.yml down      # stop (add -v to also wipe volumes)
```

| Service         | Local URL                                                           |
| --------------- | ------------------------------------------------------------------- |
| Postgres        | `localhost:5432` (`postgres` / `postgres`, db `combat_creative_os`) |
| Temporal server | `localhost:7233`                                                    |
| Temporal Web UI | http://localhost:8080                                               |
| MinIO API       | http://localhost:9000                                               |
| MinIO Console   | http://localhost:9001 (`minioadmin` / `minioadmin`)                 |

## Repository layout

```
apps/
  dashboard/   Next.js frontend — no business logic, calls apps/api only
  api/         Authenticated control-plane API (Fastify)
  worker/      Temporal worker process
packages/
  domain/          Zod contracts (roles, tenancy, agent I/O envelope)
  config/          Environment-variable validation
  observability/   Structured logging + OpenTelemetry setup
  testing/         Shared test fixtures/helpers
  database/        Prisma schema + workspace-scoped repositories
  providers/       Provider-neutral interfaces + deterministic mocks
  workflows/       Temporal workflow/activity definitions
  agents/          Specialist-agent scaffolding (not yet implemented)
infrastructure/
  docker-compose.yml   Postgres, Temporal, MinIO for local dev
docs/
  architecture.md      Full system design
  adr/                 Architecture decision records
.claude/agents/        Project-specific Claude Code subagents
```

## Known limitations of this milestone

- No specialist agent or real provider adapter is implemented — see
  `CLAUDE.md`.
- Prisma migrations must be generated against a live Postgres (step 5 above)
  — none are pre-generated in this repository.
- `apps/webhook-receiver` (from `docs/architecture.md`) is not built yet —
  it has no purpose until a real provider webhook exists.
