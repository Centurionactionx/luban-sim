import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { Pool, types as pgTypes } from "pg";

import type { LedgerReconciliation } from "../contracts";
import { AppError } from "../errors";
import {
  ADVISORY_LOCK_SCHEMA,
  acquireAdvisoryLock,
  createPostgresAppDatabase,
  createSqliteAppDatabase,
  type AppDatabase,
  type DatabaseEngine,
  type DbExecutor,
  type PgDriver,
  type PgQueryFn,
} from "./database";

import { postgresConnectionOptions } from "./postgres-config";

const DEFAULT_DATABASE_PATH = join(process.cwd(), "data", "luban.sqlite");
const SCHEMA_VERSION = 20;
/** Map grouping within a sector; "Other" until the feed reports one. */
const INSTRUMENT_INDUSTRY_COLUMN = "industry TEXT NOT NULL DEFAULT 'Other'";

const globalDatabase = globalThis as typeof globalThis & {
  __lubanSqliteHandle?: DatabaseSync;
  __lubanSimulatorSchemaVersion?: number;
  __lubanAppDatabase?: Promise<AppDatabase>;
  __lubanAppDatabaseOverride?: AppDatabase;
};

/**
 * Engine selection is explicit, never inferred from the mere presence of
 * credentials: local development and the automated suites stay on SQLite
 * unless LUBAN_DATABASE_PROVIDER=postgres is deliberately set.
 */
export function getDbEngine(): DatabaseEngine {
  return process.env.LUBAN_DATABASE_PROVIDER === "postgres"
    ? "postgres"
    : "sqlite";
}

export function getDb(): Promise<AppDatabase> {
  if (globalDatabase.__lubanAppDatabaseOverride) {
    return Promise.resolve(globalDatabase.__lubanAppDatabaseOverride);
  }

  if (
    globalDatabase.__lubanAppDatabase &&
    getDbEngine() === "sqlite" &&
    globalDatabase.__lubanSimulatorSchemaVersion !== SCHEMA_VERSION
  ) {
    // A dev-server hot reload kept the process-global SQLite handle from an
    // older module version: re-run the idempotent schema pass once.
    globalDatabase.__lubanAppDatabase = undefined;
  }

  if (!globalDatabase.__lubanAppDatabase) {
    const initialization = initializeAppDatabase();
    globalDatabase.__lubanAppDatabase = initialization;
    // A transient failure (e.g. the database briefly unreachable during a
    // cold start) must not poison the memo forever: clear it so the next
    // request retries initialization from scratch.
    initialization.catch(() => {
      if (globalDatabase.__lubanAppDatabase === initialization) {
        globalDatabase.__lubanAppDatabase = undefined;
      }
    });
  }

  return globalDatabase.__lubanAppDatabase;
}

/**
 * Test seam: routes every domain call through the supplied database (used to
 * exercise the real PostgreSQL code paths against an embedded engine).
 * Pass null to restore normal resolution.
 */
export function __setAppDatabaseForTests(database: AppDatabase | null): void {
  globalDatabase.__lubanAppDatabaseOverride = database ?? undefined;
}

async function initializeAppDatabase(): Promise<AppDatabase> {
  if (getDbEngine() === "postgres") {
    const app = createPostgresAppDatabase(createPgPoolDriver());
    await initializeAppDatabaseSchema(app);
    return app;
  }

  const handle = openSqliteHandle();
  const app = createSqliteAppDatabase(handle);
  await seedIfEmpty(app);
  await syncLocalDemoAdmin(app);
  return app;
}

/* ─────────────────────────── SQLite bootstrap ──────────────────────── */

function openSqliteHandle(): DatabaseSync {
  if (
    globalDatabase.__lubanSqliteHandle &&
    globalDatabase.__lubanSimulatorSchemaVersion === SCHEMA_VERSION
  ) {
    return globalDatabase.__lubanSqliteHandle;
  }

  if (globalDatabase.__lubanSqliteHandle) {
    createSqliteSchema(globalDatabase.__lubanSqliteHandle);
    globalDatabase.__lubanSimulatorSchemaVersion = SCHEMA_VERSION;
    return globalDatabase.__lubanSqliteHandle;
  }

  const databasePath = process.env.LUBAN_DATABASE_PATH ?? DEFAULT_DATABASE_PATH;

  if (databasePath !== ":memory:") {
    mkdirSync(dirname(databasePath), { recursive: true });
  }

  const database = new DatabaseSync(databasePath);
  database.exec("PRAGMA foreign_keys = ON;");
  database.exec("PRAGMA busy_timeout = 5000;");
  database.exec("PRAGMA journal_mode = WAL;");
  createSqliteSchema(database);
  globalDatabase.__lubanSqliteHandle = database;
  globalDatabase.__lubanSimulatorSchemaVersion = SCHEMA_VERSION;

  return database;
}

function createSqliteSchema(database: DatabaseSync): void {
  database.exec(SQLITE_SCHEMA_SQL);
  ensureOrderReceiptColumns(database);
  ensureInstrumentRefreshColumn(database);
  ensureInstrumentAssetColumns(database);
  ensureInstrumentIndustryColumn(database);
  ensureAccountColumns(database);
  ensureDeletedStatus(database);
  ensureAdminSandboxOwnerColumn(database);
  ensureInvitationOperatorColumn(database);
  ensureAdminValuationColumns(database);
  backfillAdminValuationAccountsSqlite(database);
  ensureSignedBalances(database);
}

/** v19 lifts the sign checks that short selling (and the debt it can leave) breaks. */
const SIGNED_TABLES = ["teams", "holdings", "orders", "portfolio_snapshots"] as const;
const SIGN_CHECK =
  /CHECK \((?:cash_cents|quantity|cash_after_cents|holding_quantity_after|total_value_cents) >= 0\)/;

/**
 * Schema v19: cash, holdings, and portfolio value can go below zero. SQLite
 * cannot drop a CHECK constraint, so a pre-v19 table is rebuilt from its
 * current definition, the way ensureDeletedStatus rebuilds users.
 */
