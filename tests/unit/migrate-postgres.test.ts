import { spawnSync } from "node:child_process";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  findUnknownMigrationVersions,
  MIGRATION_PLAN_LOCK_KEY,
  normalizeSqlSource,
} from "@/scripts/migration-utils";

const migrationScript = join(
  process.cwd(),
  "scripts",
  "migrate-postgres.ts",
);
const unreachablePostgresUrl =
  "postgresql://luban:secret@database.invalid:6543/postgres";

function runMigration(
  environment: Readonly<Record<string, string | undefined>>,
  arguments_: string[] = [],
) {
  return spawnSync(
    process.execPath,
    ["--import", "tsx", migrationScript, ...arguments_],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        NODE_ENV: "development",
        VERCEL: "",
        VERCEL_ENV: "",
        LUBAN_DATABASE_PROVIDER: "postgres",
        LUBAN_ALLOW_REMOTE_DATABASE_MIGRATION: "",
        POSTGRES_URL: unreachablePostgresUrl,
        ...environment,
      },
      timeout: 10_000,
    },
  );
}

describe("PostgreSQL migration command guard", () => {
  it("canonicalizes SQL line endings across Windows and Vercel", () => {
    expect(normalizeSqlSource("select 1;\r\nselect 2;\rselect 3;\n")).toBe(
      "select 1;\nselect 2;\nselect 3;\n",
    );
    expect(MIGRATION_PLAN_LOCK_KEY).toBe("luban-schema-migration-plan");
  });

  it("detects a database migration that an older deployment does not know", () => {
    expect(
      findUnknownMigrationVersions(
        ["202608290001_luban_domain", "202608300001_newer_schema"],
        ["202608290001_luban_domain"],
      ),
    ).toEqual(["202608300001_newer_schema"]);
    expect(
      findUnknownMigrationVersions(
        ["202608290001_luban_domain"],
        ["202608290001_luban_domain", "202608300001_newer_schema"],
      ),
    ).toEqual([]);
  });

  it("skips locally without trying the supplied remote URL", () => {
    const result = runMigration({});

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("PostgreSQL migration skipped");
    expect(result.stderr).toBe("");
  });

  it("fails closed without connecting when a production shell lacks Vercel markers", () => {
    const result = runMigration({ NODE_ENV: "production" });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "Vercel system environment variables are unavailable",
    );
    expect(result.stderr).not.toContain("getaddrinfo");
  });

  it("skips on Vercel Preview without trying the Production URL", () => {
    const result = runMigration({
      NODE_ENV: "production",
      VERCEL: "1",
      VERCEL_ENV: "preview",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("PostgreSQL migration skipped");
    expect(result.stderr).toBe("");
  });

  it("fails before creating a client when Production credentials are missing", () => {
    const result = runMigration({
      NODE_ENV: "production",
      VERCEL: "1",
      VERCEL_ENV: "production",
      POSTGRES_URL: "",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "POSTGRES_URL is required when the PostgreSQL database is selected",
    );
  });

  it("refuses --remote before creating a client without the exact acknowledgement", () => {
    const result = runMigration({}, ["--remote"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Remote database migration refused");
  });

  it("rejects unknown arguments without creating a client", () => {
    const result = runMigration({}, ["--force"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Unknown migration arguments");
  });
});
