import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, extname, join, parse } from "node:path";
import { fileURLToPath } from "node:url";

import {
  requireRemoteMigrationPostgresUrl,
  requireRuntimePostgresUrl,
  resolveDatabaseProvider,
} from "../lib/server/database-provider";
import {
  findUnknownMigrationVersions,
  MIGRATION_PLAN_LOCK_KEY,
  normalizeSqlSource,
} from "./migration-utils";

interface MigrationFile {
  checksum: string;
  name: string;
  source: string;
  version: string;
}

interface MigrationOutcome {
  outcome: "applied" | "unchanged";
  version: string;
}

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const migrationsDirectory = join(projectRoot, "supabase", "migrations");
const seedPath = join(projectRoot, "supabase", "seed.sql");

function readInvocationMode(arguments_: string[]): "runtime" | "remote" {
  if (arguments_.length === 0) {
    return "runtime";
  }

  if (arguments_.length === 1 && arguments_[0] === "--remote") {
    return "remote";
  }

  throw new Error(
    "Unknown migration arguments. Use no arguments for the guarded Vercel build migration or --remote for an explicitly acknowledged remote migration.",
  );
}

function resolveConnectionUrl(mode: "runtime" | "remote"): string | null {
  if (mode === "remote") {
    return requireRemoteMigrationPostgresUrl(process.env);
  }

  if (resolveDatabaseProvider(process.env) !== "postgres") {
    return null;
  }

  return requireRuntimePostgresUrl(process.env);
}

async function readMigrations(): Promise<MigrationFile[]> {
  const entries = await readdir(migrationsDirectory, { withFileTypes: true });
  const filenames = entries
    .filter((entry) => entry.isFile() && extname(entry.name) === ".sql")
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right, "en"));

  if (filenames.length === 0) {
    throw new Error(`No PostgreSQL migrations found in ${migrationsDirectory}.`);
  }

  return Promise.all(
    filenames.map(async (filename) => {
      const source = normalizeSqlSource(
        await readFile(join(migrationsDirectory, filename), "utf8"),
      );
      const version = parse(filename).name;
      const separatorIndex = version.indexOf("_");

      return {
        version,
        name:
          separatorIndex === -1
            ? version
            : version.slice(separatorIndex + 1),
        checksum: createHash("sha256").update(source, "utf8").digest("hex"),
        source,
      };
    }),
  );
}

async function main(): Promise<void> {
  const mode = readInvocationMode(process.argv.slice(2));
  const connectionUrl = resolveConnectionUrl(mode);

  if (!connectionUrl) {
    console.info(
      "PostgreSQL migration skipped: this is not an explicitly configured Vercel Production runtime.",
    );
    return;
  }

  const migrations = await readMigrations();
  const seedSource = normalizeSqlSource(await readFile(seedPath, "utf8"));
  const { default: postgres } = await import("postgres");
  const sql = postgres(connectionUrl, {
    max: 1,
    prepare: false,
    connection: {
      application_name: "luban-schema-migration",
    },
  });

  try {
    const outcomes = await sql.begin(async (transaction) => {
      // One plan-wide lock covers schema creation, every pending migration,
      // and the seed. Concurrent/older deployments can never interleave an
      // incompatible seed with a different migration revision.
      await transaction`
        select pg_advisory_xact_lock(
          hashtextextended(${MIGRATION_PLAN_LOCK_KEY}, 0::bigint)
        )
      `;

      await transaction.unsafe(`
        create table if not exists public.schema_migrations (
          version text primary key,
          name text not null,
          checksum text not null,
          applied_at timestamptz not null default clock_timestamp()
        )
      `);

      const appliedRows = await transaction<Array<{ version: string }>>`
        select version
        from public.schema_migrations
        order by version asc
      `;
      const unknownVersions = findUnknownMigrationVersions(
        appliedRows.map(({ version }) => version),
        migrations.map(({ version }) => version),
      );
      if (unknownVersions.length > 0) {
        throw new Error(
          `The database contains migration versions that are newer than or absent from this checkout: ${unknownVersions.join(", ")}. Refusing to run an older seed. Deploy a current revision instead.`,
        );
      }

      const migrationOutcomes: MigrationOutcome[] = [];
      for (const migration of migrations) {
        const rows = await transaction<Array<{ checksum: string; name: string }>>`
          select checksum, name
          from public.schema_migrations
          where version = ${migration.version}
        `;
        const existing = rows[0];

        if (existing) {
          if (existing.checksum !== migration.checksum) {
            throw new Error(
              `Migration checksum drift detected for ${migration.version}. The applied checksum is ${existing.checksum}, but the repository contains ${migration.checksum}. Add a new migration instead of editing an applied file.`,
            );
          }

          migrationOutcomes.push({
            version: migration.version,
            outcome: "unchanged",
          });
          continue;
        }

        await transaction.unsafe(migration.source);
        await transaction`
          insert into public.schema_migrations (version, name, checksum)
          values (${migration.version}, ${migration.name}, ${migration.checksum})
        `;

        migrationOutcomes.push({
          version: migration.version,
          outcome: "applied",
        });
      }

      await transaction.unsafe(seedSource);
      return migrationOutcomes;
    });

    for (const { version, outcome } of outcomes) {
      console.info(`Migration ${version}: ${outcome}.`);
    }
    console.info("Idempotent PostgreSQL seed applied.");
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`PostgreSQL migration failed: ${message}`);
  process.exitCode = 1;
});
