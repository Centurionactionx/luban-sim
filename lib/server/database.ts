import { AsyncLocalStorage } from "node:async_hooks";
import type { DatabaseSync } from "node:sqlite";

/**
 * Engine-neutral async database access.
 *
 * The domain layer speaks one dialect: `?` placeholders, ISO-8601 TEXT
 * timestamps (compared lexicographically), and 0/1 integer flags. The SQLite
 * adapter runs it natively; the PostgreSQL adapter rewrites placeholders to
 * $1..$n.
 *
 * Transactions are ambient: transaction(fn) runs fn inside BEGIN/COMMIT and
 * — through AsyncLocalStorage — every database call made anywhere in fn's
 * async call tree automatically executes inside that same transaction, on
 * that same connection. Domain helpers therefore compose freely, exactly as
 * they did when the engine was synchronous SQLite.
 */

export type DatabaseEngine = "sqlite" | "postgres";

export interface DbExecutor {
  readonly engine: DatabaseEngine;
  all<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  get<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<T | undefined>;
  run(sql: string, params?: unknown[]): Promise<{ changes: number }>;
  /** Multi-statement script without parameters (DDL, bulk deletes). */
  exec(sql: string): Promise<void>;
}

export interface AppDatabase extends DbExecutor {
  /** Serialized read-write transaction; rolls back on throw. A call made
      while a transaction is already ambient joins it instead of nesting. */
  transaction<T>(fn: (tx: DbExecutor) => Promise<T>): Promise<T>;
  /** Consistent-snapshot read; same joining rule. */
  readTransaction<T>(fn: (tx: DbExecutor) => Promise<T>): Promise<T>;
}

/* ────────────────────────────── SQLite ─────────────────────────────── */

/**
 * node:sqlite is synchronous over one shared connection, but async callers
 * interleave at await points. A promise-chain mutex serializes top-level
 * operations and whole transactions; calls inside an ambient transaction
 * bypass the queue and run inline on the connection the transaction holds.
 */
class SqliteAppDatabase implements AppDatabase {
  readonly engine = "sqlite" as const;
  private readonly ambientTransaction = new AsyncLocalStorage<DbExecutor>();
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly database: DatabaseSync) {}

  private enqueue<T>(work: () => T | Promise<T>): Promise<T> {
    const next = this.chain.then(work, work);
    this.chain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private makeExecutor(): DbExecutor {
    const database = this.database;
    return {
      engine: "sqlite",
      all: async <T>(sql: string, params: unknown[] = []) =>
        database.prepare(sql).all(...(params as never[])) as T[],
      get: async <T>(sql: string, params: unknown[] = []) =>
        (database.prepare(sql).get(...(params as never[])) as T | undefined) ??
        undefined,
      run: async (sql: string, params: unknown[] = []) => {
        const result = database.prepare(sql).run(...(params as never[]));
        return { changes: Number(result.changes) };
      },
      exec: async (sql: string) => {
        database.exec(sql);
      },
    };
  }

  private dispatch<T>(op: (executor: DbExecutor) => Promise<T>): Promise<T> {
    const ambient = this.ambientTransaction.getStore();

    if (ambient && ambient.engine === "sqlite") {
      return op(ambient);
    }

    return this.enqueue(() => op(this.makeExecutor()));
  }

  all<T>(sql: string, params?: unknown[]): Promise<T[]> {
    return this.dispatch((executor) => executor.all<T>(sql, params));
  }

  get<T>(sql: string, params?: unknown[]): Promise<T | undefined> {
    return this.dispatch((executor) => executor.get<T>(sql, params));
  }

  run(sql: string, params?: unknown[]): Promise<{ changes: number }> {
    return this.dispatch((executor) => executor.run(sql, params));
  }

  exec(sql: string): Promise<void> {
    return this.dispatch((executor) => executor.exec(sql));
  }

  private runTransaction<T>(
    begin: string,
    fn: (tx: DbExecutor) => Promise<T>,
  ): Promise<T> {
    const ambient = this.ambientTransaction.getStore();

    if (ambient && ambient.engine === "sqlite") {
      return fn(ambient);
    }

    return this.enqueue(async () => {
      const executor = this.makeExecutor();
      this.database.exec(begin);
      try {
        const result = await this.ambientTransaction.run(executor, () => fn(executor));
        this.database.exec("COMMIT;");
        return result;
      } catch (error) {
        try {
          this.database.exec("ROLLBACK;");
        } catch {
          // Preserve the original error.
        }
        throw error;
      }
    });
  }

  transaction<T>(fn: (tx: DbExecutor) => Promise<T>): Promise<T> {
    return this.runTransaction("BEGIN IMMEDIATE;", fn);
  }

  readTransaction<T>(fn: (tx: DbExecutor) => Promise<T>): Promise<T> {
    return this.runTransaction("BEGIN;", fn);
  }
}

export function createSqliteAppDatabase(database: DatabaseSync): AppDatabase {
  return new SqliteAppDatabase(database);
}

/* ───────────────────────────── PostgreSQL ──────────────────────────── */

export interface PgQueryResult {
  rows: Record<string, unknown>[];
  rowCount: number;
}

export type PgQueryFn = (
  sql: string,
  params?: unknown[],
) => Promise<PgQueryResult>;

/**
 * Minimal seam over a PostgreSQL driver so production (node-postgres Pool)
 * and tests (embedded PGlite) share the exact same adapter code paths.
 */