function ensureSignedBalances(database: DatabaseSync): void {
  const stale = SIGNED_TABLES.filter((name) => {
    const table = database
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(name) as { sql: string } | undefined;
    return table !== undefined && SIGN_CHECK.test(table.sql);
  });
  if (stale.length === 0) return;

  database.exec("PRAGMA foreign_keys = OFF;");
  try {
    database.exec("BEGIN IMMEDIATE;");
    for (const name of stale) {
      const rebuilt = `${name}_signed`;
      database.exec(`CREATE TABLE ${rebuilt} (${SHARED_TABLE_BODIES[name]("INTEGER")}\n    )`);
      const columnsOf = (table: string) =>
        (database.prepare(`PRAGMA table_info(${table})`).all() as unknown as Array<{ name: string }>)
          .map((column) => column.name);
      const kept = columnsOf(rebuilt).filter((column) => columnsOf(name).includes(column));
      database.exec(`
        INSERT INTO ${rebuilt} (${kept.join(", ")}) SELECT ${kept.join(", ")} FROM ${name};
        DROP TABLE ${name};
        ALTER TABLE ${rebuilt} RENAME TO ${name};
      `);
    }
    // Dropping the old tables took their indexes with them.
    database.exec(SQLITE_SCHEMA_SQL);
    database.exec(`${TEAMS_SANDBOX_OWNER_INDEX};`);
    database.exec("COMMIT;");
  } catch (error) {
    try {
      database.exec("ROLLBACK;");
    } catch {
      // Preserve the migration error below.
    }
    database.exec("PRAGMA foreign_keys = ON;");
    throw error;
  }
  database.exec("PRAGMA foreign_keys = ON;");
}

/**
 * Schema v7 widens users.status to allow 'deleted'. SQLite cannot alter a
 * CHECK constraint in place, so pre-v7 databases get the same rebuild
 * treatment as the v4 account migration.
 */
function ensureDeletedStatus(database: DatabaseSync): void {
  const table = database
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'users'")
    .get() as { sql: string } | undefined;

  if (!table || table.sql.includes("'deleted'")) {
    return;
  }

  database.exec("PRAGMA foreign_keys = OFF;");

  try {
    database.exec(`
      BEGIN IMMEDIATE;

      CREATE TABLE users_status_migrated (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT NOT NULL UNIQUE,
        role TEXT NOT NULL CHECK (role IN ('student', 'host', 'platform_admin')),
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'deleted')),
        auth_subject TEXT UNIQUE,
        email_verified_at TEXT,
        created_at TEXT NOT NULL,
        last_login_at TEXT
      );

      INSERT INTO users_status_migrated (
        id, name, email, role, status, auth_subject,
        email_verified_at, created_at, last_login_at
      )
      SELECT
        id, name, email, role, status, auth_subject,
        email_verified_at, created_at, last_login_at
      FROM users;

      DROP TABLE users;
      ALTER TABLE users_status_migrated RENAME TO users;

      COMMIT;
    `);
  } catch (error) {
    try {
      database.exec("ROLLBACK;");
    } catch {
      // Preserve the migration error below.
    }
    database.exec("PRAGMA foreign_keys = ON;");
    throw error;
  }

  database.exec("PRAGMA foreign_keys = ON;");
}

