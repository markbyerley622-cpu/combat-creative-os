# @combat/database

Prisma schema and workspace-scoped repository layer. Scope for this milestone
is the tenancy core only (`Workspace`, `User`, `Role`, `Membership`) — see the
note at the top of `prisma/schema.prisma`.

## One-time setup (requires Postgres running — `docker compose up -d postgres` from `infrastructure/`)

```sh
pnpm db:generate   # generates the Prisma client from schema.prisma (no DB connection needed)
pnpm db:migrate    # creates and applies the initial migration (needs a live Postgres)
pnpm --filter @combat/database run seed   # seeds the single-workspace MVP
```

`pnpm db:generate` and `pnpm db:validate` do not require a reachable database
and can run without Docker. `pnpm db:migrate` and `seed` do.

## Rule

Every repository function in `src/repositories/*` takes `workspaceId` as its
first argument and folds it into the Prisma `where` clause. Do not add a
function that can look up a workspace-owned row by id alone — see
`membership-repository.ts` and its test for the pattern to follow.