export interface PgDriver {
  query: PgQueryFn;
  /** Runs fn with all queries bound to one connection inside BEGIN/COMMIT. */
  withTransaction<T>(fn: (query: PgQueryFn) => Promise<T>): Promise<T>;
  exec(sql: string): Promise<void>;
}

/** Rewrites `?` placeholders to $1..$n outside single-quoted literals. */
export function toPostgresPlaceholders(sql: string): string {
  let output = "";
  let index = 0;
  let inString = false;

  for (const char of sql) {
    if (char === "'") {
      inString = !inString;
      output += char;
      continue;
    }
    if (char === "?" && !inString) {
      index += 1;
      output += `$${index}`;
      continue;
    }
    output += char;
  }

  return output;
}

// First statement of every transaction, so a stuck lock or runaway query frees
// its pooled connection with an error instead of holding it. Transaction-local,
// hence safe through the transaction pooler. 10 s of lock wait outlasts another
// instance's cold-start migration; 20 s per statement is far above any normal query.
// shortcut: statements outside a transaction are uncapped, cap them at the pool if that bites.
const TRANSACTION_TIMEOUTS_SQL =
  "SELECT set_config('lock_timeout', '10s', true), set_config('statement_timeout', '20s', true)";

function pgExecutor(query: PgQueryFn): DbExecutor {
  return {
    engine: "postgres",
    all: async <T>(sql: string, params: unknown[] = []) =>
      (await query(toPostgresPlaceholders(sql), params)).rows as T[],
    get: async <T>(sql: string, params: unknown[] = []) =>
      ((await query(toPostgresPlaceholders(sql), params)).rows[0] as T) ??
      undefined,
    run: async (sql: string, params: unknown[] = []) => ({
      changes: (await query(toPostgresPlaceholders(sql), params)).rowCount,
    }),
    exec: async (sql: string) => {
      await query(sql);
    },
  };
}

class PostgresAppDatabase implements AppDatabase {
  readonly engine = "postgres" as const;
  private readonly ambientTransaction = new AsyncLocalStorage<DbExecutor>();
  private readonly base: DbExecutor;

  constructor(private readonly driver: PgDriver) {
    this.base = pgExecutor(driver.query);
  }

  private current(): DbExecutor {
    const ambient = this.ambientTransaction.getStore();
    return ambient && ambient.engine === "postgres" ? ambient : this.base;
  }

  all<T>(sql: string, params?: unknown[]): Promise<T[]> {
    return this.current().all<T>(sql, params);
  }

  get<T>(sql: string, params?: unknown[]): Promise<T | undefined> {
    return this.current().get<T>(sql, params);
  }

  run(sql: string, params?: unknown[]): Promise<{ changes: number }> {
    return this.current().run(sql, params);
  }

  exec(sql: string): Promise<void> {
    const ambient = this.ambientTransaction.getStore();
    if (ambient && ambient.engine === "postgres") {
      return ambient.exec(sql);
    }
    return this.driver.exec(sql);
  }

  transaction<T>(fn: (tx: DbExecutor) => Promise<T>): Promise<T> {
    const ambient = this.ambientTransaction.getStore();

    if (ambient && ambient.engine === "postgres") {
      return fn(ambient);
    }

    return this.driver.withTransaction(async (query) => {
      await query(TRANSACTION_TIMEOUTS_SQL);
      const executor = pgExecutor(query);
      return this.ambientTransaction.run(executor, () => fn(executor));
    });
  }

  readTransaction<T>(fn: (tx: DbExecutor) => Promise<T>): Promise<T> {
    const ambient = this.ambientTransaction.getStore();

    if (ambient && ambient.engine === "postgres") {
      return fn(ambient);
    }

    // REPEATABLE READ gives every statement in the read the same snapshot,
    // matching SQLite's behavior and the interface contract — a dashboard
    // never mixes pre-trade cash with post-trade holdings. The isolation level
    // must precede any query, so the timeouts follow it.
    return this.driver.withTransaction(async (query) => {
      await query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
      await query(TRANSACTION_TIMEOUTS_SQL);
      const executor = pgExecutor(query);
      return this.ambientTransaction.run(executor, () => fn(executor));
    });
  }
}

export function createPostgresAppDatabase(driver: PgDriver): AppDatabase {
  return new PostgresAppDatabase(driver);
}

/* ─────────────────────────── Advisory locks ────────────────────────── */

/**
 * Serializes rare cross-row invariants (first-admin bootstrap, starting-cash
 * reset, schema bootstrap). SQLite needs nothing: its transactions are fully
 * serialized already. On PostgreSQL the lock is transaction-scoped and
 * released automatically at commit/rollback.
 */
export const ADVISORY_LOCK_ACCOUNTS = 823_651;
export const ADVISORY_LOCK_SCHEMA = 823_652;

/** Orders may run together, while account and competition administration waits. */
export async function acquireAccountReadLock(tx: DbExecutor): Promise<void> {
  if (tx.engine === "postgres") {
    await tx.all("SELECT pg_advisory_xact_lock_shared(?)", [ADVISORY_LOCK_ACCOUNTS]);
  }
}

export async function acquireAdvisoryLock(
  tx: DbExecutor,
  key: number,
): Promise<void> {
  if (tx.engine !== "postgres") {
    return;
  }

  await tx.all("SELECT pg_advisory_xact_lock(?)", [key]);
}
