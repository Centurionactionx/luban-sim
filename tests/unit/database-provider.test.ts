import { describe, expect, it } from "vitest";

import {
  REMOTE_DATABASE_MIGRATION_ACKNOWLEDGEMENT,
  assertPostgresCredentials,
  requireRemoteMigrationPostgresUrl,
  requireRuntimePostgresUrl,
  resolveDatabaseProvider,
  type DatabaseEnvironment,
} from "@/lib/server/database-provider";

const UNREACHABLE_POSTGRES_URL =
  "postgresql://luban:secret@database.invalid:6543/postgres?sslmode=require";

function environment(
  overrides: DatabaseEnvironment = {},
): DatabaseEnvironment {
  return {
    NODE_ENV: "development",
    ...overrides,
  };
}

describe("database provider isolation", () => {
  it("forces local development to SQLite even when Supabase credentials and the Postgres provider are present", () => {
    const env = environment({
      LUBAN_DATABASE_PROVIDER: "postgres",
      POSTGRES_URL: UNREACHABLE_POSTGRES_URL,
    });

    expect(resolveDatabaseProvider(env)).toBe("sqlite");
    expect(() => assertPostgresCredentials(env)).not.toThrow();
    expect(() => requireRuntimePostgresUrl(env)).toThrow(
      "PostgreSQL runtime access is allowed only on an explicitly configured production Vercel deployment.",
    );
  });

  it("forces automated tests to SQLite even if they mimic a Vercel deployment", () => {
    const env = environment({
      NODE_ENV: "test",
      VERCEL: "1",
      VERCEL_ENV: "production",
      LUBAN_DATABASE_PROVIDER: "postgres",
      POSTGRES_URL: UNREACHABLE_POSTGRES_URL,
      LUBAN_ALLOW_REMOTE_DATABASE_MIGRATION:
        REMOTE_DATABASE_MIGRATION_ACKNOWLEDGEMENT,
    });

    expect(resolveDatabaseProvider(env)).toBe("sqlite");
    expect(() => assertPostgresCredentials(env)).not.toThrow();
  });

  it("fails closed when a production shell requests Postgres outside Vercel", () => {
    const env = environment({
      NODE_ENV: "production",
      LUBAN_DATABASE_PROVIDER: "postgres",
      POSTGRES_URL: UNREACHABLE_POSTGRES_URL,
    });

    expect(() => resolveDatabaseProvider(env)).toThrow(
      "Vercel system environment variables are unavailable",
    );
    expect(() => assertPostgresCredentials(env)).toThrow(
      "remote database access remains disabled",
    );
    expect(() => requireRuntimePostgresUrl(env)).toThrow(
      "Vercel system environment variables are unavailable",
    );
  });

  it("fails closed unless production Vercel explicitly selects Postgres", () => {
    const implicit = environment({
      NODE_ENV: "production",
      VERCEL: "1",
      VERCEL_ENV: "production",
      POSTGRES_URL: UNREACHABLE_POSTGRES_URL,
    });
    const explicit = environment({
      ...implicit,
      LUBAN_DATABASE_PROVIDER: "postgres",
    });

    expect(() => resolveDatabaseProvider(implicit)).toThrow(
      "Ephemeral SQLite is disabled for Production",
    );
    expect(resolveDatabaseProvider(explicit)).toBe("postgres");
  });

  it("forces Vercel Preview deployments to SQLite even with production credentials", () => {
    const env = environment({
      NODE_ENV: "production",
      VERCEL: "1",
      VERCEL_ENV: "preview",
      LUBAN_DATABASE_PROVIDER: "postgres",
      POSTGRES_URL: UNREACHABLE_POSTGRES_URL,
    });

    expect(resolveDatabaseProvider(env)).toBe("sqlite");
    expect(() => requireRuntimePostgresUrl(env)).toThrow(
      "PostgreSQL runtime access is allowed only",
    );
  });

  it.each([
    ["missing", undefined, "POSTGRES_URL is required"],
    ["blank", "   ", "POSTGRES_URL is required"],
    ["malformed", "not-a-url", "must be a valid PostgreSQL connection URL"],
    ["wrong protocol", "https://database.invalid/postgres", "must be a valid PostgreSQL connection URL"],
  ])(
    "fails clearly when production Postgres credentials are %s",
    (_case, postgresUrl, expectedMessage) => {
      const env = environment({
        NODE_ENV: "production",
        VERCEL: "1",
        VERCEL_ENV: "production",
        LUBAN_DATABASE_PROVIDER: "postgres",
        POSTGRES_URL: postgresUrl,
      });

      expect(() => assertPostgresCredentials(env)).toThrow(expectedMessage);
      expect(() => requireRuntimePostgresUrl(env)).toThrow(expectedMessage);
    },
  );

  it("returns a validated production URL without contacting its unreachable host", () => {
    const env = environment({
      NODE_ENV: "production",
      VERCEL: "1",
      VERCEL_ENV: "production",
      LUBAN_DATABASE_PROVIDER: "postgres",
      POSTGRES_URL: `  ${UNREACHABLE_POSTGRES_URL}  `,
    });

    expect(() => assertPostgresCredentials(env)).not.toThrow();
    expect(requireRuntimePostgresUrl(env)).toBe(UNREACHABLE_POSTGRES_URL);
  });
});

describe("one-off remote migration guard", () => {
  it.each([undefined, "true", "I understand", "i_understand_this_touches_remote"])(
    "rejects a non-exact acknowledgement value (%s)",
    (acknowledgement) => {
      const env = environment({
        POSTGRES_URL: UNREACHABLE_POSTGRES_URL,
        LUBAN_ALLOW_REMOTE_DATABASE_MIGRATION: acknowledgement,
      });

      expect(() => requireRemoteMigrationPostgresUrl(env)).toThrow(
        "Remote database migration refused",
      );
    },
  );

  it("allows only the separately guarded migration accessor to return a remote URL locally", () => {
    const env = environment({
      LUBAN_DATABASE_PROVIDER: "postgres",
      POSTGRES_URL: UNREACHABLE_POSTGRES_URL,
      LUBAN_ALLOW_REMOTE_DATABASE_MIGRATION:
        REMOTE_DATABASE_MIGRATION_ACKNOWLEDGEMENT,
    });

    expect(resolveDatabaseProvider(env)).toBe("sqlite");
    expect(() => requireRuntimePostgresUrl(env)).toThrow(
      "PostgreSQL runtime access is allowed only",
    );
    expect(requireRemoteMigrationPostgresUrl(env)).toBe(
      UNREACHABLE_POSTGRES_URL,
    );
  });

  it("still requires a valid URL after the exact acknowledgement", () => {
    const env = environment({
      LUBAN_ALLOW_REMOTE_DATABASE_MIGRATION:
        REMOTE_DATABASE_MIGRATION_ACKNOWLEDGEMENT,
    });

    expect(() => requireRemoteMigrationPostgresUrl(env)).toThrow(
      "POSTGRES_URL is required",
    );
  });
});
