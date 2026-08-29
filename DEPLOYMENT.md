# Vercel deployment handoff

Luban uses SQLite for local development and automated tests and Supabase PostgreSQL only for the Vercel Production deployment. Merely having `POSTGRES_URL` in a local shell cannot select the remote database. Vercel Preview deployments also remain on SQLite so they cannot mutate Production data.

## Recommended service stack

| Service | Required now? | Purpose |
| --- | --- | --- |
| Vercel | Yes | Hosts the Next.js UI and route handlers and deploys from GitHub. |
| Supabase | Yes for a durable deployment | Managed PostgreSQL. It can also provide authentication later. |
| Transactional email provider | Required when real email registration launches | SMTP delivery for account verification, invitations, and password resets. |
| Upstash Redis | Optional initially | Shared rate limiting and cross-instance market/search cache when traffic grows. |
| Licensed market-data provider | Required before a public or commercial launch | Replaces the keyless Yahoo prototype feed with defined redistribution and availability terms. |

## What the Supabase Marketplace integration automates

Installing Supabase from the Vercel Marketplace can create or connect a Supabase project and synchronize its database and API environment variables into the linked Vercel project.

It does **not** automatically:

- run the repository's Luban migrations merely because the integration exists;
- replace the demo identity switcher with real registration and login;
- create application roles such as student, competition host, or platform administrator;
- configure production email delivery, backups, monitoring, or rate limits.

The repository owns its schema in `supabase/migrations` and its non-destructive prototype seed in `supabase/seed.sql`.

## Automatic Production migration

`pnpm build` invokes the guarded `prebuild` script. The migration runner opens a PostgreSQL connection only when all of these values match:

```env
NODE_ENV=production
VERCEL=1
VERCEL_ENV=production
LUBAN_DATABASE_PROVIDER=postgres
```

`vercel.json` supplies only the non-secret provider selection. Vercel and Supabase supply `POSTGRES_URL` through the linked integration. Local builds, tests, and Preview builds print a skip message before the PostgreSQL package is loaded, even if `POSTGRES_URL` happens to be present.

Migration filenames are applied in lexical order. Every applied file is recorded with a SHA-256 checksum in `public.schema_migrations`. Line endings are normalized before hashing so Windows and Linux checkouts agree. One transaction-scoped PostgreSQL advisory lock covers the complete migration plan and seed, preventing concurrent deployments from interleaving revisions. A stale deployment also refuses to seed when the database contains a migration absent from its checkout. Never edit a migration after it has been applied; add a new migration instead. Checksum drift intentionally fails the deployment. The idempotent seed runs after the migrations and never resets existing balances, holdings, orders, or operator changes.

## Safe setup order

1. Import `Centurionactionx/luban-sim` into Vercel as a Next.js project. The repository root is the application root.
2. Connect the Supabase Marketplace resource to that exact Vercel project.
3. In Vercel Project Settings → Environment Variables, enable **Automatically expose System Environment Variables** and confirm the Production build exposes `VERCEL=1` and `VERCEL_ENV=production`. The application fails closed without these markers rather than using ephemeral SQLite or contacting a remote database from an ambiguous environment.
4. In Vercel's Production environment-variable settings, confirm that `POSTGRES_URL` exists. Never paste it into source files or expose it with a `NEXT_PUBLIC_` prefix.
5. Confirm `LUBAN_DEMO_MODE` is absent or `false` in Production. The public deployment must not expose the seeded identity switcher.
6. Run `pnpm verify` locally. It uses SQLite and cannot select Supabase, even if Vercel variables were previously pulled into the shell. A local production shell that requests PostgreSQL without Vercel's Production markers fails before opening a connection.
7. Push a branch and verify the Preview build. Its migration step must report that PostgreSQL was skipped. Preview uses ephemeral SQLite only as an isolation/build check; it is not a durable multi-user test environment.
8. Deploy to Production. The guarded prebuild applies pending migrations and the idempotent seed before Next.js builds.
9. Test simultaneous orders, idempotency, portfolio reconciliation, host controls, and confirm that destructive reset is rejected against Production before inviting users.
10. Give Production its own database and secrets. Do not share that database with Preview deployments.
11. Add managed authentication and custom SMTP before enabling public registration.

## Current environment variables

```env
LUBAN_MARKET_DATA_PROVIDER=yahoo
LUBAN_DEMO_MODE=true
LUBAN_DATABASE_PROVIDER=sqlite
```

`LUBAN_DEMO_MODE=true` permits anyone with access to switch among the seeded identities, including the host. Use it only for a private demonstration. It is not an authentication system and must be disabled before a public deployment.

The checked-in `LUBAN_DATABASE_PROVIDER=sqlite` is explanatory for local development; the environment guard forces local and test processes to SQLite regardless. `vercel.json` sets the safe, non-secret Production selector to `postgres`. The Supabase Marketplace integration supplies the connection and API variables. Never commit those values. Only public/publishable Supabase variables may use a `NEXT_PUBLIC_` prefix; database passwords and secret/service-role keys must remain server-only.

## Explicit remote migration

Ordinary local commands must not contact Supabase. For a deliberate maintenance migration, provide `POSTGRES_URL` to the process and run:

```text
LUBAN_ALLOW_REMOTE_DATABASE_MIGRATION=I_UNDERSTAND_THIS_TOUCHES_REMOTE pnpm db:migrate:remote
```

Use your shell's environment-variable syntax or `vercel env run`; standalone `tsx` scripts do not automatically load `.env.local`. The acknowledgement must match exactly and should be set for only that command. The remote command uses the same checksum, transaction, advisory-lock, and seed safeguards as the Production prebuild.

## Authentication choice

For the fewest external services, use Supabase for both PostgreSQL and authentication. Keep Luban's application authorization in PostgreSQL: team membership, competition-scoped host access, platform-admin roles, account status, and audit history must be checked by the server on every protected operation.

If prebuilt authentication UI and simpler onboarding are more important, use Clerk for identity and Supabase only for PostgreSQL. Do not run two independent authentication systems.
