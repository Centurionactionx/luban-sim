import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

describe("PostgreSQL migration execution", () => {
  let database: PGlite;

  beforeAll(async () => {
    const migration = await readFile(
      join(
        process.cwd(),
        "supabase",
        "migrations",
        "202608290001_luban_domain.sql",
      ),
      "utf8",
    );
    const seed = await readFile(
      join(process.cwd(), "supabase", "seed.sql"),
      "utf8",
    );

    database = new PGlite();
    await database.exec(migration);
    await database.exec(seed);
    await database.exec(seed);
  }, 30_000);

  afterAll(async () => {
    await database.close();
  });

  it("applies the real schema and idempotent seed without duplicating data", async () => {
    const result = await database.query<{
      competitions: number;
      teams: number;
      users: number;
    }>(`
      SELECT
        (SELECT COUNT(*)::integer FROM public.users) AS users,
        (SELECT COUNT(*)::integer FROM public.competitions) AS competitions,
        (SELECT COUNT(*)::integer FROM public.teams) AS teams
    `);

    expect(result.rows).toEqual([
      { users: 4, competitions: 1, teams: 4 },
    ]);
  });

  it("seeds only reconciled team balances", async () => {
    const result = await database.query<{ team_id: string }>(`
      SELECT team.id AS team_id
      FROM public.teams AS team
      LEFT JOIN public.ledger_entries AS entry ON entry.team_id = team.id
      GROUP BY team.id, team.cash_cents
      HAVING COALESCE(SUM(entry.amount_cents), 0) <> team.cash_cents
    `);

    expect(result.rows).toEqual([]);
  });

  it("enforces the production cash invariant", async () => {
    await expect(
      database.query(
        "UPDATE public.teams SET cash_cents = -1 WHERE id = 'northstar'",
      ),
    ).rejects.toThrow();

    const result = await database.query<{ cash_cents: bigint }>(
      "SELECT cash_cents FROM public.teams WHERE id = 'northstar'",
    );
    expect(Number(result.rows[0]?.cash_cents)).toBe(10_000_000);
  });
});
