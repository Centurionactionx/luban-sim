# Vercel deployment handoff

The Next.js application builds on Vercel, but the current SQLite persistence layer is local-prototype infrastructure. Do not treat a Vercel deployment as durable until `lib/server/db.ts` and its synchronous callers have been migrated to managed PostgreSQL.

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

- convert the existing `node:sqlite` code to PostgreSQL;
- create the Luban tables, indexes, constraints, or seed data;
- rewrite synchronous database transactions as asynchronous server-side queries;
- configure Row Level Security policies;
- replace the demo identity switcher with real registration and login;
- create application roles such as student, competition host, or platform administrator;
- configure production email delivery, backups, monitoring, or rate limits.

Those are application migrations that must be implemented and tested in this repository.

## Safe setup order

1. Import `Centurionactionx/luban-sim` into Vercel as a Next.js project. The repository root is the application root.
2. Create/connect Supabase through the Vercel Marketplace so its environment variables are scoped to Development, Preview, and Production.
3. Pull Development variables locally into the ignored `.env.local` file with `vercel env pull .env.local --yes`.
4. Add a PostgreSQL migration system and port the SQLite schema, queries, transactions, reconciliation checks, and seed process.
5. Run migrations against a non-production Supabase project and execute `pnpm verify`.
6. Deploy a Vercel Preview and test simultaneous orders, idempotency, portfolio reconciliation, host controls, and resets.
7. Add Supabase Auth or another managed identity provider. Do not expose a public admin-registration route; bootstrap the first platform administrator out of band and invite additional administrators.
8. Configure a custom SMTP provider before enabling email registration for real users.
9. Give Production its own database and secrets. Preview deployments must not share the Production database.
10. Promote the tested Preview deployment to Production.

## Current environment variables

```env
LUBAN_MARKET_DATA_PROVIDER=yahoo
LUBAN_DEMO_MODE=true
```

`LUBAN_DEMO_MODE=true` permits anyone with access to switch among the seeded identities, including the host. Use it only for a private demonstration. It is not an authentication system and must be disabled before a public deployment.

The Supabase Marketplace integration supplies its own connection and API variables. Never commit those values. Only public/publishable Supabase variables may use a `NEXT_PUBLIC_` prefix; database passwords and secret/service-role keys must remain server-only.

## Authentication choice

For the fewest external services, use Supabase for both PostgreSQL and authentication. Keep Luban's application authorization in PostgreSQL: team membership, competition-scoped host access, platform-admin roles, account status, and audit history must be checked by the server on every protected operation.

If prebuilt authentication UI and simpler onboarding are more important, use Clerk for identity and Supabase only for PostgreSQL. Do not run two independent authentication systems.
