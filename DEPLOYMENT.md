# Deploying Luban Market Lab

The current simulator supports SQLite for local development and PostgreSQL for durable hosting. Managed sign-in is implemented with Clerk. The separate `codex/supabase-persistence` worktree is an older prototype; use the current simulator for account management and managed authentication.

## Production configuration

Configure the simulator project separately from the public static website. Set these values in the hosting environment; never commit credentials:

```env
LUBAN_AUTH_MODE=managed
LUBAN_DATABASE_PROVIDER=postgres
LUBAN_DATABASE_URL=postgresql://USER:PASSWORD@DATABASE_HOST:6543/postgres
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=YOUR_PUBLISHABLE_KEY
CLERK_SECRET_KEY=YOUR_SERVER_SECRET
LUBAN_REQUIRE_ADMIN_MFA=false
LUBAN_MARKET_DATA_PROVIDER=yahoo
LUBAN_APP_URL=https://sim.lubancanada.com
```

`LUBAN_DATABASE_URL` falls back to `POSTGRES_URL`, then `DATABASE_URL`. The engine is selected only by `LUBAN_DATABASE_PROVIDER`; credentials alone do not select PostgreSQL. Use the provider's pooled connection string. SQLite is a local file and is unsuitable for durable state on an ephemeral serverless filesystem.

Leave `LUBAN_DEMO_MODE` unset on public deployments. Managed mode refuses demo authentication regardless of that flag. Disabling demo mode also rejects previously issued demo cookies. Keep preview and production databases separate, and start managed authentication with a fresh database so invitations created through a previous demo cannot carry over.

## Domain

Production is served at `https://sim.lubancanada.com`, a subdomain of the public site. The simulator stays a separate Vercel project; the public site links to it and shares no code. DNS: `CNAME sim -> cname.vercel-dns.com`. Clerk runs a production instance for `lubancanada.com`, and its DNS records live on the same zone. `luban-sim.vercel.app` redirects to the subdomain.

## Keeping the database active

Supabase's free plan pauses a project after about a week of low activity. `vercel.json` schedules one daily call to `/api/health` (15:00 UTC), which runs a real query against the database. Vercel's Hobby plan allows one scheduled run per day, so do not make the schedule more frequent or the deployment will be rejected. This is a safety net and not a guarantee; Supabase Pro never auto-pauses.

## Database TLS

Remote PostgreSQL connections verify both certificate trust and hostname. URL flags such as `sslmode=require`, `sslmode=disable`, or `sslmode=no-verify` cannot disable verification. Plaintext is permitted only for loopback development databases unless TLS is explicitly requested.

If the provider requires a private certificate authority, obtain its CA certificate from the provider and set `LUBAN_DATABASE_CA_CERT` to the complete PEM text. Alternatively, use `sslrootcert=/absolute/path/to/provider-ca.pem` in the connection URL. Client `sslcert` and `sslkey` paths are preserved when supplied. Missing or invalid trust configuration fails closed; configure the CA before deploying this change to a provider that uses one.

The explicit TLS object must not be overwritten by connection-string SSL options; the adapter extracts those options first. See [node-postgres SSL configuration](https://node-postgres.com/features/ssl).

## Managed accounts

1. Configure the Clerk application with verified email addresses and a supported second-factor strategy. Make its keys available during both build and runtime.
2. Bootstrap the first administrator with `pnpm bootstrap:admin -- --email you@example.ca`, run against the intended database. Alternatively, set `LUBAN_BOOTSTRAP_ADMIN_EMAIL`, sign in once using that verified email, and remove the variable.
3. Complete second-factor enrollment and sign in with it. Host and administrator operations check both enrollment and the current session's verified second factor. Enrollment alone does not authorize an old session. `LUBAN_REQUIRE_ADMIN_MFA=false` is an explicit opt-out and removes this protection.
4. Use **Accounts & invitations** to issue single-use invitations and manage roles, team membership, suspension, and deletion. Invitation links are copied by the host; automatic invitation email delivery is not implemented.

Clerk's session `fva` claim distinguishes an enrolled account from a session that verified a second factor. See [Clerk session tokens](https://clerk.com/docs/guides/sessions/session-tokens).

Account deletion preserves trading attribution. Audit text and the upstream identity provider have separate retention behavior; this is not a complete personal-data erasure workflow.

## Schema and transactions

The application creates and seeds its schema on first use, with an advisory lock coordinating PostgreSQL initialization. Incremental schema changes are implemented in `lib/server/db.ts`. Row-level security is enabled without anonymous policies; browser clients do not access the database directly. Formal versioned migration tooling, backups, and operational monitoring remain deployment work.

PostgreSQL orders hold a shared account-administration lock, a per-trader advisory lock, and the affected team's row lock. Account, invitation, and competition administration uses the exclusive account lock. This protects permission changes, invitation limits, idempotency, order limits, and portfolio updates across application instances. SQLite serializes writers with `BEGIN IMMEDIATE`.

## Verification and release

Run `pnpm verify` locally. The browser-test runner forces demo authentication, synthetic market data, and an isolated SQLite file for both build and runtime. It refuses a remote target or reusing an existing server. Tests never require a production database.

Unit/integration tests exercise PostgreSQL SQL through embedded PGlite. PGlite is a single-connection engine: a staging test with multiple real PostgreSQL connections is still required to validate pooler behavior and lock contention. Also verify real Clerk sign-in, invitation acceptance, second-factor enforcement, suspension, and the production hostname in staging.

The Yahoo adapter is a prototype feed. Verify the intended market-data provider's availability and redistribution terms before public operation. The public site's EmailJS contact delivery, provider abuse controls, production TLS certificates, backups, and deployed headers require checks in their respective environments; local test success does not establish those settings.