const SHARED_TABLE_BODIES = {
  users: () => `
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      role TEXT NOT NULL CHECK (role IN ('student', 'host', 'platform_admin')),
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'deleted')),
      auth_subject TEXT UNIQUE,
      email_verified_at TEXT,
      created_at TEXT NOT NULL,
      last_login_at TEXT`,
  competitions: (big: string) => `
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('draft', 'active', 'paused', 'ended')),
      base_currency TEXT NOT NULL DEFAULT 'CAD' CHECK (base_currency = 'CAD'),
      starting_cash_cents ${big} NOT NULL CHECK (starting_cash_cents >= 0),
      starts_at TEXT NOT NULL,
      ends_at TEXT NOT NULL,
      created_at TEXT NOT NULL`,
  teams: (big: string) => `
      id TEXT PRIMARY KEY,
      competition_id TEXT NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
      sandbox_owner_user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('active', 'frozen', 'disqualified')),
      cash_cents ${big} NOT NULL,
      version ${big} NOT NULL DEFAULT 0 CHECK (version >= 0),
      created_at TEXT NOT NULL,
      UNIQUE (competition_id, name)`,
  team_members: () => `
      team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      is_captain INTEGER NOT NULL DEFAULT 0 CHECK (is_captain IN (0, 1)),
      joined_at TEXT NOT NULL,
      PRIMARY KEY (team_id, user_id),
      UNIQUE (user_id)`,
  instruments: (big: string) => `
      symbol TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      exchange TEXT NOT NULL,
      sector TEXT NOT NULL,
      ${INSTRUMENT_INDUSTRY_COLUMN},
      listing_currency TEXT NOT NULL CHECK (listing_currency IN ('CAD', 'USD')),
      base_price_cents ${big} NOT NULL CHECK (base_price_cents > 0),
      previous_close_cents ${big} NOT NULL CHECK (previous_close_cents > 0),
      fx_rate_basis_points ${big} NOT NULL CHECK (fx_rate_basis_points > 0),
      is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
      auto_refresh INTEGER NOT NULL DEFAULT 1 CHECK (auto_refresh IN (0, 1)),
      ${instrumentAssetColumns(big)}`,
  holdings: (big: string) => `
      team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      symbol TEXT NOT NULL REFERENCES instruments(symbol),
      quantity ${big} NOT NULL,
      average_cost_cents ${big} NOT NULL CHECK (average_cost_cents >= 0),
      updated_at TEXT NOT NULL,
      PRIMARY KEY (team_id, symbol)`,
  orders: (big: string) => `
      id TEXT PRIMARY KEY,
      idempotency_key TEXT NOT NULL UNIQUE,
      request_fingerprint TEXT NOT NULL,
      team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      actor_user_id TEXT NOT NULL REFERENCES users(id),
      symbol TEXT NOT NULL REFERENCES instruments(symbol),
      side TEXT NOT NULL CHECK (side IN ('BUY', 'SELL')),
      quantity ${big} NOT NULL CHECK (quantity > 0),
      fill_price_cents ${big} NOT NULL CHECK (fill_price_cents > 0),
      fill_price_cad_cents ${big} NOT NULL CHECK (fill_price_cad_cents > 0),
      gross_cents ${big} NOT NULL CHECK (gross_cents > 0),
      cash_after_cents ${big} NOT NULL,
      holding_quantity_after ${big} NOT NULL,
      portfolio_version ${big} NOT NULL CHECK (portfolio_version >= 0),
      status TEXT NOT NULL CHECK (status IN ('FILLED', 'REJECTED')),
      created_at TEXT NOT NULL`,
  // Rejected orders kept past the idempotency window (retention prunes
  // idempotency_records after 7 days). Symbol, side, and quantity are the
  // requested values; nothing filled.
  order_rejections: (big: string) => `
      id TEXT PRIMARY KEY,
      team_id TEXT REFERENCES teams(id) ON DELETE CASCADE,
      actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      symbol TEXT,
      side TEXT,
      quantity ${big},
      error_code TEXT NOT NULL,
      message TEXT NOT NULL,
      created_at TEXT NOT NULL`,
  idempotency_records: () => `
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
      )`,
  ledger_entries: (big: string) => `
      id TEXT PRIMARY KEY,
      team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      order_id TEXT REFERENCES orders(id) ON DELETE SET NULL,
      entry_type TEXT NOT NULL CHECK (entry_type IN ('STARTING_CASH', 'BUY', 'SELL', 'ADJUSTMENT')),
      amount_cents ${big} NOT NULL,
      symbol TEXT REFERENCES instruments(symbol),
      quantity ${big},
      note TEXT NOT NULL,
      created_at TEXT NOT NULL`,
  activity_events: () => `
      id TEXT PRIMARY KEY,
      competition_id TEXT NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
      team_id TEXT REFERENCES teams(id) ON DELETE CASCADE,
      actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      detail TEXT NOT NULL,
      created_at TEXT NOT NULL`,
  portfolio_snapshots: (big: string) => `
      id TEXT PRIMARY KEY,
      team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      total_value_cents ${big} NOT NULL,
      captured_at TEXT NOT NULL`,
  sessions: () => `
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      revoked_at TEXT`,
  account_invitations: () => `
      id TEXT PRIMARY KEY,
      token_hash TEXT NOT NULL UNIQUE,
      role TEXT NOT NULL CHECK (role IN ('student', 'host', 'platform_admin')),
      email TEXT,
      invited_name TEXT,
      team_id TEXT REFERENCES teams(id) ON DELETE CASCADE,
      competition_id TEXT REFERENCES competitions(id) ON DELETE CASCADE,
      created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      issued_by_operator INTEGER NOT NULL DEFAULT 0 CHECK (issued_by_operator IN (0, 1)),
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      revoked_at TEXT,
      used_at TEXT,
      used_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      CHECK ((role = 'student') = (team_id IS NOT NULL))`,
  auth_audit_events: () => `
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      subject_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      detail TEXT NOT NULL,
      metadata_json TEXT,
      created_at TEXT NOT NULL`,
  admin_valuation_accounts: (big: string) => `
      admin_user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      starting_cash_cents ${big} NOT NULL CHECK (starting_cash_cents >= 0),
      version ${big} NOT NULL DEFAULT 0 CHECK (version >= 0),
      updated_at TEXT NOT NULL`,
  admin_valuation_positions: (big: string) => `
      id TEXT PRIMARY KEY,
      admin_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      idempotency_key TEXT NOT NULL,
      request_fingerprint TEXT NOT NULL,
      symbol TEXT NOT NULL REFERENCES instruments(symbol),
      requested_date TEXT NOT NULL,
      session_date TEXT NOT NULL,
      session_at TEXT NOT NULL,
      quantity ${big} NOT NULL CHECK (quantity > 0),
      fill_price_cents ${big} NOT NULL CHECK (fill_price_cents > 0),
      fill_price_cad_cents ${big} NOT NULL CHECK (fill_price_cad_cents > 0),
      historical_fx_rate_basis_points ${big} NOT NULL
        CHECK (historical_fx_rate_basis_points > 0),
      split_multiplier_ppm ${big} NOT NULL CHECK (split_multiplier_ppm > 0),
      split_checked_at TEXT NOT NULL,
      source TEXT NOT NULL CHECK (source IN ('YAHOO_FINANCE', 'LUBAN_SIMULATED')),
      source_url TEXT,
      created_at TEXT NOT NULL,
      UNIQUE (admin_user_id, idempotency_key)`,
  // Limit, stop-loss, and take-profit orders waiting for their price. They
  // never move money themselves: when one triggers it is filled through the
  // same code as a market order, which writes the normal order and ledger
  // rows. Buys set cash aside (reserved_cash_cents) and sells set shares
  // aside, by subtraction at check time; the ledger is untouched until a fill.
  working_orders: (big: string) => `
      id TEXT PRIMARY KEY,
      team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      actor_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      idempotency_key TEXT NOT NULL,
      symbol TEXT NOT NULL REFERENCES instruments(symbol),
      side TEXT NOT NULL CHECK (side IN ('BUY', 'SELL')),
      order_type TEXT NOT NULL CHECK (order_type IN ('LIMIT', 'STOP_LOSS', 'TAKE_PROFIT')),
      quantity ${big} NOT NULL CHECK (quantity > 0),
      trigger_price_cents ${big} NOT NULL CHECK (trigger_price_cents > 0),
      reserved_cash_cents ${big} NOT NULL DEFAULT 0 CHECK (reserved_cash_cents >= 0),
      time_in_force TEXT NOT NULL CHECK (time_in_force IN ('DAY', 'GTC')),
      expires_at TEXT,
      status TEXT NOT NULL
        CHECK (status IN ('PENDING_PARENT', 'WORKING', 'FILLED', 'CANCELLED', 'EXPIRED')),
      status_reason TEXT,
      parent_id TEXT REFERENCES working_orders(id) ON DELETE SET NULL,
      oco_group_id TEXT,
      filled_order_id TEXT REFERENCES orders(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (actor_user_id, idempotency_key)`,
  // What signed-in people tell us about the public website or this app. The
  // team is the sender's team when they sent it; removing that team later
  // only clears the link, so the message itself is kept.
  feedback: () => `
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      team_id TEXT REFERENCES teams(id) ON DELETE SET NULL,
      topic TEXT NOT NULL CHECK (topic IN ('WEBSITE', 'SIMULATOR')),
      message TEXT NOT NULL CHECK (length(message) BETWEEN 1 AND 2000),
      source TEXT NOT NULL CHECK (source IN ('header', 'page')),
      created_at TEXT NOT NULL`,
  // Symbols a team (or an admin's test portfolio) keeps an eye on. Shared by
  // every teammate; it never moves money, so it has no ledger rows.
  watchlist_items: () => `
      team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      symbol TEXT NOT NULL REFERENCES instruments(symbol) ON DELETE CASCADE,
      added_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (team_id, symbol)`,
  // Market data shared by every server instance: the latest quote and recent
  // chart history per symbol, as fetched JSON. A cache only; losing it costs
  // one upstream fetch per entry.
  market_cache: () => `
      cache_key TEXT PRIMARY KEY,
      payload TEXT NOT NULL,
      fetched_at_ms BIGINT NOT NULL`,
  // Emails that may claim a pre-loaded account on first sign-in: its main
  // address plus any alternates (a school email next to a personal one).
  // The rows go away once the account is claimed.
  account_claims: () => `
      email TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL`,
  // Accounts whose display name is still a placeholder ("User 1"). The row
  // goes away once the person saves a name.
  pending_display_names: () => `
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL`,
  // The host's current notice to everyone; one per competition, deleted to clear.
  announcements: () => `
      competition_id TEXT PRIMARY KEY REFERENCES competitions(id) ON DELETE CASCADE,
      title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 80),
      body TEXT NOT NULL CHECK (length(body) <= 500),
      tone TEXT NOT NULL CHECK (tone IN ('normal', 'urgent')),
      author_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL`,
} as const;

