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
LUBAN_MARKET_DATA_PROVIDER=yahoo
LUBAN_APP_URL=https://sim.lubancanada.com
```

Host and administrator operations require multi-factor authentication, which needs a paid Clerk plan. Until it is available, Vercel carries `LUBAN_REQUIRE_ADMIN_MFA=false`. To turn enforcement on, go in this order (any other order locks hosts out of host controls): (1) enable MFA in the Clerk dashboard; (2) every host enrolls a second factor and signs in again with it; (3) remove `LUBAN_REQUIRE_ADMIN_MFA` in Vercel and redeploy.

`LUBAN_DATABASE_URL` falls back to `POSTGRES_URL`, then `DATABASE_URL`. The engine is selected only by `LUBAN_DATABASE_PROVIDER`; credentials alone do not select PostgreSQL. Use the provider's pooled connection string. SQLite is a local file and is unsuitable for durable state on an ephemeral serverless filesystem.

Leave `LUBAN_DEMO_MODE` unset on public deployments. Managed mode and any Vercel deployment (`VERCEL=1`) refuse demo authentication regardless of that flag. Disabling demo mode also rejects previously issued demo cookies. Keep preview and production databases separate, and start managed authentication with a fresh database so invitations created through a previous demo cannot carry over.

## Domain

Production is served at `https://sim.lubancanada.com`, a subdomain of the public site. The simulator stays a separate Vercel project; the public site links to it and shares no code. DNS: `CNAME sim -> cname.vercel-dns.com`. Clerk runs a production instance for `lubancanada.com`, and its DNS records live on the same zone. `luban-sim.vercel.app` redirects to the subdomain.

## Release numbers

The footer shows the version from `package.json` (for example `v1.29.0`), followed by the short commit ID Vercel built. The minor number counts production releases: version 1.29.0 is release 29. Bump it in the same commit as each production release; the commit ID keeps the footer exact even if a bump is missed.

## Keeping the database active

Supabase's free plan pauses a project after about a week of low activity. `vercel.json` schedules one daily call to `/api/health` (07:00 UTC, about 3 a.m. Eastern). Vercel Cron sends `Authorization: Bearer <CRON_SECRET>` automatically when `CRON_SECRET` is set in Vercel Production, and only that request runs a real query against the database; any other caller gets `{ "ok": true }` with no database work. After that query the same run cleans up (`lib/server/retention.ts`) to keep the free 500 MB database small: it deletes shared market-data cache rows older than 24 hours, order-retry (idempotency) records older than 7 days, and cancelled or expired waiting orders closed more than 14 days ago, and never touches orders, the ledger, activity, snapshots, holdings, teams, users, or feedback. A cleanup failure is logged and shown as `"cleanup": "failed"` in the response without marking the database down. Vercel's Hobby plan allows one scheduled run per day, so do not make the schedule more frequent or the deployment will be rejected. This is a safety net and not a guarantee; Supabase Pro never auto-pauses.

## Database TLS

Remote PostgreSQL connections verify both certificate trust and hostname. URL flags such as `sslmode=require`, `sslmode=disable`, or `sslmode=no-verify` cannot disable verification. Plaintext is permitted only for loopback development databases unless TLS is explicitly requested.

If the provider requires a private certificate authority, obtain its CA certificate from the provider and set `LUBAN_DATABASE_CA_CERT` to the complete PEM text. Alternatively, use `sslrootcert=/absolute/path/to/provider-ca.pem` in the connection URL. Client `sslcert` and `sslkey` paths are preserved when supplied. Missing or invalid trust configuration fails closed; configure the CA before deploying this change to a provider that uses one.

