import postgres from "postgres";

import { requireRuntimePostgresUrl } from "../database-provider";

export type PostgresClient = postgres.Sql<Record<string, never>>;
export type PostgresExecutor =
  | PostgresClient
  | postgres.TransactionSql<Record<string, never>>;

let postgresClient: PostgresClient | null = null;

/**
 * Lazily creates the production-only pooled PostgreSQL client.
 *
 * Merely importing this module never reads credentials and never opens a
 * network connection. requireRuntimePostgresUrl also refuses access outside
 * an explicitly configured production Vercel runtime.
 */
export function getPostgresClient(): PostgresClient {
  if (!postgresClient) {
    postgresClient = postgres(requireRuntimePostgresUrl(process.env), {
      max: 1,
      prepare: false,
    });
  }

  return postgresClient;
}

export async function closePostgresClientForTests(): Promise<void> {
  const client = postgresClient;
  postgresClient = null;

  if (client) {
    await client.end({ timeout: 5 });
  }
}