const WATCHLIST_INDEXES = [
  "CREATE INDEX IF NOT EXISTS idx_watchlist_team_created ON watchlist_items (team_id, created_at)",
];

const FEEDBACK_INDEXES = [
  "CREATE INDEX IF NOT EXISTS idx_feedback_created ON feedback (created_at DESC)",
  "CREATE INDEX IF NOT EXISTS idx_feedback_topic_created ON feedback (topic, created_at DESC)",
  "CREATE INDEX IF NOT EXISTS idx_feedback_user_created ON feedback (user_id, created_at)",
];

const SCHEMA_INDEXES = [
  "CREATE INDEX IF NOT EXISTS idx_activity_competition_created ON activity_events (competition_id, created_at DESC)",
  "CREATE INDEX IF NOT EXISTS idx_activity_team_created ON activity_events (team_id, created_at DESC)",
  "CREATE INDEX IF NOT EXISTS idx_orders_team_created ON orders (team_id, created_at DESC)",
  "CREATE INDEX IF NOT EXISTS idx_orders_created ON orders (created_at DESC)",
  "CREATE INDEX IF NOT EXISTS idx_order_rejections_created ON order_rejections (created_at DESC)",
  "CREATE INDEX IF NOT EXISTS idx_holdings_symbol_quantity ON holdings (symbol, quantity)",
  "CREATE INDEX IF NOT EXISTS idx_idempotency_order ON idempotency_records (order_id)",
  "CREATE INDEX IF NOT EXISTS idx_idempotency_actor_created ON idempotency_records (actor_user_id, created_at)",
  "CREATE INDEX IF NOT EXISTS idx_ledger_team ON ledger_entries (team_id)",
  "CREATE INDEX IF NOT EXISTS idx_ledger_order ON ledger_entries (order_id)",
  "CREATE INDEX IF NOT EXISTS idx_snapshots_team_captured ON portfolio_snapshots (team_id, captured_at ASC)",
  "CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id)",
  "CREATE INDEX IF NOT EXISTS idx_invitations_expires ON account_invitations (expires_at)",
  "CREATE INDEX IF NOT EXISTS idx_auth_audit_created ON auth_audit_events (created_at DESC)",
  "CREATE INDEX IF NOT EXISTS idx_admin_valuation_owner_created ON admin_valuation_positions (admin_user_id, created_at DESC)",
  "CREATE INDEX IF NOT EXISTS idx_instruments_auto_refresh ON instruments (auto_refresh, is_active)",
  "CREATE INDEX IF NOT EXISTS idx_working_orders_status_symbol ON working_orders (status, symbol)",
  "CREATE INDEX IF NOT EXISTS idx_working_orders_team_status ON working_orders (team_id, status)",
  "CREATE INDEX IF NOT EXISTS idx_working_orders_actor_created ON working_orders (actor_user_id, created_at)",
  ...FEEDBACK_INDEXES,
  ...WATCHLIST_INDEXES,
];

const TEAMS_SANDBOX_OWNER_INDEX = `
  CREATE UNIQUE INDEX IF NOT EXISTS idx_teams_sandbox_owner
  ON teams (sandbox_owner_user_id)
  WHERE sandbox_owner_user_id IS NOT NULL`;

function schemaStatements(engine: DatabaseEngine): string[] {
  // SQLite's INTEGER is 64-bit; PostgreSQL needs explicit BIGINT for cents.
  const big = engine === "postgres" ? "BIGINT" : "INTEGER";
  const tables = Object.entries(SHARED_TABLE_BODIES).map(
    ([name, body]) => `CREATE TABLE IF NOT EXISTS ${name} (${body(big)}\n    )`,
  );

  const statements = [...tables, ...SCHEMA_INDEXES];

  if (engine === "postgres") {
    statements.push(TEAMS_SANDBOX_OWNER_INDEX);
    // The server connects as the table owner; browsers must never reach these
    // tables through Supabase's anon/authenticated roles. RLS with no
    // policies makes that explicit.
    for (const name of Object.keys(SHARED_TABLE_BODIES)) {
      statements.push(`ALTER TABLE ${name} ENABLE ROW LEVEL SECURITY`);
    }
  }

  return statements;
}

const SQLITE_SCHEMA_SQL = `${schemaStatements("sqlite").join(";\n")};`;

/* ───────────────────── PostgreSQL driver + bootstrap ───────────────── */

function requirePostgresUrl(): string {
  const raw = (
    process.env.LUBAN_DATABASE_URL ??
    process.env.POSTGRES_URL ??
    process.env.DATABASE_URL
  )?.trim();

  if (!raw) {
    throw new AppError(
      "DATABASE_URL_REQUIRED",
      "LUBAN_DATABASE_PROVIDER=postgres requires LUBAN_DATABASE_URL (or POSTGRES_URL) to be set.",
      500,
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new AppError(
      "DATABASE_URL_INVALID",
      "The PostgreSQL connection string is not a valid URL.",
      500,
    );
  }

  if (
    (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") ||
    !parsed.hostname
  ) {
    throw new AppError(
      "DATABASE_URL_INVALID",
      "The PostgreSQL connection string must be a postgres:// URL.",
      500,
    );
  }

  return raw;
}

const DEFAULT_POSTGRES_POOL_MAX = 5;

/**
 * Connections per process. Dashboard reads and trades each hold a connection
 * for a whole transaction, so three was too few for a class polling at once.
 * Keep instances x this value within the pooler's client limit.
 */
function postgresPoolMax(): number {
  const raw = Number(process.env.LUBAN_DATABASE_POOL_MAX);

  if (Number.isSafeInteger(raw) && raw >= 1 && raw <= 50) {
    return raw;
  }

  return DEFAULT_POSTGRES_POOL_MAX;
}

function createPgPoolDriver(): PgDriver {
  // int8 and numeric arrive as strings by default; every value in this
  // schema fits safely in a JS number.
  pgTypes.setTypeParser(20, (value) => Number(value));
  pgTypes.setTypeParser(1700, (value) => Number(value));

  const pool = new Pool({
    ...postgresConnectionOptions(requirePostgresUrl()),
    max: postgresPoolMax(),
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 10_000,
  });

  // An idle client dropped by the server (pooler timeout, network blip)
  // emits 'error' on the pool; without a listener that event would crash the
  // whole process. The client is discarded and replaced automatically.
  pool.on("error", (error) => {
    console.error("PostgreSQL pool background error", error);
  });

  const query: PgQueryFn = async (sql, params = []) => {
    const result = await pool.query(sql, params as unknown[]);
    return { rows: result.rows, rowCount: result.rowCount ?? 0 };
  };

  return {
    query,
    exec: async (sql) => {
      await pool.query(sql);
    },
    withTransaction: async (fn) => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const clientQuery: PgQueryFn = async (sql, params = []) => {
          const result = await client.query(sql, params as unknown[]);
          return { rows: result.rows, rowCount: result.rowCount ?? 0 };
        };
        const value = await fn(clientQuery);
        await client.query("COMMIT");
        return value;
      } catch (error) {
        try {
          await client.query("ROLLBACK");
        } catch {
          // Preserve the original error.
        }
        throw error;
      } finally {
        client.release();
      }
    },
  };
}

