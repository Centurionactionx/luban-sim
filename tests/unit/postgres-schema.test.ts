import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const migration = readFileSync(
  join(
    process.cwd(),
    "supabase",
    "migrations",
    "202608290001_luban_domain.sql",
  ),
  "utf8",
).toLowerCase();
const seed = readFileSync(
  join(process.cwd(), "supabase", "seed.sql"),
  "utf8",
).toLowerCase();

const DOMAIN_TABLES = [
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
] as const;

function withoutLineComments(sql: string): string {
  return sql
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");
}

describe("Supabase schema migration", () => {
  it("contains migration tracking and every SQLite domain table", () => {
    expect(migration).toContain(
      "create table if not exists public.schema_migrations",
    );

    for (const table of DOMAIN_TABLES) {
      expect(migration).toContain(
        `create table if not exists public.${table}`,
      );
    }
  });

  it("uses PostgreSQL-sized financial columns and typed timestamps", () => {
    expect(migration).toContain("cash_cents bigint");
    expect(migration).toContain("gross_cents bigint");
    expect(migration).toContain("amount_cents bigint");
    expect(migration).toMatch(/created_at timestamptz/g);
    expect(migration).toContain("expires_at timestamptz");
  });

  it("blocks browser roles from direct access to the server-owned ledger", () => {
    for (const table of DOMAIN_TABLES) {
      expect(migration).toContain(
        `alter table public.${table} enable row level security`,
      );
    }

    expect(migration).toContain("array['anon', 'authenticated']");
    expect(migration).toContain("revoke all privileges on table public.%i");
    expect(migration).not.toContain("create policy");
  });

  it("leaves transaction ownership to the advisory-lock migration runner", () => {
    const executableSql = withoutLineComments(migration);

    expect(executableSql).not.toMatch(/^\s*begin\s*;/m);
    expect(executableSql).not.toMatch(/^\s*commit\s*;/m);
  });
});

describe("Supabase prototype seed", () => {
  it("is idempotent and never clears live portfolio data", () => {
    const executableSql = withoutLineComments(seed);

    expect(seed).toContain("on conflict");
    expect(executableSql).not.toMatch(/\b(delete from|truncate|drop table)\b/);
    expect(executableSql).not.toMatch(/^\s*begin\s*;/m);
    expect(executableSql).not.toMatch(/^\s*commit\s*;/m);
  });

  it("refuses to complete if team cash no longer reconciles", () => {
    expect(seed).toContain("public.ledger_entries");
    expect(seed).toContain("coalesce(sum(entry.amount_cents), 0)");
    expect(seed).toContain("does not reconcile to its ledger");
  });
});
