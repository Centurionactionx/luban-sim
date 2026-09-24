# Luban Market Lab — local architecture prototype

A working, local-first paper-trading prototype for Luban. Individual students sign in on separate devices, but every member of a team reads and trades against the same durable team portfolio. Hosts can pause a competition, edit any team's cash, and freeze, disqualify, or restore teams.

This is an educational simulator. It does not move real money, connect to a brokerage, or provide investment advice.

## What the prototype proves

- Three individual student identities share one `Northstar Capital` portfolio.
- A fresh or reset team has $100,000 CAD of buying cash but $0 invested portfolio value until its first purchase.
- Two sessions can trade at the same time without creating a negative cash or share balance.
- Orders are server-authoritative, atomic, and idempotent; a retry cannot debit the account twice.
- Every committed order updates cash, holdings, activity attribution, leaderboard value, and portfolio version.
- Symbol search discovers stocks across the TSX, Nasdaq, and NYSE family, including obscure listings that were not pre-seeded, with explicit exchange, currency, and CAD conversion.
- Quotes and `1D`/`5D`/`1M`/`3M` charts come from real timestamped Yahoo Finance market bars through a cached, replaceable server-side provider.
- A host can set any team's exact CAD cash balance, pause/resume trading, freeze/disqualify/restore a team, and reset the local demonstration. Cash edits are audited and reconciled in the ledger.
- A platform administrator can set an exact cash balance directly in the main trading workspace, then use the ordinary quote and order ticket against a private test portfolio. That account is excluded from teams, invitations, activity feeds, and the leaderboard.
- A platform administrator has a separate cash-backed Past → Present test account: the admin sets its exact starting cash, historical purchases debit that budget, and current portfolio value includes remaining cash without touching any competition team.
- The responsive web interface supports a 320 px viewport, so the same codebase covers laptops and phones.

## Architecture

```text
Browser session (Johnny / Menon / Radin / Joe as Host)
                 │
                 ▼
        Next.js App Router UI
                 │  polling + validated mutations
                 ▼
          Route handlers /api/*
                 │  auth, Zod validation, HTTP errors
                 ▼
       Domain services in lib/server
          ├── transactional order engine
          ├── portfolio + leaderboard queries
          ├── host administration
          ├── private admin live-trading sandbox
          ├── isolated admin valuation sandbox
          └── cached MarketDataProvider interface ──► Yahoo search + chart feeds
                 │                                    (prototype only)
                 ▼
      One async data layer, two engines:
      SQLite (local default, WAL)  |  PostgreSQL (LUBAN_DATABASE_PROVIDER=postgres)
```

The browser never computes or writes the authoritative balance. The order route refreshes its market quote before opening a database transaction. `placeOrder` then starts a SQLite `BEGIN IMMEDIATE` transaction, rechecks idempotency and the latest durable balances, applies the cash and position change, records the order, ledger entry, activity event, and portfolio version, then commits them together. SQLite serializes competing writers; an idempotent replay is returned without depending on the external market feed.

## Run it locally

Requirements: Node.js 24 and pnpm 11.

