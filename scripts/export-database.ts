/**
 * Read-only JSON export of every application table in the PostgreSQL
 * database. Run it before any production change:
 *
 *   pnpm backup:db
 *
 * It loads .env* files the same way the app does (via @next/env), connects
 * with the app's own TLS rules, reads all tables inside one READ ONLY
 * snapshot, and writes backups/luban-db-<timestamp>.json. It never writes to
 * the database. The file holds personal data (names, emails): keep it private.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { loadEnvConfig } from "@next/env";
import { Client } from "pg";

import { postgresConnectionOptions } from "../lib/server/postgres-config";

/**
 * Tables from SHARED_TABLE_BODIES in lib/server/db.ts. Any other table found
 * in the schema is exported too, with a warning, so a new table added later
 * is never silently skipped.
 */
export const APPLICATION_TABLES = [
  "users",
  "competitions",
  "teams",
  "team_members",
  "instruments",
  "holdings",
  "orders",
  "idempotency_records",
  "ledger_entries",
  "activity_events",
  "portfolio_snapshots",
  "sessions",
  "account_invitations",
  "auth_audit_events",
  "admin_valuation_accounts",
  "admin_valuation_positions",
  "working_orders",
  "feedback",
  "watchlist_items",
  "market_cache",
] as const;

type Query = (sql: string) => Promise<{ rows: Record<string, unknown>[] }>;

export interface DatabaseExport {
  format: "luban-db-export/1";
  exportedAt: string;
  tables: Record<string, { rowCount: number; rows: Record<string, unknown>[] }>;
  missingTables: string[];
  unlistedTables: string[];
}

function quoteIdentifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/** Reads every table inside a single read-only snapshot, then rolls back. */
export async function exportTables(query: Query): Promise<DatabaseExport> {
  try {
    await query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const present = (
      await query(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'
         ORDER BY table_name`,
      )
    ).rows.map((row) => String(row.table_name));

    const listed: readonly string[] = APPLICATION_TABLES;
    const missingTables = listed.filter((name) => !present.includes(name));
    const unlistedTables = present.filter((name) => !listed.includes(name));
    const tables: DatabaseExport["tables"] = {};

    for (const name of [...listed.filter((n) => present.includes(n)), ...unlistedTables]) {
      const { rows } = await query(`SELECT * FROM ${quoteIdentifier(name)}`);
      tables[name] = { rowCount: rows.length, rows };
    }

    return {
      format: "luban-db-export/1",
      exportedAt: new Date().toISOString(),
      tables,
      missingTables,
      unlistedTables,
    };
  } finally {
    await query("ROLLBACK");
  }
}

/** BIGINT columns arrive as strings from pg; keep them lossless. */
function toJson(value: unknown): string {
  return JSON.stringify(
    value,
    (_key, item) => (typeof item === "bigint" ? item.toString() : item),
    2,
  );
}

async function main(): Promise<void> {
  loadEnvConfig(process.cwd());

  if (process.env.LUBAN_DATABASE_PROVIDER !== "postgres") {
    console.error(
      "This backup only reads a PostgreSQL database. Set LUBAN_DATABASE_PROVIDER=postgres " +
        "and LUBAN_DATABASE_URL (or POSTGRES_URL) to the database you want to back up, " +
        "for example in .env.local or for this one command.",
    );
    process.exitCode = 1;
    return;
  }

  const url = (
    process.env.LUBAN_DATABASE_URL ??
    process.env.POSTGRES_URL ??
    process.env.DATABASE_URL
  )?.trim();
  if (!url || !/^postgres(?:ql)?:\/\//.test(url)) {
    console.error(
      "Set LUBAN_DATABASE_URL (or POSTGRES_URL) to a postgres:// connection string.",
    );
    process.exitCode = 1;
    return;
  }

  const client = new Client({
    ...postgresConnectionOptions(url),
    connectionTimeoutMillis: 10_000,
  });
  await client.connect();

  let snapshot: DatabaseExport;
  try {
    snapshot = await exportTables((sql) => client.query(sql));
  } finally {
    await client.end();
  }

  const folder = join(process.cwd(), "backups");
  mkdirSync(folder, { recursive: true });
  const stamp = snapshot.exportedAt.replace(/[:.]/g, "-");
  const file = join(folder, `luban-db-${stamp}.json`);
  // "wx" never overwrites an earlier backup; 0o600 keeps it owner-only.
  writeFileSync(file, toJson(snapshot), { flag: "wx", mode: 0o600 });

  console.log(`Database host: ${new URL(url).hostname}`);
  for (const [name, table] of Object.entries(snapshot.tables)) {
    console.log(`  ${name.padEnd(28)} ${table.rowCount} rows`);
  }
  for (const name of snapshot.missingTables) {
    console.warn(`  Warning: expected table ${name} does not exist.`);
  }
  for (const name of snapshot.unlistedTables) {
    console.warn(`  Warning: exported unlisted table ${name}; add it to APPLICATION_TABLES.`);
  }
  console.log(`Backup written to ${file}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error("Backup failed:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
