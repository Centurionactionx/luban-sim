# Luban Market Lab

Market Lab is the paper-trading simulator Luban runs for its student stock competitions. Students sign in on their own devices, join a team, and trade one shared team portfolio using real market prices. Hosts run the competition from the same app: they set the schedule and starting cash, pause trading, and freeze or disqualify teams.

It's live at [sim.lubancanada.com](https://sim.lubancanada.com). No real money moves anywhere. There's no brokerage connection, and nothing in the app is investment advice.

## Stack

- Next.js 16 (App Router) and React 19, TypeScript throughout
- SQLite through Node 24's built-in `node:sqlite` for local work, PostgreSQL (Supabase) in production
- Clerk for sign-in when running in managed mode
- Yahoo Finance for quotes and chart history, cached on the server
- Deployed on Vercel

Heads up: this Next.js version has breaking changes from what you might know. When an API looks unfamiliar, check `node_modules/next/dist/docs/` before guessing.

## Running it locally

You need Node 24 and pnpm.

```bash
git clone https://github.com/Centurionactionx/luban-sim.git
cd luban-sim
pnpm install
pnpm dev
```

Then open http://localhost:3000. Without any configuration the app runs in demo mode with a local SQLite file in `data/`, and it signs you in as Johnny, a student on the seeded Northstar Capital team. Use the identity picker to switch between people:

| Identity | Role | Team |
| --- | --- | --- |
| Johnny | Student (captain) | Northstar Capital |
| Menon | Student | Northstar Capital |
| Radin | Student | Northstar Capital |
| Joe (Host) | Competition host | none |
| Ada (Admin) | Platform admin | private test accounts |

To see the shared portfolio work, open two browser profiles (or a normal and a private window) as different teammates and trade from both. To start over, sign in as Joe and hit **Reset demo data**.

No API keys are needed for demo mode. Copy `.env.example` to `.env.local` when you want to change something; every variable is documented in that file.

## How trading works

The browser never decides a balance. An order goes to `POST /api/orders`, the server refreshes the quote, and `lib/server/trading.ts` does the rest inside one database transaction: check idempotency and the latest cash and holdings, apply the change, then write the order, ledger entry, activity event and portfolio version together. If the same order is retried with the same idempotency key, the original result comes back and the account is only charged once. Two teammates trading at the same moment can't push cash or shares negative.

Limit, stop loss and take profit orders live in `lib/server/working-orders.ts`. They wait in the database, and a cron job (Supabase `pg_cron` hitting `POST /api/cron/working-orders` every minute with `CRON_SECRET`) checks prices and fills them. The SQL for that job is in `scripts/working-orders-cron.sql`.

Competitions follow a schedule the host sets. Trading opens and closes on its own at those times, and the window is checked inside the order transaction, so nothing slips through at the boundary.

ETFs and crypto exist but are off unless `LUBAN_ENABLE_ETFS` / `LUBAN_ENABLE_CRYPTO` are set to `true`. Crypto trades in fixed lots, so its prices and quantities are per lot.

## Auth modes

`LUBAN_AUTH_MODE` picks between two modes.

**demo** is the default. It uses the seeded identities above and needs no keys. Production builds refuse it, and any Vercel deployment refuses it no matter what flags are set.

**managed** uses Clerk for passwords, email verification and sessions. Roles, teams and permissions stay in our database and the server checks them on every request. Registration is invite-only: a host makes a single-use link from Team & user management, and the student registers through `/join/<token>`. To create the very first admin, run:

```bash
pnpm bootstrap:admin -- --email you@example.ca
```

## Project layout

```text
app/            pages and API route handlers (app/api/*)
components/     UI; simulator-app.tsx is the main trading room and host panel
lib/            shared types, math and helpers
lib/server/     database, trading engine, quotes, admin logic
scripts/        one-off tools: roster import, DB backup, admin bootstrap, changelog
```

## Scripts

| Command | What it does |
| --- | --- |
| `pnpm dev` | Dev server on port 3000 |
| `pnpm build` / `pnpm start` | Production build and server |
| `pnpm lint` | ESLint, zero warnings allowed |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm changelog` | Regenerate `CHANGELOG.md` from `lib/changelog.ts` |
| `pnpm import:roster` | Import a participant roster |
| `pnpm backup:db` | Read-only export of the production database |

## Releasing

Every push to `main` deploys to production. Before pushing, bump the minor version in `package.json` (v1.29.0 is release 29) and add a matching entry to `lib/changelog.ts`, then run `pnpm changelog`. The footer shows the version next to the short commit SHA, which makes it easy to tell which build someone is looking at.

Environment variables, Supabase TLS and Clerk setup for production are covered in [DEPLOYMENT.md](./DEPLOYMENT.md).

## Known gaps

- Quotes come from Yahoo Finance's free feed. Anything commercial or public at scale would need a licensed Canadian and US data agreement.
- Hosts copy invitation links by hand. There's no email delivery yet.
- Schema changes don't have formal migration tooling.
