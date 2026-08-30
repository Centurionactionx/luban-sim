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

# Managed sign-in (see "Authentication choice" below)
# LUBAN_AUTH_MODE=managed
# NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_live_...
# CLERK_SECRET_KEY=sk_live_...
# LUBAN_BOOTSTRAP_ADMIN_EMAIL=admin@example.ca   # remove after first admin exists
# LUBAN_REQUIRE_ADMIN_MFA=true
```

`LUBAN_DEMO_MODE=true` permits anyone with access to switch among the seeded identities, including the host. Use it only for a private demonstration. It is not an authentication system and must be disabled before a public deployment.

`LUBAN_AUTH_MODE=managed` switches the deployment to real Clerk sign-in: demo identity switching is refused, registration is invitation-only, and host/admin actions require MFA enrollment (unless `LUBAN_REQUIRE_ADMIN_MFA=false`, for Clerk plans without MFA strategies). The publishable key is inlined at build time, so both Clerk keys must be present in the build environment for a managed deployment.

The Supabase Marketplace integration supplies its own connection and API variables. Never commit those values. Only public/publishable Supabase variables may use a `NEXT_PUBLIC_` prefix; database passwords and secret/service-role keys must remain server-only.

## Authentication choice

The application now ships a managed-identity integration built on Clerk, behind `LUBAN_AUTH_MODE=managed`. Clerk handles passwords, email verification, password resets, MFA, and session cookies; Luban keeps authorization (roles, teams, account status, audit history) in its own database and re-checks it on every protected operation. Do not run two independent authentication systems.

Bootstrap and operations in managed mode:

1. Create a Clerk application and set `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` and `CLERK_SECRET_KEY`. In the Clerk dashboard, require email verification at sign-up and enable the Authenticator-application (TOTP) MFA strategy — MFA strategies need a paid Clerk plan; until then set `LUBAN_REQUIRE_ADMIN_MFA=false` explicitly, and remove it as soon as the plan allows.
2. Create the first platform administrator out of band: run `pnpm bootstrap:admin -- --email you@example.ca` on the machine that owns the database and open the printed single-use link, or set `LUBAN_BOOTSTRAP_ADMIN_EMAIL` and sign in once with that verified email. Remove the variable afterwards; it can never mint a second admin while one exists.
3. The administrator invites hosts and administrators, and hosts invite students, from **Accounts & invitations** in the app. Invitation links are single-use, expire (72 h by default), are stored only as hashes, and every issue/revoke/accept is audited.
4. Keep `LUBAN_DEMO_MODE` unset in managed deployments. Demo login is refused in managed mode regardless, and the seeded demo accounts have no managed sign-in linked to them.
5. Give a managed deployment a fresh database rather than promoting one that ran in demo mode: invitations minted during a demo session would otherwise remain redeemable after the switch. (Managed accounts are protected in the other direction — they can never be assumed through the demo identity switcher.)

Note the SQLite caveat above: on Vercel the database is ephemeral, so managed-mode accounts and invitations only become durable after the PostgreSQL migration. Test managed sign-in on a private preview first.