/**
 * Creates tables and seeds the demo world if empty. Also the entry point for
 * the embedded-PostgreSQL test suite, so it must stay engine-generic and
 * idempotent. Cold starts racing each other serialize on the advisory lock.
 */
export async function initializeAppDatabaseSchema(app: AppDatabase): Promise<void> {
  await app.transaction(async (tx) => {
    await acquireAdvisoryLock(tx, ADVISORY_LOCK_SCHEMA);

    if (app.engine === "postgres") {
      // Re-running the DDL is idempotent but not free: each ENABLE ROW LEVEL
      // SECURITY takes a brief exclusive table lock, so cold starts skip the
      // whole pass once the schema exists. Keyed on the users table; changes
      // to an already-provisioned schema live in runPostgresMigrations.
      const provisioned = await tx.get<{ present: number }>(
        `SELECT 1 AS present
         FROM information_schema.tables
         WHERE table_schema = current_schema() AND table_name = 'users'`,
      );

      if (provisioned) {
        await runPostgresMigrations(tx);
        return;
      }
    }

    for (const statement of schemaStatements(app.engine)) {
      await tx.run(statement);
    }
  });

  await seedIfEmpty(app);
  await syncLocalDemoAdmin(app);
}

/**
 * Asset-class columns on instruments. A crypto instrument's prices and
 * quantities are per lot of 10^lot_exponent tokens, fixed when it is first
 * listed. last_price_* is the last good per-lot price, used to keep valuing
 * holdings when a live quote cannot be produced.
 */
function instrumentAssetColumnList(big: string): string[] {
  return [
    "asset_class TEXT NOT NULL DEFAULT 'STOCK' CHECK (asset_class IN ('STOCK', 'ETF', 'CRYPTO'))",
    "lot_exponent INTEGER NOT NULL DEFAULT 0 CHECK (lot_exponent BETWEEN -12 AND 15)",
    `last_price_cents ${big} CHECK (last_price_cents IS NULL OR last_price_cents > 0)`,
    "last_priced_at TEXT",
  ];
}

function instrumentAssetColumns(big: string): string {
  return instrumentAssetColumnList(big).join(",\n      ");
}
/**
 * Idempotent migrations applied to an already-provisioned PostgreSQL schema on
 * every cold start (fresh databases get the current DDL directly). The catalog
 * is read once and DDL runs only for what is missing, because even a no-op
 * ALTER TABLE or CREATE INDEX IF NOT EXISTS locks its table behind live trades.
 */
