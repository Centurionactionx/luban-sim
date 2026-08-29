export type DatabaseProvider = "sqlite" | "postgres";

export type DatabaseEnvironment = Readonly<
  Record<string, string | undefined>
>;

export const REMOTE_DATABASE_MIGRATION_ACKNOWLEDGEMENT =
  "I_UNDERSTAND_THIS_TOUCHES_REMOTE";

/**
 * Selects the application's runtime database without ever inferring a remote
 * connection from the mere presence of Vercel/Supabase credentials.
 *
 * Local development, preview deployments, and automated tests stay on SQLite.
 * PostgreSQL is selected only for an explicit production Vercel deployment.
 */
export function resolveDatabaseProvider(
  env: DatabaseEnvironment,
): DatabaseProvider {
  if (env.NODE_ENV === "test") {
    return "sqlite";
  }

  const postgresRequested = env.LUBAN_DATABASE_PROVIDER === "postgres";

  if (env.NODE_ENV !== "production") {
    return "sqlite";
  }

  // `vercel.json` requests PostgreSQL, but the Vercel system variables prove
  // whether this is Production or Preview. If those variables are not exposed,
  // fail before reading POSTGRES_URL instead of silently running ephemeral
  // SQLite on a production server—or risking a remote connection locally.
  if (postgresRequested && (env.VERCEL !== "1" || !env.VERCEL_ENV)) {
    throw new Error(
      "PostgreSQL was requested for a production build, but Vercel system environment variables are unavailable. Enable Automatically expose System Environment Variables; remote database access remains disabled.",
    );
  }

  const isProductionVercel =
    env.VERCEL === "1" &&
    env.VERCEL_ENV === "production" &&
    env.NODE_ENV === "production";

  if (!isProductionVercel) {
    return "sqlite";
  }

  if (!postgresRequested) {
    throw new Error(
      "Vercel Production must set LUBAN_DATABASE_PROVIDER=postgres. Ephemeral SQLite is disabled for Production.",
    );
  }

  return "postgres";
}

function readPostgresUrl(env: DatabaseEnvironment): string {
  const postgresUrl = env.POSTGRES_URL?.trim();

  if (!postgresUrl) {
    throw new Error(
      "POSTGRES_URL is required when the PostgreSQL database is selected.",
    );
  }

  let parsedUrl: URL;

  try {
    parsedUrl = new URL(postgresUrl);
  } catch {
    throw new Error("POSTGRES_URL must be a valid PostgreSQL connection URL.");
  }

  if (
    (parsedUrl.protocol !== "postgres:" &&
      parsedUrl.protocol !== "postgresql:") ||
    !parsedUrl.hostname
  ) {
    throw new Error("POSTGRES_URL must be a valid PostgreSQL connection URL.");
  }

  return postgresUrl;
}

/**
 * Returns the pooled production connection URL. This accessor intentionally
 * reads POSTGRES_URL only; it never falls back to a direct/non-pooling URL.
 */
export function requireRuntimePostgresUrl(env: DatabaseEnvironment): string {
  if (resolveDatabaseProvider(env) !== "postgres") {
    throw new Error(
      "PostgreSQL runtime access is allowed only on an explicitly configured production Vercel deployment.",
    );
  }

  return readPostgresUrl(env);
}

export function assertPostgresCredentials(env: DatabaseEnvironment): void {
  if (resolveDatabaseProvider(env) === "postgres") {
    readPostgresUrl(env);
  }
}

/**
 * Gives a one-off migration command an intentionally separate escape hatch.
 * Application runtime code must use requireRuntimePostgresUrl instead.
 */
export function requireRemoteMigrationPostgresUrl(
  env: DatabaseEnvironment,
): string {
  if (
    env.LUBAN_ALLOW_REMOTE_DATABASE_MIGRATION !==
    REMOTE_DATABASE_MIGRATION_ACKNOWLEDGEMENT
  ) {
    throw new Error(
      "Remote database migration refused. Set LUBAN_ALLOW_REMOTE_DATABASE_MIGRATION to the exact acknowledgement value for this one command.",
    );
  }

  return readPostgresUrl(env);
}
