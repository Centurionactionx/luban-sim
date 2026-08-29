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
          └── cached MarketDataProvider interface ──► Yahoo search + chart feeds
                 │                                    (prototype only)
                 ▼
      Node 24 SQLite, WAL journal mode
      data/luban.sqlite (local, regenerable)
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

For Vercel and Supabase setup, including the current SQLite limitation, see [DEPLOYMENT.md](./DEPLOYMENT.md).

## Demo identities

| Identity | Role | Team |
| --- | --- | --- |
| Johnny | Student / captain | Northstar Capital |
| Menon | Student / trader | Northstar Capital |
| Radin | Student / analyst | Northstar Capital |
| Joe (Host) | Competition host | No trading team |

Demo sessions use opaque, hashed, HTTP-only cookies. They are intentionally not a production sign-in system.
Production builds reject demo login unless `LUBAN_DEMO_MODE=true`; enable that flag only for a private preview, never as the authentication model for a real deployment.

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
| `POST /api/auth/demo-login` | Create/switch a demo session |
| `POST /api/auth/logout` | Revoke only the current session |
| `GET /api/auth/session` | Read the current identity |
| `GET /api/dashboard` | Shared portfolio, holdings, activity, quotes, and standings |
| `GET /api/quotes?q=...` | Search TSX, Nasdaq, and NYSE-family stock metadata |
| `GET /api/quotes?symbol=DAKT` | Resolve one supported symbol and return its current quote |
| `GET /api/quotes/history?symbol=SHOP.TO&range=1D` | Real timestamped OHLCV history and matching quote |
| `GET /api/orders` | Read visible order history |
| `POST /api/orders` | Commit an idempotent market order |
| `GET /api/activity` | Read attributed team/competition activity |
| `GET /api/admin/overview` | Host-only team and competition state |
| `PATCH /api/admin/competition` | Pause or resume the competition |
| `PATCH /api/admin/teams/:teamId` | Freeze, disqualify, or restore a team |
| `PATCH /api/admin/teams/:teamId/cash` | Set a team's exact CAD cash balance in cents |
| `POST /api/admin/reset` | Restore seeded prototype state |

All responses are private and `no-store`. Business conflicts return stable error codes such as `INSUFFICIENT_CASH`, `INSUFFICIENT_SHARES`, `TRADING_CLOSED`, and `IDEMPOTENCY_CONFLICT`.

## Where the server side should be hosted

For this local prototype, the UI, route handlers, domain services, and SQLite database all run in one Node.js process on the developer's computer.

For a no-cost public preview, a practical current path is a free Render Node web service paired with a free Neon or Supabase Postgres database. Render's free web service sleeps after inactivity and its filesystem is ephemeral, so the checked-in SQLite adapter must not be treated as persistent there. Render explicitly recommends an external relational database for durable state. Neon and Supabase both publish free Postgres tiers suitable for a small prototype. See the current provider limits before an event:

- [Render free services and limitations](https://render.com/docs/free)
- [Neon pricing](https://neon.com/pricing)
- [Supabase pricing](https://supabase.com/pricing)

Vercel can host the Next.js UI and route handlers, but its free Hobby plan is limited to personal, non-commercial use. If Luban is deploying this as an organizational service, confirm plan eligibility rather than assuming Hobby applies: [Vercel Hobby plan](https://vercel.com/docs/plans/hobby).

Before any multi-instance deployment, replace `lib/server/db.ts` with a managed PostgreSQL adapter while keeping the existing service contracts and transaction rules. Replace the keyless Yahoo prototype adapter with a licensed Canadian/U.S. market-data agreement that has published availability, delay, redistribution, and rate-limit terms.

## Not production-ready yet

- Replace demo switching with real authentication, invitations, team membership, and host authorization.
- Define privacy, parental-consent, safeguarding, retention, and account-deletion policies for minors.
- Migrate SQLite to managed PostgreSQL and add formal migrations, backups, monitoring, and rate limits.
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