```bash
git clone https://github.com/Centurionactionx/luban-sim.git
cd luban-sim
pnpm install
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000). The app signs into Johnny automatically on first load; use the identity selector to open Menon, Radin, or Joe (Host). For a convincing shared-account test, use two different browser profiles or an ordinary and private window.

No market-data API key is required. The default provider calls Yahoo Finance from the Next.js server, caches symbol searches for 10 minutes, current quotes for at least 60 seconds, applies a 60-second cooldown after failures or rate limits, caches daily history for 15 minutes, and preserves the last real response as visibly stale if a refresh fails. Search accepts company names or tickers and filters results to equities on the TSX, Nasdaq, NYSE, NYSE American, and NYSE Arca; TSXV, CSE, NEO, OTC, funds, options, warrants, rights, and units are excluded. Search results are metadata only: the server fetches a chart and persists an instrument only when a user selects it. Unowned discoveries do not join the global refresh loop, while the selected quote and every held position still refresh at the one-minute market cadence. This prevents catalog growth from multiplying upstream requests. It never replaces a failed real response with generated chart points. Copy `.env.example` only if you need to make the provider mode explicit; `LUBAN_MARKET_DATA_PROVIDER=synthetic` is intended for deterministic tests, not the demonstration.

The database seeds itself on first use. To start over, switch to `Joe (Host)` and use **Reset demo data**. The same reset is available through `POST /api/admin/reset` for automated verification.

For Vercel and Supabase setup, including PostgreSQL TLS and managed authentication, see [DEPLOYMENT.md](./DEPLOYMENT.md).

## Demo identities

| Identity | Role | Team |
| --- | --- | --- |
| Johnny | Student / captain | Northstar Capital |
| Menon | Student / trader | Northstar Capital |
| Radin | Student / analyst | Northstar Capital |
| Joe (Host) | Competition host | No trading team |
| Ada (Admin) | Platform administrator | Private live-trading and valuation sandboxes |

Demo sessions use opaque, hashed, HTTP-only cookies. They are intentionally not a production sign-in system.
Production builds reject demo login unless `LUBAN_DEMO_MODE=true`; enable that flag only for a private preview, never as the authentication model for a real deployment.

## Real sign-in (managed mode)

Setting `LUBAN_AUTH_MODE=managed` replaces the demo identity switcher with real
registration and sign-in through [Clerk](https://clerk.com), which handles
passwords, email verification, password resets, MFA enrollment, and session
cookies. Luban keeps authorization: roles, teams, competition access, account
status, and the security audit log all live in the local database and are
checked by the server on every protected operation.

- **Invitation-only registration.** There is no open sign-up and no public
  "register as admin" path. A host creates a single-use, expiring invitation
  from **Accounts & invitations** (also `POST /api/admin/invitations`); the
  student opens the `/join/<token>` link, registers with a verified email, and
  is placed on their assigned team. Tokens are stored only as SHA-256 hashes
  and are consumed transactionally, so a link can never be redeemed twice.
- **Roles.** `student` trades with their team; `host` runs the competition;
  `platform_admin` additionally invites hosts and administrators. Roles are
  never accepted from the browser.
- **First administrator.** Bootstrap out of band with
  `pnpm bootstrap:admin -- --email you@example.ca`, which prints a single-use
  platform-admin invitation link — or set `LUBAN_BOOTSTRAP_ADMIN_EMAIL` so the
  first verified sign-in with that email becomes the only bootstrapped admin.
- **Admin MFA.** In managed mode, host and admin actions require the account
  to have multi-factor authentication enrolled and a second factor verified in
  the current session (checked server-side, failing closed). `LUBAN_REQUIRE_ADMIN_MFA=false` disables the
  gate only while a Clerk plan without MFA strategies is in use.
- **Audit trail.** Invitation creation/revocation/acceptance, account
  creation, and admin bootstrap are recorded in `auth_audit_events` without
  tokens or secrets.

Managed mode needs `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` and `CLERK_SECRET_KEY`
(see `.env.example`). Demo mode remains the default and runs without any
provider keys; the automated test suites cover demo mode plus the invitation,
bootstrap, and MFA-policy logic directly.

## Verification

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm test:coverage
pnpm build
pnpm test:e2e
```

`pnpm test` includes provider fixtures plus a two-process contention test against one SQLite file. The provider tests verify exact timestamps, null-candle removal, request coalescing, stale-cache disclosure, upstream failure, and all four range mappings. Playwright uses the locally installed Chrome and covers range switching, separate student contexts, visible host controls, phone-width behavior, and automated accessibility checks.

## API surface

| Route | Purpose |
| --- | --- |
| `POST /api/auth/demo-login` | Create/switch a demo session (demo mode only) |
| `POST /api/auth/logout` | Revoke only the current session |
| `GET /api/auth/session` | Read the current identity and auth mode |
| `GET /api/admin/invitations` | Host/admin: list issued invitations |
| `POST /api/admin/invitations` | Host/admin: create a single-use invitation |
| `DELETE /api/admin/invitations/:id` | Host/admin: revoke an unused invitation |
| `POST /api/invitations/accept` | Managed mode: redeem an invitation token |
| `GET /api/dashboard` | Shared portfolio, holdings, activity, quotes, and standings |
| `GET /api/quotes?q=...` | Search TSX, Nasdaq, and NYSE-family stock metadata |
| `GET /api/quotes?symbol=DAKT` | Resolve one supported symbol and return its current quote |
| `GET /api/quotes/history?symbol=SHOP.TO&range=1D` | Real timestamped OHLCV history and matching quote |
| `GET /api/orders` | Read visible order history |
| `POST /api/orders` | Commit an idempotent market order |
| `GET /api/activity` | Read attributed team/competition activity |
| `GET /api/admin/overview` | Host-only team and competition state |
| `PATCH /api/admin/competition` | Pause/resume, set the schedule window, or set starting cash |
| `PATCH /api/admin/teams/:teamId` | Freeze, disqualify, or restore a team |
| `PATCH /api/admin/teams/:teamId/cash` | Set a team's exact CAD cash balance in cents |
| `PATCH /api/admin/trading-account/cash` | Platform admin: set the caller's private main-trading cash balance in cents |
| `GET /api/admin/valuation-lab` | Platform admin: read the isolated historical test portfolio |
| `PATCH /api/admin/valuation-lab` | Platform admin: set the test account's exact starting cash in cents |
| `POST /api/admin/valuation-lab` | Platform admin: record an affordable historical test purchase |
| `DELETE /api/admin/valuation-lab` | Platform admin: clear test positions while retaining configured cash |
| `POST /api/admin/reset` | Restore seeded prototype state (demo mode only) |