The explicit TLS object must not be overwritten by connection-string SSL options; the adapter extracts those options first. See [node-postgres SSL configuration](https://node-postgres.com/features/ssl).

## Managed accounts

1. Configure the Clerk application with verified email addresses and a supported second-factor strategy. Make its keys available during both build and runtime.
2. Bootstrap the first administrator with `pnpm bootstrap:admin -- --email you@example.ca`, run against the intended database. Alternatively, set `LUBAN_BOOTSTRAP_ADMIN_EMAIL`, sign in once using that verified email, and remove the variable.
3. Complete second-factor enrollment and sign in with it. Host and administrator operations check both enrollment and the current session's verified second factor. Enrollment alone does not authorize an old session. `LUBAN_REQUIRE_ADMIN_MFA=false` is an explicit opt-out and removes this protection.
4. Use **Team & user management** (in the Host controls menu) to issue single-use invitations and manage roles, team membership, suspension, and deletion. Invitation links are copied by the host; automatic invitation email delivery is not implemented.

Clerk's session `fva` claim distinguishes an enrolled account from a session that verified a second factor. See [Clerk session tokens](https://clerk.com/docs/guides/sessions/session-tokens).

Account deletion preserves trading attribution. Audit text and the upstream identity provider have separate retention behavior; this is not a complete personal-data erasure workflow.

### Self-service deletion

People delete their own account from **Account → Delete account** (`DELETE /api/account`, confirmed by typing `DELETE`). The Market Lab account is removed, or anonymized as above when it has trades, and then the Clerk user is deleted, which ends every session. If the Clerk step fails, the person is told to retry; the retry deletes only the Clerk user. The last active platform administrator and suspended accounts cannot delete themselves, and demo identities cannot be deleted at all. Unlike an administrator's deletion, a self-service one also removes the person's feedback and deletes their Clerk user. `/delete-account` is the public page that explains deletion, including for people who can't sign in.

Clerk's own **Delete account** button is hidden on the account page because it would leave the Market Lab account behind. Also turn off **Allow users to delete their accounts** in the Clerk dashboard so no other Clerk surface offers it.

## Database backups

`pnpm backup:db` writes a read-only JSON export of every application table to `backups/luban-db-<timestamp>.json` and prints row counts per table. It loads `.env*` files like the app, uses the same TLS rules, reads all tables in one `READ ONLY` snapshot, and never writes to the database. It refuses to run unless `LUBAN_DATABASE_PROVIDER=postgres` is set, so point `LUBAN_DATABASE_URL` at the database you mean to back up, for example only for that command. The `backups/` folder is gitignored. The file contains names and email addresses, so store it somewhere private. There is no restore command yet; the export is a record to rebuild from by hand.

## ETFs and crypto

ETFs and crypto are off by default and controlled by environment variables (see `.env.example`):

- `LUBAN_ENABLE_ETFS=true` lets students search for and buy ETFs listed on NYSE, NYSE Arca, NYSE American, NASDAQ, Cboe BZX and TSX. They trade like stocks: exchange hours and whole shares. Leveraged and inverse ETFs are filtered out by fund name, since the competition has no leverage or short selling.
- `LUBAN_ENABLE_CRYPTO=true` lets students add any crypto pair Yahoo Finance quotes in CAD or USD, as long as it passes the data checks: a price updated in the last 10 minutes, 24-hour volume of at least `LUBAN_CRYPTO_MIN_VOLUME` (default 250,000), and at least four hours of recent price history. USD pairs are converted with the live USD to CAD rate. Crypto trades 24/7 in whole lots. A coin's lot is the smallest power of ten of tokens worth at least $10 CAD when the coin is first added, and it never changes after that.

Both switches are read at request time, but Vercel only applies environment variable changes on a new deployment.

### Turning them on during a live competition

Adding asset classes changes the published contest rules, which promise participants an email before a change takes effect. Follow this order:

1. Back up the production database with `pnpm backup:db` and check the row counts.
2. Deploy the code with both switches still off in Production. Nothing changes for students yet.
3. On a preview deployment with its own database, set `LUBAN_ENABLE_ETFS=true` and `LUBAN_ENABLE_CRYPTO=true` and test: search and buy an ETF during market hours, confirm a leveraged ETF such as TQQQ doesn't appear, add a large coin and a small one, buy and sell whole lots, and check the dashboard and leaderboard values.
4. Publish the updated contest rules on the public site and email participants with the start time.
5. At that time, set both variables in Vercel Production and redeploy. Confirm in the production app that ETFs and crypto show up in search.

### Blocking a symbol

Add it to `LUBAN_BLOCKED_SYMBOLS` as a comma-separated list (for example `DOGE-USD,PEPE24478-USD`) and redeploy. Use the exact symbol the simulator shows. Blocking one pair of a coin (for example `DOGE-USD`) also blocks its other pair (`DOGE-CAD`). A blocked symbol disappears from search and can't be bought.

### What students can do when something is switched off

Turning off `LUBAN_ENABLE_ETFS` or `LUBAN_ENABLE_CRYPTO`, or blocking a symbol, stops new buys only. Students keep their holdings, the holdings keep counting toward portfolio value, and they can still sell them. Nobody is trapped in a position.

Crypto has two further pauses that need no action from a host:

- If a coin fails the data checks or stops being quoted, trading in it pauses in both directions and it's valued at its last known price until it recovers.
- If one lot of a coin becomes worth less than $1, new buys pause but selling still works.

All prices, including crypto and the USD to CAD rate, come from Yahoo Finance's unofficial API, which has no uptime guarantee. When it's unavailable, trading pauses for the affected symbols.

## Limit, stop loss, and take profit orders

Waiting orders are off for students until `LUBAN_ENABLE_WORKING_ORDERS=true`. Platform admins can always use them in their private sandbox, which is the way to try them on production before opening them up.

A buy can be a market or limit order; a sell can be market, limit, stop loss, or take profit. Buys can carry an optional take profit and stop loss (a bracket); with both, whichever fills first cancels the other. A waiting buy sets aside its cost at the limit (plus 2% on USD listings) and a waiting sell sets aside its shares, so nothing can be spent twice. Each team can have 20 waiting orders. Day orders end at the 4:00 p.m. ET close of the next session, skipping TSX holidays for CAD listings and US market holidays for USD ones (midnight ET for crypto; holiday lists in `lib/server/working-order-book.ts` cover 2026–2027); Good until cancelled orders last until they fill, a teammate cancels them, or the competition ends.

The price checker (`lib/server/working-order-engine.ts`) runs from two places:

- Every minute, Supabase `pg_cron` calls `POST /api/cron/working-orders` with `Authorization: Bearer <CRON_SECRET>`, but only while an order is waiting. Set up once with `scripts/working-orders-cron.sql`.
- As a backup, after dashboard loads and new placements, at most once every 30 seconds per server instance.

Runs may overlap; each order fills at most once. A fill re-checks under the team lock that the order is still waiting, and uses the exact quote that triggered it.

### Turning them on

1. Back up the production database with `pnpm backup:db`.
2. Deploy the code with `LUBAN_ENABLE_WORKING_ORDERS` unset. Nothing changes for students.
3. Generate a long random secret, set it as `CRON_SECRET` in Vercel Production, and redeploy.
4. In the Supabase SQL editor (pg_cron and pg_net enabled), run `scripts/working-orders-cron.sql` with `<CRON_SECRET>` replaced by the same value.
5. Try the orders from an admin sandbox: a limit buy far below the market stays waiting and can be cancelled; one above the market fills within a minute. `cron.job_run_details` should show calls while it waits.
6. Publish the updated contest rules and email participants with the start time.
7. At that time, set `LUBAN_ENABLE_WORKING_ORDERS=true` in Vercel Production and redeploy.

Switching it off again cancels students' waiting orders on the next check ("Waiting orders were switched off.") and frees their cash and shares. Cancelling always works, even while it's off.

## Schema and transactions

The application creates and seeds its schema on first use, with an advisory lock coordinating PostgreSQL initialization. Incremental schema changes are implemented in `lib/server/db.ts`. Row-level security is enabled without anonymous policies; browser clients do not access the database directly. Formal versioned migration tooling, scheduled backups, and operational monitoring remain deployment work; `pnpm backup:db` covers manual exports.

PostgreSQL orders hold a shared account-administration lock, a per-trader advisory lock, and the affected team's row lock. Account, invitation, and competition administration uses the exclusive account lock. This protects permission changes, invitation limits, idempotency, order limits, and portfolio updates across application instances. SQLite serializes writers with `BEGIN IMMEDIATE`.

## Verification and release

Run `pnpm verify` locally. The browser-test runner forces demo authentication, synthetic market data, and an isolated SQLite file for both build and runtime. It refuses a remote target or reusing an existing server. Tests never require a production database.

Unit/integration tests exercise PostgreSQL SQL through embedded PGlite. PGlite is a single-connection engine: a staging test with multiple real PostgreSQL connections is still required to validate pooler behavior and lock contention. Also verify real Clerk sign-in, invitation acceptance, second-factor enforcement, suspension, and the production hostname in staging.

The Yahoo adapter is a prototype feed. Verify the intended market-data provider's availability and redistribution terms before public operation. The public site's EmailJS contact delivery, provider abuse controls, production TLS certificates, backups, and deployed headers require checks in their respective environments; local test success does not establish those settings.

## Load testing

`scripts/load-test.mjs` simulates a class against a running server in demo mode: each student signs in, loads the dashboard, popular picks, a chart and the watchlist charts, then polls once a minute, switches symbols, searches and places an order now and then. It reports latency per endpoint, errors, response sizes, and server CPU, plus what that comes to per class-hour.

It writes its own students (`lt-001` and up) straight into the SQLite file the server uses, so run it against a throwaway database, never a real one:

```bash
pnpm build
LUBAN_AUTH_MODE=demo LUBAN_DEMO_MODE=true LUBAN_MARKET_DATA_PROVIDER=synthetic LUBAN_DATABASE_PATH=data/loadtest.sqlite pnpm start --port 3006
node scripts/load-test.mjs --base http://localhost:3006 --db data/loadtest.sqlite --users 75 --minutes 6
```

Every server instance shares fetched quotes and preset chart history through the `market_cache` table, so a class makes roughly one Yahoo request per symbol per minute however many instances Vercel runs.