export async function runPostgresMigrations(tx: DbExecutor): Promise<void> {
  // Tables and indexes share one namespace, so one map answers both "exists?"
  // and a table's row-level-security flag.
  const relations = new Map(
    (
      await tx.all<{ name: string; rls: boolean }>(
        `SELECT c.relname AS name, c.relrowsecurity AS rls
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = current_schema()`,
      )
    ).map((row) => [row.name, row.rls] as const),
  );
  const columns = new Set(
    (
      await tx.all<{ name: string }>(
        `SELECT table_name || '.' || column_name AS name
         FROM information_schema.columns WHERE table_schema = current_schema()`,
      )
    ).map((row) => row.name),
  );

  // Tables added after v1: valuation lab (v8), working orders (v12), feedback
  // (v14), watchlists (v15), market cache (v16), claims (v17), announcements (v18),
  // order rejections (v20).
  const backfillValuationAccounts = !relations.has("admin_valuation_accounts");
  for (const [name, body] of Object.entries(SHARED_TABLE_BODIES)) {
    if (!relations.has(name)) {
      await tx.run(`CREATE TABLE IF NOT EXISTS ${name} (${body("BIGINT")}\n    )`);
      relations.set(name, false);
    }
  }

  // Positions bought before the lab had cash accounts fund one account each.
  if (backfillValuationAccounts) {
    await tx.run(
      `INSERT INTO admin_valuation_accounts (
         admin_user_id, starting_cash_cents, version, updated_at
       )
       SELECT
         admin_user_id,
         SUM(fill_price_cad_cents * quantity),
         0,
         ?
       FROM admin_valuation_positions
       GROUP BY admin_user_id
       ON CONFLICT (admin_user_id) DO NOTHING`,
      [new Date().toISOString()],
    );
  }

  // Columns added after v1; existing rows take the defaults.
  const addedColumns: [table: string, definition: string][] = [
    ["admin_valuation_positions", "split_checked_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z'"], // v8
    // v9: a platform administrator's private simulator account, kept out of every competition surface.
    ["teams", "sandbox_owner_user_id TEXT REFERENCES users(id) ON DELETE CASCADE"],
    // v10: only the bootstrap script may issue creatorless invitations, so old rows fail closed.
    ["account_invitations", "issued_by_operator INTEGER NOT NULL DEFAULT 0 CHECK (issued_by_operator IN (0, 1))"],
    // v11: ETFs and lot-based crypto; every existing instrument is a stock priced per share.
    ...instrumentAssetColumnList("BIGINT").map((column): [string, string] => ["instruments", column]),
    ["instruments", INSTRUMENT_INDUSTRY_COLUMN], // v13: "Other" until the next lookup
  ];
  for (const [table, definition] of addedColumns) {
    if (!columns.has(`${table}.${definition.split(" ", 1)[0]}`)) {
      await tx.run(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${definition}`);
    }
  }

  for (const statement of [...SCHEMA_INDEXES, TEAMS_SANDBOX_OWNER_INDEX]) {
    if (!relations.has(/INDEX IF NOT EXISTS (\w+)/.exec(statement)![1])) {
      await tx.run(statement);
    }
  }

  // Row-level security with no policies keeps Supabase's anon role out of every
  // table. Also repairs tables an earlier migration created without it.
  for (const name of Object.keys(SHARED_TABLE_BODIES)) {
    if (!relations.get(name)) {
      await tx.run(`ALTER TABLE ${name} ENABLE ROW LEVEL SECURITY`);
    }
  }

  // v7: users.status gains 'deleted'. PostgreSQL names the inline column
  // check users_status_check; swap it only when it predates the new value.
  const statusCheck = await tx.get<{ def: string }>(
    `SELECT pg_get_constraintdef(oid) AS def
     FROM pg_constraint
     WHERE conrelid = 'users'::regclass AND conname = 'users_status_check'`,
  );

  // v19: short selling lets cash, holdings, and portfolio value go below zero.
  // Dropped only when present, so a migrated database takes no table lock.
  const signChecks = await tx.all<{ table_name: string; name: string }>(
    `SELECT conrelid::regclass::text AS table_name, conname AS name
     FROM pg_constraint
     WHERE conname IN (
       'teams_cash_cents_check', 'holdings_quantity_check',
       'orders_cash_after_cents_check', 'orders_holding_quantity_after_check',
       'portfolio_snapshots_total_value_cents_check'
     ) AND connamespace = current_schema()::regnamespace`,
  );
  for (const check of signChecks) {
    await tx.run(`ALTER TABLE ${check.table_name} DROP CONSTRAINT IF EXISTS ${check.name}`);
  }

  if (!statusCheck || !statusCheck.def.includes("'deleted'")) {
    await tx.run("ALTER TABLE users DROP CONSTRAINT IF EXISTS users_status_check");
    await tx.run(
      "ALTER TABLE users ADD CONSTRAINT users_status_check CHECK (status IN ('active', 'suspended', 'deleted'))",
    );
  }
}

/* ───────────────────────── Seed and reset (shared) ─────────────────── */

function isoDaysFrom(reference: Date, days: number, hours = 0): string {
  return new Date(
    reference.getTime() + days * 86_400_000 + hours * 3_600_000,
  ).toISOString();
}

async function seedIfEmpty(app: AppDatabase): Promise<void> {
  await app.transaction(async (tx) => {
    await acquireAdvisoryLock(tx, ADVISORY_LOCK_SCHEMA);
    const row = await tx.get<{ count: number }>(
      "SELECT COUNT(*) AS count FROM users",
    );

    if (!row || Number(row.count) === 0) {
      await runSeed(tx, false);
    }
  });
}

async function syncLocalDemoAdmin(app: AppDatabase): Promise<void> {
  // Never on a Vercel deployment, whatever the demo flags say.
  const demoAdminEnabled =
    process.env.LUBAN_AUTH_MODE !== "managed" &&
    process.env.VERCEL !== "1" &&
    (process.env.NODE_ENV === "development" ||
      process.env.LUBAN_DEMO_MODE === "true");

  if (demoAdminEnabled) {
    await app.run(
      `INSERT INTO users (id, name, email, role, status, created_at)
       VALUES ('admin', 'Ada (Admin)', 'admin@demo.luban.org',
         'platform_admin', 'active', ?)
       ON CONFLICT(id) DO NOTHING`,
      [new Date().toISOString()],
    );
    return;
  }

  // Never let the browser-test identity occupy the first real administrator
  // slot in managed auth. The exact predicates avoid touching a genuine
  // linked account that happens to use a similar display name.
  await app.run(
    `DELETE FROM users
     WHERE id = 'admin'
       AND email = 'admin@demo.luban.org'
       AND auth_subject IS NULL`,
  );
}

async function clearDomainData(
  tx: DbExecutor,
  preserveSessions: boolean,
): Promise<void> {
  if (!preserveSessions) {
    await tx.run("DELETE FROM sessions");
  }

  const tables = [
    "market_cache",
    "watchlist_items",
    "announcements",
    "working_orders",
    "admin_valuation_positions",
    "admin_valuation_accounts",
    "portfolio_snapshots",
    "activity_events",
    "ledger_entries",
    "idempotency_records",
    "order_rejections",
    "orders",
    "holdings",
    "account_invitations",
    "team_members",
    "teams",
    "competitions",
    "instruments",
  ];

  for (const table of tables) {
    await tx.run(`DELETE FROM ${table}`);
  }
}

async function runSeed(tx: DbExecutor, preserveSessions: boolean): Promise<void> {
  const now = new Date();
  const createdAt = isoDaysFrom(now, -7);

  await clearDomainData(tx, preserveSessions);

  const upsertUser = `
    INSERT INTO users (id, name, email, role, status, created_at)
    VALUES (?, ?, ?, ?, 'active', ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      email = excluded.email,
      role = excluded.role,
      status = 'active'
  `;
  await tx.run(upsertUser, ["alex", "Johnny", "alex@demo.luban.org", "student", createdAt]);
  await tx.run(upsertUser, ["maya", "Menon", "maya@demo.luban.org", "student", createdAt]);
  await tx.run(upsertUser, ["jordan", "Radin", "jordan@demo.luban.org", "student", createdAt]);
  await tx.run(upsertUser, ["host", "Joe (Host)", "host@demo.luban.org", "host", createdAt]);

  await tx.run(
    `INSERT INTO competitions (
       id, name, status, base_currency, starting_cash_cents,
       starts_at, ends_at, created_at
     ) VALUES (?, ?, ?, 'CAD', ?, ?, ?, ?)`,
    [
      "fall-2026",
      "Luban Fall Market Challenge",
      "active",
      10_000_000,
      isoDaysFrom(now, -4),
      isoDaysFrom(now, 25),
      createdAt,
    ],
  );

  const insertTeam = `
    INSERT INTO teams (
      id, competition_id, name, status, cash_cents, version, created_at
    ) VALUES (?, 'fall-2026', ?, 'active', ?, ?, ?)
  `;
  await tx.run(insertTeam, ["northstar", "Northstar Capital", 10_000_000, 0, createdAt]);
  await tx.run(insertTeam, ["maple-alpha", "Maple Alpha", 10_000_000, 0, createdAt]);
  await tx.run(insertTeam, ["aurora-fund", "Aurora Fund", 10_000_000, 0, createdAt]);
  await tx.run(insertTeam, ["cedar-street", "Cedar Street", 10_000_000, 0, createdAt]);

  const insertMember = `
    INSERT INTO team_members (team_id, user_id, is_captain, joined_at)
    VALUES ('northstar', ?, ?, ?)
  `;
  await tx.run(insertMember, ["alex", 1, isoDaysFrom(now, -6, 1)]);
  await tx.run(insertMember, ["maya", 0, isoDaysFrom(now, -6, 2)]);
  await tx.run(insertMember, ["jordan", 0, isoDaysFrom(now, -5, 3)]);

  // Industries use Yahoo's spelling so a later lookup doesn't regroup them.
  const insertInstrument = `
    INSERT INTO instruments (
      symbol, name, exchange, sector, industry, listing_currency,
      base_price_cents, previous_close_cents, fx_rate_basis_points,
      is_active, auto_refresh
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1)
  `;
  const instruments = [
    ["SHOP.TO", "Shopify Inc.", "TSX", "Technology", "Software—Application", "CAD", 15_840, 15_610, 10_000],
    ["RY.TO", "Royal Bank of Canada", "TSX", "Financials", "Banks—Diversified", "CAD", 21_765, 21_590, 10_000],
    ["TD.TO", "Toronto-Dominion Bank", "TSX", "Financials", "Banks—Diversified", "CAD", 11_520, 11_440, 10_000],
    ["ENB.TO", "Enbridge Inc.", "TSX", "Energy", "Oil & Gas Midstream", "CAD", 6_590, 6_625, 10_000],
    ["CNR.TO", "Canadian National Railway", "TSX", "Industrials", "Railroads", "CAD", 14_480, 14_390, 10_000],
    ["XEQT.TO", "iShares Core Equity ETF", "TSX", "ETF", "Global Equity", "CAD", 3_925, 3_901, 10_000],
    ["BNS.TO", "Bank of Nova Scotia", "TSX", "Financials", "Banks—Diversified", "CAD", 9_025, 8_970, 10_000],
    ["AAPL", "Apple Inc.", "NASDAQ", "Technology", "Consumer Electronics", "USD", 23_845, 23_610, 13_600],
    ["MSFT", "Microsoft Corporation", "NASDAQ", "Technology", "Software—Infrastructure", "USD", 51_020, 50_750, 13_600],
    ["NVDA", "NVIDIA Corporation", "NASDAQ", "Technology", "Semiconductors", "USD", 18_935, 18_620, 13_600],
  ];
  for (const instrument of instruments) {
    await tx.run(insertInstrument, instrument as unknown[]);
  }

  const insertLedger = `
    INSERT INTO ledger_entries (
      id, team_id, order_id, entry_type, amount_cents,
      symbol, quantity, note, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `;
  for (const teamId of ["northstar", "maple-alpha", "aurora-fund", "cedar-street"]) {
    await tx.run(insertLedger, [
      `seed-ledger-${teamId}`,
      teamId,
      null,
      "STARTING_CASH",
      10_000_000,
      null,
      null,
      "Competition starting balance",
      isoDaysFrom(now, -4),
    ]);
  }

  const insertActivity = `
    INSERT INTO activity_events (
      id, competition_id, team_id, actor_user_id, type,
      title, detail, created_at
    ) VALUES (?, 'fall-2026', ?, ?, ?, ?, ?, ?)
  `;
  await tx.run(insertActivity, [
    "activity-created",
    null,
    "host",
    "TEAM_CREATED",
    "Competition created",
    "Joe created the Luban Fall Market Challenge.",
    isoDaysFrom(now, -7),
  ]);
  await tx.run(insertActivity, [
    "activity-members",
    "northstar",
    "alex",
    "MEMBER_JOINED",
    "Northstar Capital is ready",
    "Johnny, Menon, and Radin joined the shared team portfolio.",
    isoDaysFrom(now, -5),
  ]);

  const insertSnapshot = `
    INSERT INTO portfolio_snapshots (id, team_id, total_value_cents, captured_at)
    VALUES (?, ?, ?, ?)
  `;
  for (let index = 0; index < 7; index += 1) {
    await tx.run(insertSnapshot, [
      `snapshot-northstar-${index}`,
      "northstar",
      10_000_000,
      isoDaysFrom(now, index - 6),
    ]);
  }

  await assertLedgerBalances(tx);
}

export async function resetPrototypeDatabase(): Promise<void> {
  const app = await getDb();

  if (app.engine === "sqlite" && globalDatabase.__lubanSqliteHandle) {
    createSqliteSchema(globalDatabase.__lubanSqliteHandle);
  }

  await app.transaction(async (tx) => {
    await acquireAdvisoryLock(tx, ADVISORY_LOCK_SCHEMA);
    await runSeed(tx, true);
  });
  await syncLocalDemoAdmin(app);
}

/* ───────────────────── Ledger reconciliation (shared) ──────────────── */

async function reconcileLedgerRows(
  executor: DbExecutor,
  teamIds?: readonly string[],
): Promise<LedgerReconciliation[]> {
  const scoped = teamIds !== undefined;
  const uniqueTeamIds = scoped ? [...new Set(teamIds)] : [];
  if (scoped && uniqueTeamIds.length === 0) return [];

  const where = scoped
    ? `WHERE t.id IN (${uniqueTeamIds.map(() => "?").join(", ")})`
    : "";
  const rows = await executor.all<{
    team_id: string;
    team_name: string;
    cash_cents: number;
    ledger_balance_cents: number;
  }>(
    `
    SELECT
      t.id AS team_id,
      t.name AS team_name,
      t.cash_cents,
      COALESCE(SUM(l.amount_cents), 0) AS ledger_balance_cents
    FROM teams t
    LEFT JOIN ledger_entries l ON l.team_id = t.id
    ${where}
    GROUP BY t.id, t.name, t.cash_cents
    ORDER BY t.name ASC
  `,
    uniqueTeamIds,
  );

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

async function assertLedgerBalances(
  executor: DbExecutor,
  teamIds?: readonly string[],
): Promise<LedgerReconciliation[]> {
  const report = await reconcileLedgerRows(executor, teamIds);
  const failures = report.filter((team) => !team.reconciled);

  if (failures.length > 0) {
    // The message carries no team data; `details` is server-side only because
    // handleRouteError logs 5xx details instead of returning them.
    throw new AppError(
      "LEDGER_OUT_OF_BALANCE",
      "Team cash does not reconcile to the ledger.",
      500,
      { teams: failures },
    );
  }

  return report;
}

/**
 * Full-platform report. Aggregates every team's ledger, so keep it to ops /
 * admin checks and seeding rather than per-request write paths.
 */
export async function reconcileLedgers(): Promise<LedgerReconciliation[]> {
  return reconcileLedgerRows(await getDb());
}

/**
 * Global check across every team. Inside a transaction pass that
 * transaction's executor; outside, omit it. Prefer
 * `assertTeamLedgerReconciles` on hot write paths.
 */
export async function assertLedgerReconciles(
  executor?: DbExecutor,
): Promise<LedgerReconciliation[]> {
  return assertLedgerBalances(executor ?? (await getDb()));
}

/**
 * Reconciles only the given teams, so one out-of-balance team cannot block
 * writes for everyone else and the cost scales with the touched ledgers only.
 * Inside a transaction pass its executor or rely on the ambient transaction.
 */
export async function assertTeamLedgerReconciles(
  teamIds: readonly string[],
  executor?: DbExecutor,
): Promise<LedgerReconciliation[]> {
  return assertLedgerBalances(executor ?? (await getDb()), teamIds);
}

export async function withReadTransaction<T>(
  work: (tx: DbExecutor) => Promise<T>,
): Promise<T> {
  const app = await getDb();
  return app.readTransaction(work);
}

/* ───────────── SQLite-only legacy column migrations (v3 → v6) ──────── */

function ensureAdminValuationColumns(database: DatabaseSync): void {
  const columns = database
    .prepare("PRAGMA table_info(admin_valuation_positions)")
    .all() as unknown as Array<{ name: string }>;

  if (!columns.some((column) => column.name === "split_checked_at")) {
    database.exec(`
      ALTER TABLE admin_valuation_positions
      ADD COLUMN split_checked_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z';
    `);
  }
}

/** Adds the v10 operator-issued invitation marker to an existing local database. */
function ensureInvitationOperatorColumn(database: DatabaseSync): void {
  const columns = database
    .prepare("PRAGMA table_info(account_invitations)")
    .all() as unknown as Array<{ name: string }>;

  if (!columns.some((column) => column.name === "issued_by_operator")) {
    database.exec(`
      ALTER TABLE account_invitations
      ADD COLUMN issued_by_operator INTEGER NOT NULL DEFAULT 0
        CHECK (issued_by_operator IN (0, 1));
    `);
  }
}

/** Adds the v9 private-admin ownership marker to an existing local database. */
function ensureAdminSandboxOwnerColumn(database: DatabaseSync): void {
  const columns = database.prepare("PRAGMA table_info(teams)").all() as unknown as Array<{
    name: string;
  }>;

  if (!columns.some((column) => column.name === "sandbox_owner_user_id")) {
    database.exec(`
      ALTER TABLE teams
      ADD COLUMN sandbox_owner_user_id TEXT
        REFERENCES users(id) ON DELETE CASCADE;
    `);
  }

  database.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_teams_sandbox_owner
    ON teams (sandbox_owner_user_id)
    WHERE sandbox_owner_user_id IS NOT NULL;
  `);
}

/**
 * v8 compatibility for local databases that already contain valuation-lab
 * purchases: funding them to their exact invested cost preserves every
 * existing position while leaving zero uncommitted cash.
 */
function backfillAdminValuationAccountsSqlite(database: DatabaseSync): void {
  database
    .prepare(
      `INSERT INTO admin_valuation_accounts (
         admin_user_id, starting_cash_cents, version, updated_at
       )
       SELECT
         admin_user_id,
         SUM(fill_price_cad_cents * quantity),
         0,
         ?
       FROM admin_valuation_positions
       GROUP BY admin_user_id
       ON CONFLICT (admin_user_id) DO NOTHING`,
    )
    .run(new Date().toISOString());
}

function usersTableNeedsAccountColumns(database: DatabaseSync): boolean {
  const columns = database.prepare("PRAGMA table_info(users)").all() as unknown as Array<{
    name: string;
  }>;

  return !columns.some((column) => column.name === "auth_subject");
}

/**
 * Databases created before schema version 4 have a users table without
 * account-status, managed-identity, or platform_admin support. SQLite cannot
 * widen a CHECK constraint in place, so the table is rebuilt and its rows
 * copied. Foreign keys are switched off only for the rebuild, exactly as the
 * SQLite ALTER TABLE documentation prescribes.
 */
function ensureAccountColumns(database: DatabaseSync): void {
  if (!usersTableNeedsAccountColumns(database)) {
    return;
  }

  database.exec("PRAGMA foreign_keys = OFF;");

  try {
    database.exec("BEGIN IMMEDIATE;");

    // Re-check now that the write lock is held: another process may have
    // completed the same rebuild between the first check and BEGIN IMMEDIATE.
    if (!usersTableNeedsAccountColumns(database)) {
      database.exec("COMMIT;");
      database.exec("PRAGMA foreign_keys = ON;");
      return;
    }

    database.exec(`
      CREATE TABLE users_migrated (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT NOT NULL UNIQUE,
        role TEXT NOT NULL CHECK (role IN ('student', 'host', 'platform_admin')),
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'deleted')),
        auth_subject TEXT UNIQUE,
        email_verified_at TEXT,
        created_at TEXT NOT NULL,
        last_login_at TEXT
      );

      INSERT INTO users_migrated (id, name, email, role, status, created_at)
      SELECT id, name, email, role, 'active', created_at FROM users;

      DROP TABLE users;
      ALTER TABLE users_migrated RENAME TO users;

      COMMIT;
    `);
  } catch (error) {
    try {
      database.exec("ROLLBACK;");
    } catch {
      // Preserve the migration error below.
    }
    database.exec("PRAGMA foreign_keys = ON;");
    throw error;
  }

  database.exec("PRAGMA foreign_keys = ON;");

  const violations = database.prepare("PRAGMA foreign_key_check").all();
  if (violations.length > 0) {
    throw new AppError(
      "MIGRATION_FOREIGN_KEY_VIOLATION",
      "The account schema migration left dangling foreign keys.",
      500,
      { violations: violations.length },
    );
  }
}

function ensureInstrumentAssetColumns(database: DatabaseSync): void {
  const columns = database.prepare("PRAGMA table_info(instruments)").all() as unknown as Array<{
    name: string;
  }>;

  for (const column of instrumentAssetColumnList("INTEGER")) {
    const name = column.split(" ", 1)[0];
    if (!columns.some((existing) => existing.name === name)) {
      database.exec(`ALTER TABLE instruments ADD COLUMN ${column};`);
    }
  }
}

/** v13: existing rows read "Other" until their next lookup. */
function ensureInstrumentIndustryColumn(database: DatabaseSync): void {
  const columns = database.prepare("PRAGMA table_info(instruments)").all() as unknown as Array<{
    name: string;
  }>;

  if (!columns.some((column) => column.name === "industry")) {
    database.exec(`ALTER TABLE instruments ADD COLUMN ${INSTRUMENT_INDUSTRY_COLUMN};`);
  }
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