All responses are private and `no-store`. Business conflicts return stable error codes such as `INSUFFICIENT_CASH`, `INSUFFICIENT_SHARES`, `TRADING_CLOSED`, and `IDEMPOTENCY_CONFLICT`. Order attempts are capped per trader per rolling minute (`ORDER_RATE_LIMITED`, default 20 via `LUBAN_MAX_ORDERS_PER_MINUTE`) — enough for continuous day trading, low enough to stop runaway scripts.

Competitions run on a schedule: the host sets start/end date-times and team starting cash from the host panel, and trading opens and closes automatically at those instants (`scheduled` → `open` → `ended`), with manual pause/resume still available. The window is enforced inside the order transaction, so no trade can slip past the boundary. Starting cash can only change before the first fill.

## Where the server side should be hosted

For this local prototype, the UI, route handlers, domain services, and SQLite database all run in one Node.js process on the developer's computer.

For a no-cost public preview, a practical current path is a free Render Node web service paired with a free Neon or Supabase Postgres database. Render's free web service sleeps after inactivity and its filesystem is ephemeral, so the checked-in SQLite adapter must not be treated as persistent there. Render explicitly recommends an external relational database for durable state. Neon and Supabase both publish free Postgres tiers suitable for a small prototype. See the current provider limits before an event:

- [Render free services and limitations](https://render.com/docs/free)
- [Neon pricing](https://neon.com/pricing)
- [Supabase pricing](https://supabase.com/pricing)

Vercel can host the Next.js UI and route handlers, but its free Hobby plan is limited to personal, non-commercial use. If Luban is deploying this as an organizational service, confirm plan eligibility rather than assuming Hobby applies: [Vercel Hobby plan](https://vercel.com/docs/plans/hobby).

The data layer now runs on managed PostgreSQL when `LUBAN_DATABASE_PROVIDER=postgres` and `LUBAN_DATABASE_URL` are set (see DEPLOYMENT.md); the PostgreSQL code paths are exercised in the test suite against an embedded Postgres. Replace the keyless Yahoo prototype adapter with a licensed Canadian/U.S. market-data agreement that has published availability, delay, redistribution, and rate-limit terms.

## Not production-ready yet

- Real authentication now exists behind `LUBAN_AUTH_MODE=managed` (Clerk sign-in, invitation-only registration, bootstrapped admin, admin MFA). Suspension, role/team management, order limits, and invitation limits are implemented. Still open: provider-session-revocation UI, shared read-endpoint rate limits, and email delivery of invitations (links are currently copied by the host).
- Define privacy, parental-consent, safeguarding, retention, and account-deletion policies for minors.
- PostgreSQL support has landed (dual-engine data layer, tested against embedded Postgres). Still open: formal migration tooling for future schema changes, backups, and monitoring.
- Replace the working Yahoo prototype feed with licensed Canadian/U.S. market data before public or commercial redistribution; keep brokerage execution out of scope unless Luban deliberately enters a regulated workflow.
- Add competition creation/rule management, email flows, recovery, audit export, and operational support tooling.
- Run a formal accessibility audit with students using phones and assistive technology.

## Key implementation files

- `components/simulator-app.tsx` — shared trading room and host UI
- `app/api/` — authenticated HTTP boundary
- `lib/server/trading.ts` — atomic/idempotent order transaction
- `lib/server/quotes.ts` — cached Yahoo adapter, exact history parser, and deterministic test provider
- `lib/server/db.ts` — schema, seed data, WAL configuration, and reset
- `tests/integration/concurrency.test.ts` — real two-process cash contention proof
- `tests/e2e/` — browser-level multi-session and accessibility verification

Browser tests build in isolated demo/SQLite mode and use `data/luban.e2e.sqlite`. They refuse remote targets or an already-running server. Run `pnpm test:e2e`; use port 3010 only for this disposable test server. See [AUDIT.md](./AUDIT.md) for the security review and remaining deployment checks.
