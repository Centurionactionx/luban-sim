import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { LedgerReconciliation } from "../contracts";
import { AppError } from "../errors";

const DEFAULT_DATABASE_PATH = join(process.cwd(), "data", "luban.sqlite");

const globalDatabase = globalThis as typeof globalThis & {
  __lubanSimulatorDatabase?: DatabaseSync;
  __lubanSimulatorSchemaVersion?: number;
};

const SCHEMA_VERSION = 3;

function createDatabase(): DatabaseSync {
  const databasePath = process.env.LUBAN_DATABASE_PATH ?? DEFAULT_DATABASE_PATH;

  if (databasePath !== ":memory:") {
    mkdirSync(dirname(databasePath), { recursive: true });
  }

  const database = new DatabaseSync(databasePath);
  database.exec("PRAGMA foreign_keys = ON;");
  database.exec("PRAGMA busy_timeout = 5000;");
  database.exec("PRAGMA journal_mode = WAL;");
  createSchema(database);
  globalDatabase.__lubanSimulatorSchemaVersion = SCHEMA_VERSION;
  seedIfEmpty(database);

  return database;
}

function createSchema(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      role TEXT NOT NULL CHECK (role IN ('student', 'host')),
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS competitions (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('draft', 'active', 'paused', 'ended')),
      base_currency TEXT NOT NULL DEFAULT 'CAD' CHECK (base_currency = 'CAD'),
      starting_cash_cents INTEGER NOT NULL CHECK (starting_cash_cents >= 0),
      starts_at TEXT NOT NULL,
      ends_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS teams (
      id TEXT PRIMARY KEY,
      competition_id TEXT NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('active', 'frozen', 'disqualified')),
      cash_cents INTEGER NOT NULL CHECK (cash_cents >= 0),
      version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
      created_at TEXT NOT NULL,
      UNIQUE (competition_id, name)
    );

    CREATE TABLE IF NOT EXISTS team_members (
      team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      is_captain INTEGER NOT NULL DEFAULT 0 CHECK (is_captain IN (0, 1)),
      joined_at TEXT NOT NULL,
      PRIMARY KEY (team_id, user_id),
      UNIQUE (user_id)
    );

    CREATE TABLE IF NOT EXISTS instruments (
      symbol TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      exchange TEXT NOT NULL,
      sector TEXT NOT NULL,
      listing_currency TEXT NOT NULL CHECK (listing_currency IN ('CAD', 'USD')),
      base_price_cents INTEGER NOT NULL CHECK (base_price_cents > 0),
      previous_close_cents INTEGER NOT NULL CHECK (previous_close_cents > 0),
      fx_rate_basis_points INTEGER NOT NULL CHECK (fx_rate_basis_points > 0),
      is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
      auto_refresh INTEGER NOT NULL DEFAULT 1 CHECK (auto_refresh IN (0, 1))
    );

    CREATE TABLE IF NOT EXISTS holdings (
      team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      symbol TEXT NOT NULL REFERENCES instruments(symbol),
      quantity INTEGER NOT NULL CHECK (quantity >= 0),
      average_cost_cents INTEGER NOT NULL CHECK (average_cost_cents >= 0),
      updated_at TEXT NOT NULL,
      PRIMARY KEY (team_id, symbol)
    );

    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY,
      idempotency_key TEXT NOT NULL UNIQUE,
      request_fingerprint TEXT NOT NULL,
      team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      actor_user_id TEXT NOT NULL REFERENCES users(id),
      symbol TEXT NOT NULL REFERENCES instruments(symbol),
      side TEXT NOT NULL CHECK (side IN ('BUY', 'SELL')),
      quantity INTEGER NOT NULL CHECK (quantity > 0),
      fill_price_cents INTEGER NOT NULL CHECK (fill_price_cents > 0),
      fill_price_cad_cents INTEGER NOT NULL CHECK (fill_price_cad_cents > 0),
      gross_cents INTEGER NOT NULL CHECK (gross_cents > 0),
      cash_after_cents INTEGER NOT NULL CHECK (cash_after_cents >= 0),
      holding_quantity_after INTEGER NOT NULL CHECK (holding_quantity_after >= 0),
      portfolio_version INTEGER NOT NULL CHECK (portfolio_version >= 0),
      status TEXT NOT NULL CHECK (status IN ('FILLED', 'REJECTED')),
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS idempotency_records (
      actor_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      idempotency_key TEXT NOT NULL,
      request_fingerprint TEXT NOT NULL,
      outcome_type TEXT NOT NULL CHECK (outcome_type IN ('FILLED', 'REJECTED')),
      order_id TEXT REFERENCES orders(id) ON DELETE CASCADE,
      result_json TEXT,
      error_json TEXT,
      created_at TEXT NOT NULL,
      PRIMARY KEY (actor_user_id, idempotency_key),
      CHECK (
        (outcome_type = 'FILLED' AND order_id IS NOT NULL AND result_json IS NOT NULL AND error_json IS NULL)
        OR
        (outcome_type = 'REJECTED' AND order_id IS NULL AND result_json IS NULL AND error_json IS NOT NULL)
      )
    );

    CREATE TABLE IF NOT EXISTS ledger_entries (
      id TEXT PRIMARY KEY,
      team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      order_id TEXT REFERENCES orders(id) ON DELETE SET NULL,
      entry_type TEXT NOT NULL CHECK (entry_type IN ('STARTING_CASH', 'BUY', 'SELL', 'ADJUSTMENT')),
      amount_cents INTEGER NOT NULL,
      symbol TEXT REFERENCES instruments(symbol),
      quantity INTEGER,
      note TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS activity_events (
      id TEXT PRIMARY KEY,
      competition_id TEXT NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
      team_id TEXT REFERENCES teams(id) ON DELETE CASCADE,
      actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      detail TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS portfolio_snapshots (
      id TEXT PRIMARY KEY,
      team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      total_value_cents INTEGER NOT NULL CHECK (total_value_cents >= 0),
      captured_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      revoked_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_activity_competition_created
      ON activity_events (competition_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_activity_team_created
      ON activity_events (team_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_orders_team_created
      ON orders (team_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_holdings_symbol_quantity
      ON holdings (symbol, quantity);
    CREATE INDEX IF NOT EXISTS idx_idempotency_order
      ON idempotency_records (order_id);
    CREATE INDEX IF NOT EXISTS idx_snapshots_team_captured
      ON portfolio_snapshots (team_id, captured_at ASC);
    CREATE INDEX IF NOT EXISTS idx_sessions_user
      ON sessions (user_id);
  `);

  ensureOrderReceiptColumns(database);
  ensureInstrumentRefreshColumn(database);
}

function ensureInstrumentRefreshColumn(database: DatabaseSync): void {
  const columns = database.prepare("PRAGMA table_info(instruments)").all() as unknown as Array<{
    name: string;
  }>;

  if (!columns.some((column) => column.name === "auto_refresh")) {
    database.exec(`
      ALTER TABLE instruments
      ADD COLUMN auto_refresh INTEGER NOT NULL DEFAULT 1
      CHECK (auto_refresh IN (0, 1));
    `);
  }

  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_instruments_auto_refresh
    ON instruments (auto_refresh, is_active);
  `);
}

function ensureOrderReceiptColumns(database: DatabaseSync): void {
  const columns = database.prepare("PRAGMA table_info(orders)").all() as unknown as Array<{
    name: string;
  }>;
  const names = new Set(columns.map((column) => column.name));

  if (!names.has("cash_after_cents")) {
    database.exec(
      "ALTER TABLE orders ADD COLUMN cash_after_cents INTEGER NOT NULL DEFAULT 0;",
    );
  }

  if (!names.has("holding_quantity_after")) {
    database.exec(
      "ALTER TABLE orders ADD COLUMN holding_quantity_after INTEGER NOT NULL DEFAULT 0;",
    );
  }

  if (!names.has("portfolio_version")) {
    database.exec(
      "ALTER TABLE orders ADD COLUMN portfolio_version INTEGER NOT NULL DEFAULT 0;",
    );
  }
}

function isoDaysFrom(reference: Date, days: number, hours = 0): string {
  return new Date(
    reference.getTime() + days * 86_400_000 + hours * 3_600_000,
  ).toISOString();
}

function seedIfEmpty(database: DatabaseSync): void {
  const row = database.prepare("SELECT COUNT(*) AS count FROM users").get() as
    | { count: number }
    | undefined;

  if (!row || Number(row.count) === 0) {
    seedDatabase(database, false);
  }
}

function clearDomainData(database: DatabaseSync, preserveSessions: boolean): void {
  if (!preserveSessions) {
    database.exec("DELETE FROM sessions;");
  }

  database.exec(`
    DELETE FROM portfolio_snapshots;
    DELETE FROM activity_events;
    DELETE FROM ledger_entries;
    DELETE FROM idempotency_records;
    DELETE FROM orders;
    DELETE FROM holdings;
    DELETE FROM team_members;
    DELETE FROM teams;
    DELETE FROM competitions;
    DELETE FROM instruments;
  `);
}

function seedDatabase(database: DatabaseSync, preserveSessions: boolean): void {
  const now = new Date();
  const createdAt = isoDaysFrom(now, -7);

  database.exec("BEGIN IMMEDIATE;");

  try {
    clearDomainData(database, preserveSessions);

    const insertUser = database.prepare(`
      INSERT INTO users (id, name, email, role, created_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        email = excluded.email,
        role = excluded.role
    `);

    insertUser.run("alex", "Johnny", "alex@demo.luban.org", "student", createdAt);
    insertUser.run("maya", "Menon", "maya@demo.luban.org", "student", createdAt);
    insertUser.run("jordan", "Radin", "jordan@demo.luban.org", "student", createdAt);
    insertUser.run("host", "Joe (Host)", "host@demo.luban.org", "host", createdAt);

    database.prepare(`
      INSERT INTO competitions (
        id, name, status, base_currency, starting_cash_cents,
        starts_at, ends_at, created_at
      ) VALUES (?, ?, ?, 'CAD', ?, ?, ?, ?)
    `).run(
      "fall-2026",
      "Luban Fall Market Challenge",
      "active",
      10_000_000,
      isoDaysFrom(now, -4),
      isoDaysFrom(now, 25),
      createdAt,
    );

    const insertTeam = database.prepare(`
      INSERT INTO teams (
        id, competition_id, name, status, cash_cents, version, created_at
      ) VALUES (?, 'fall-2026', ?, 'active', ?, ?, ?)
    `);

    insertTeam.run("northstar", "Northstar Capital", 10_000_000, 0, createdAt);
    insertTeam.run("maple-alpha", "Maple Alpha", 10_000_000, 0, createdAt);
    insertTeam.run("aurora-fund", "Aurora Fund", 10_000_000, 0, createdAt);
    insertTeam.run("cedar-street", "Cedar Street", 10_000_000, 0, createdAt);

    const insertMember = database.prepare(`
      INSERT INTO team_members (team_id, user_id, is_captain, joined_at)
      VALUES ('northstar', ?, ?, ?)
    `);

    insertMember.run("alex", 1, isoDaysFrom(now, -6, 1));
    insertMember.run("maya", 0, isoDaysFrom(now, -6, 2));
    insertMember.run("jordan", 0, isoDaysFrom(now, -5, 3));

    const insertInstrument = database.prepare(`
      INSERT INTO instruments (
        symbol, name, exchange, sector, listing_currency,
        base_price_cents, previous_close_cents, fx_rate_basis_points,
        is_active, auto_refresh
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 1)
    `);

    const instruments = [
      ["SHOP.TO", "Shopify Inc.", "TSX", "Technology", "CAD", 15_840, 15_610, 10_000],
      ["RY.TO", "Royal Bank of Canada", "TSX", "Financials", "CAD", 21_765, 21_590, 10_000],
      ["TD.TO", "Toronto-Dominion Bank", "TSX", "Financials", "CAD", 11_520, 11_440, 10_000],
      ["ENB.TO", "Enbridge Inc.", "TSX", "Energy", "CAD", 6_590, 6_625, 10_000],
      ["CNR.TO", "Canadian National Railway", "TSX", "Industrials", "CAD", 14_480, 14_390, 10_000],
      ["XEQT.TO", "iShares Core Equity ETF", "TSX", "ETF", "CAD", 3_925, 3_901, 10_000],
      ["BNS.TO", "Bank of Nova Scotia", "TSX", "Financials", "CAD", 9_025, 8_970, 10_000],
      ["AAPL", "Apple Inc.", "NASDAQ", "Technology", "USD", 23_845, 23_610, 13_600],
      ["MSFT", "Microsoft Corporation", "NASDAQ", "Technology", "USD", 51_020, 50_750, 13_600],
      ["NVDA", "NVIDIA Corporation", "NASDAQ", "Technology", "USD", 18_935, 18_620, 13_600],
    ] as const;

    for (const instrument of instruments) {
      insertInstrument.run(...instrument);
    }

    const insertLedger = database.prepare(`
      INSERT INTO ledger_entries (
        id, team_id, order_id, entry_type, amount_cents,
        symbol, quantity, note, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const teamId of ["northstar", "maple-alpha", "aurora-fund", "cedar-street"]) {
      insertLedger.run(
        `seed-ledger-${teamId}`,
        teamId,
        null,
        "STARTING_CASH",
        10_000_000,
        null,
        null,
        "Competition starting balance",
        isoDaysFrom(now, -4),
      );
    }

    const insertActivity = database.prepare(`
      INSERT INTO activity_events (
        id, competition_id, team_id, actor_user_id, type,
        title, detail, created_at
      ) VALUES (?, 'fall-2026', ?, ?, ?, ?, ?, ?)
    `);

    insertActivity.run(
      "activity-created",
      null,
      "host",
      "TEAM_CREATED",
      "Competition created",
      "Joe created the Luban Fall Market Challenge.",
      isoDaysFrom(now, -7),
    );
    insertActivity.run(
      "activity-members",
      "northstar",
      "alex",
      "MEMBER_JOINED",
      "Northstar Capital is ready",
      "Johnny, Menon, and Radin joined the shared team portfolio.",
      isoDaysFrom(now, -5),
    );

    const insertSnapshot = database.prepare(`
      INSERT INTO portfolio_snapshots (id, team_id, total_value_cents, captured_at)
      VALUES (?, ?, ?, ?)
    `);

    const northstarHistory = [0, 0, 0, 0, 0, 0, 0];

    northstarHistory.forEach((value, index) => {
      insertSnapshot.run(
        `snapshot-northstar-${index}`,
        "northstar",
        value,
        isoDaysFrom(now, index - 6),
      );
    });

    assertLedgerBalances(database);

    database.exec("COMMIT;");
  } catch (error) {
    database.exec("ROLLBACK;");
    throw error;
  }
}

export function getDatabase(): DatabaseSync {
  if (!globalDatabase.__lubanSimulatorDatabase) {
    globalDatabase.__lubanSimulatorDatabase = createDatabase();
  } else if (globalDatabase.__lubanSimulatorSchemaVersion !== SCHEMA_VERSION) {
    createSchema(globalDatabase.__lubanSimulatorDatabase);
    globalDatabase.__lubanSimulatorSchemaVersion = SCHEMA_VERSION;
  }

  return globalDatabase.__lubanSimulatorDatabase;
}

function reconcileLedgerRows(database: DatabaseSync): LedgerReconciliation[] {
  const rows = database.prepare(`
    SELECT
      t.id AS team_id,
      t.name AS team_name,
      t.cash_cents,
      COALESCE(SUM(l.amount_cents), 0) AS ledger_balance_cents
    FROM teams t
    LEFT JOIN ledger_entries l ON l.team_id = t.id
    GROUP BY t.id, t.name, t.cash_cents
    ORDER BY t.name ASC
  `).all() as unknown as Array<{
    team_id: string;
    team_name: string;
    cash_cents: number;
    ledger_balance_cents: number;
  }>;

  return rows.map((row) => {
    const cashCents = Number(row.cash_cents);
    const ledgerBalanceCents = Number(row.ledger_balance_cents);
    const differenceCents = ledgerBalanceCents - cashCents;
    return {
      teamId: row.team_id,
      teamName: row.team_name,
      cashCents,
      ledgerBalanceCents,
      differenceCents,
      reconciled: differenceCents === 0,
    };
  });
}

function assertLedgerBalances(database: DatabaseSync): LedgerReconciliation[] {
  const report = reconcileLedgerRows(database);
  const failures = report.filter((team) => !team.reconciled);

  if (failures.length > 0) {
    throw new AppError(
      "LEDGER_OUT_OF_BALANCE",
      "One or more team cash balances do not reconcile to the ledger.",
      500,
      { teams: failures },
    );
  }

  return report;
}

export function reconcileLedgers(): LedgerReconciliation[] {
  return reconcileLedgerRows(getDatabase());
}

export function assertLedgerReconciles(): LedgerReconciliation[] {
  return assertLedgerBalances(getDatabase());
}

export function withReadTransaction<T>(work: () => T): T {
  const database = getDatabase();

  if (database.isTransaction) {
    return work();
  }

  database.exec("BEGIN;");

  try {
    const result = work();
    database.exec("COMMIT;");
    return result;
  } catch (error) {
    try {
      database.exec("ROLLBACK;");
    } catch {
      // Preserve the read failure that initiated the rollback.
    }
    throw error;
  }
}

export function resetPrototypeDatabase(): void {
  const database = getDatabase();
  createSchema(database);
  seedDatabase(database, true);
}
