import { randomUUID } from "node:crypto";

import type {
  AdminOverview,
  AdminTeamSummary,
  CompetitionStatus,
  SetTeamCashInput,
  TeamStatus,
  UpdateCompetitionStatusInput,
  UpdateTeamStatusInput,
  UserRole,
} from "../../contracts";
import { AppError } from "../../errors";
import { getPostgresClient, type PostgresExecutor } from "./client";
import {
  calculatePostgresPortfolio,
  getPostgresCompetitionSummary,
  getPostgresTeamSummary,
  listPostgresActivity,
} from "./queries";

const COMPETITION_STATUSES = ["draft", "active", "paused", "ended"] as const;
const TEAM_STATUSES = ["active", "frozen", "disqualified"] as const;
const MAX_TEAM_CASH_CENTS = 100_000_000_000_000;

type DatabaseInteger = bigint | number | string;

interface HostRow {
  id: string;
  name: string;
  role: UserRole;
}

interface AdminTeamRow {
  id: string;
  name: string;
  status: TeamStatus;
  cash_cents: DatabaseInteger;
  version: DatabaseInteger;
  trade_count: DatabaseInteger;
}

interface CompetitionLockRow {
  id: string;
  status: CompetitionStatus;
}

interface TeamLockRow {
  id: string;
  competition_id: string;
  name: string;
  status: TeamStatus;
  cash_cents: DatabaseInteger;
  version: DatabaseInteger;
}

function databaseInteger(value: DatabaseInteger, field: string): number {
  const normalized = Number(value);

  if (!Number.isSafeInteger(normalized)) {
    throw new AppError(
      "DATABASE_VALUE_OUT_OF_RANGE",
      `The stored ${field} value is outside the supported integer range.`,
      500,
    );
  }

  return normalized;
}

async function requireHost(
  actorUserId: string,
  database: PostgresExecutor,
  lockRole = false,
): Promise<HostRow> {
  const users = lockRole
    ? await database<HostRow[]>`
        SELECT id, name, role
        FROM public.users
        WHERE id = ${actorUserId}
        LIMIT 1
        FOR SHARE
      `
    : await database<HostRow[]>`
        SELECT id, name, role
        FROM public.users
        WHERE id = ${actorUserId}
        LIMIT 1
      `;
  const user = users[0];

  if (!user) {
    throw new AppError("UNAUTHORIZED", "Sign in to continue.", 401);
  }

  if (user.role !== "host") {
    throw new AppError(
      "HOST_REQUIRED",
      "This action is restricted to hosts.",
      403,
    );
  }

  return user;
}

function normalizeCompetitionStatus(value: unknown): CompetitionStatus {
  const normalized = String(value ?? "").toLowerCase();

  if (!COMPETITION_STATUSES.includes(normalized as CompetitionStatus)) {
    throw new AppError(
      "INVALID_COMPETITION_STATUS",
      "Competition status must be draft, active, paused, or ended.",
      400,
    );
  }

  return normalized as CompetitionStatus;
}

function normalizeTeamStatus(value: unknown): TeamStatus {
  const normalized = String(value ?? "").toLowerCase();

  if (!TEAM_STATUSES.includes(normalized as TeamStatus)) {
    throw new AppError(
      "INVALID_TEAM_STATUS",
      "Team status must be active, frozen, or disqualified.",
      400,
    );
  }

  return normalized as TeamStatus;
}

function normalizeCashCents(value: unknown): number {
  if (
    !Number.isSafeInteger(value) ||
    Number(value) < 0 ||
    Number(value) > MAX_TEAM_CASH_CENTS
  ) {
    throw new AppError(
      "INVALID_CASH_BALANCE",
      "Cash must be a non-negative amount within the supported CAD limit.",
      400,
      { field: "cashCents", maximumCents: MAX_TEAM_CASH_CENTS },
    );
  }

  return Number(value);
}

function formatCad(cents: number): string {
  return new Intl.NumberFormat("en-CA", {
    style: "currency",
    currency: "CAD",
  }).format(cents / 100);
}

async function assertTeamLedger(
  database: PostgresExecutor,
  teamId: string,
): Promise<void> {
  const rows = await database<
    Array<{
      cash_cents: DatabaseInteger;
      ledger_balance_cents: DatabaseInteger;
    }>
  >`
    SELECT
      team.cash_cents,
      COALESCE(SUM(entry.amount_cents), 0)::bigint AS ledger_balance_cents
    FROM public.teams AS team
    LEFT JOIN public.ledger_entries AS entry ON entry.team_id = team.id
    WHERE team.id = ${teamId}
    GROUP BY team.id, team.cash_cents
  `;
  const row = rows[0];

  if (!row) {
    throw new AppError("TEAM_NOT_FOUND", "That team does not exist.", 404);
  }

  const cashCents = databaseInteger(row.cash_cents, "team cash");
  const ledgerBalanceCents = databaseInteger(
    row.ledger_balance_cents,
    "ledger balance",
  );

  if (cashCents !== ledgerBalanceCents) {
    throw new AppError(
      "LEDGER_OUT_OF_BALANCE",
      "The team cash balance does not reconcile to its ledger.",
      500,
      {
        teamId,
        cashCents,
        ledgerBalanceCents,
        differenceCents: ledgerBalanceCents - cashCents,
      },
    );
  }
}

export async function listPostgresAdminTeams(
  actorUserId: string,
  database: PostgresExecutor = getPostgresClient(),
  allowStoredQuoteFallback = false,
): Promise<AdminTeamSummary[]> {
  await requireHost(actorUserId, database);
  const competition = await getPostgresCompetitionSummary(database);
  const rows = await database<AdminTeamRow[]>`
    SELECT
      team.id,
      team.name,
      team.status,
      team.cash_cents,
      team.version,
      COUNT(order_row.id) FILTER (
        WHERE order_row.status = 'FILLED'
      ) AS trade_count
    FROM public.teams AS team
    LEFT JOIN public.orders AS order_row ON order_row.team_id = team.id
    WHERE team.competition_id = ${competition.id}
    GROUP BY
      team.id,
      team.name,
      team.status,
      team.cash_cents,
      team.version
    ORDER BY team.name ASC
  `;
  const now = new Date();
  const teams: AdminTeamSummary[] = [];

  // A transaction executor owns one pooled connection, so keep these reads
  // sequential. Quote refreshes are coalesced by the market-data provider.
  for (const row of rows) {
    const team = await getPostgresTeamSummary(row.id, database);
    const portfolio = await calculatePostgresPortfolio(
      row.id,
      now,
      database,
      allowStoredQuoteFallback,
    );

    teams.push({
      id: row.id,
      name: row.name,
      status: row.status,
      memberNames: team.memberNames,
      cashCents: databaseInteger(row.cash_cents, "team cash"),
      totalValueCents: portfolio.summary.totalValueCents,
      returnCents: portfolio.summary.totalReturnCents,
      returnPercent: portfolio.summary.totalReturnPercent,
      tradeCount: databaseInteger(row.trade_count, "trade count"),
      version: databaseInteger(row.version, "team version"),
    });
  }

  return teams;
}

export async function getPostgresAdminOverview(
  actorUserId: string,
  allowStoredQuoteFallback = false,
): Promise<AdminOverview> {
  return getPostgresClient().begin(
    "isolation level repeatable read",
    async (database) => {
      await requireHost(actorUserId, database);

      return {
        competition: await getPostgresCompetitionSummary(database),
        teams: await listPostgresAdminTeams(
          actorUserId,
          database,
          allowStoredQuoteFallback,
        ),
        recentActivity: await listPostgresActivity(actorUserId, 30, database),
        generatedAt: new Date().toISOString(),
      };
    },
  );
}

export async function updatePostgresCompetitionStatus(
  input: UpdateCompetitionStatusInput,
): Promise<AdminOverview> {
  const client = getPostgresClient();

  await client.begin(async (database) => {
    const actor = await requireHost(input.actorUserId, database, true);
    const status = normalizeCompetitionStatus(input.status);
    const competitions = await database<CompetitionLockRow[]>`
      SELECT id, status
      FROM public.competitions
      ORDER BY created_at DESC
      LIMIT 1
      FOR UPDATE
    `;
    const competition = competitions[0];

    if (!competition) {
      throw new AppError(
        "COMPETITION_NOT_FOUND",
        "No competition is configured.",
        404,
      );
    }

    if (competition.status === status) return;

    const updates = await database<Array<{ id: string }>>`
      UPDATE public.competitions
      SET status = ${status}
      WHERE id = ${competition.id} AND status = ${competition.status}
      RETURNING id
    `;

    if (updates.length !== 1) {
      throw new AppError(
        "ADMIN_CONFLICT",
        "The competition changed while the update was being applied.",
        409,
      );
    }

    await database`
      INSERT INTO public.activity_events (
        id, competition_id, team_id, actor_user_id, type,
        title, detail, created_at
      ) VALUES (
        ${randomUUID()}, ${competition.id}, NULL, ${input.actorUserId},
        'COMPETITION_STATUS_CHANGED', ${`Competition ${status}`},
        ${`${actor.name} changed the competition from ${competition.status} to ${status}.`},
        ${new Date()}
      )
    `;

  });

  // The mutation is already committed. Build the response from the most
  // recently persisted market metadata if Yahoo becomes unavailable, so the
  // caller never receives a false "write failed" response after success.
  return getPostgresAdminOverview(input.actorUserId, true);
}

export async function updatePostgresTeamStatus(
  input: UpdateTeamStatusInput,
): Promise<AdminOverview> {
  const client = getPostgresClient();

  await client.begin(async (database) => {
    const actor = await requireHost(input.actorUserId, database, true);
    const status = normalizeTeamStatus(input.status);
    const teams = await database<TeamLockRow[]>`
      SELECT id, competition_id, name, status, cash_cents, version
      FROM public.teams
      WHERE id = ${input.teamId}
      FOR UPDATE
    `;
    const team = teams[0];

    if (!team) {
      throw new AppError("TEAM_NOT_FOUND", "That team does not exist.", 404);
    }

    if (team.status === status) return;

    const currentVersion = databaseInteger(team.version, "team version");
    const updates = await database<Array<{ version: DatabaseInteger }>>`
      UPDATE public.teams
      SET status = ${status}, version = version + 1
      WHERE id = ${team.id}
        AND status = ${team.status}
        AND version = ${currentVersion}
      RETURNING version
    `;

    if (updates.length !== 1) {
      throw new AppError(
        "ADMIN_CONFLICT",
        "The team changed while the update was being applied.",
        409,
      );
    }
    databaseInteger(updates[0].version, "team version");

    await database`
      INSERT INTO public.activity_events (
        id, competition_id, team_id, actor_user_id, type,
        title, detail, created_at
      ) VALUES (
        ${randomUUID()}, ${team.competition_id}, ${team.id},
        ${input.actorUserId}, 'TEAM_STATUS_CHANGED',
        ${`${team.name} ${status}`},
        ${`${actor.name} changed ${team.name} from ${team.status} to ${status}.`},
        ${new Date()}
      )
    `;

    await assertTeamLedger(database, team.id);
  });

  return getPostgresAdminOverview(input.actorUserId, true);
}

export async function setPostgresTeamCash(
  input: SetTeamCashInput,
): Promise<AdminOverview> {
  const client = getPostgresClient();

  await client.begin(async (database) => {
    const actor = await requireHost(input.actorUserId, database, true);
    const cashCents = normalizeCashCents(input.cashCents);
    const teams = await database<TeamLockRow[]>`
      SELECT id, competition_id, name, status, cash_cents, version
      FROM public.teams
      WHERE id = ${input.teamId}
      FOR UPDATE
    `;
    const team = teams[0];

    if (!team) {
      throw new AppError("TEAM_NOT_FOUND", "That team does not exist.", 404);
    }

    const previousCashCents = databaseInteger(team.cash_cents, "team cash");
    if (previousCashCents === cashCents) return;

    const currentVersion = databaseInteger(team.version, "team version");
    const updates = await database<Array<{ version: DatabaseInteger }>>`
      UPDATE public.teams
      SET cash_cents = ${cashCents}, version = version + 1
      WHERE id = ${team.id} AND version = ${currentVersion}
      RETURNING version
    `;

    if (updates.length !== 1) {
      throw new AppError(
        "ADMIN_CONFLICT",
        "The team changed while its cash balance was being updated.",
        409,
      );
    }
    databaseInteger(updates[0].version, "team version");

    const createdAt = new Date();
    const adjustmentCents = cashCents - previousCashCents;
    await database`
      INSERT INTO public.ledger_entries (
        id, team_id, order_id, entry_type, amount_cents,
        symbol, quantity, note, created_at
      ) VALUES (
        ${randomUUID()}, ${team.id}, NULL, 'ADJUSTMENT', ${adjustmentCents},
        NULL, NULL,
        ${`Host cash adjustment from ${formatCad(previousCashCents)} to ${formatCad(cashCents)}`},
        ${createdAt}
      )
    `;
    await database`
      INSERT INTO public.activity_events (
        id, competition_id, team_id, actor_user_id, type,
        title, detail, created_at
      ) VALUES (
        ${randomUUID()}, ${team.competition_id}, ${team.id},
        ${input.actorUserId}, 'TEAM_CASH_ADJUSTED',
        ${`${team.name} cash adjusted`},
        ${`${actor.name} changed ${team.name}'s cash from ${formatCad(previousCashCents)} to ${formatCad(cashCents)}.`},
        ${createdAt}
      )
    `;

    await assertTeamLedger(database, team.id);
  });

  return getPostgresAdminOverview(input.actorUserId, true);
}

export async function resetPostgresPrototype(
  actorUserId: string,
): Promise<AdminOverview> {
  await requireHost(actorUserId, getPostgresClient());

  throw new AppError(
    "PRODUCTION_RESET_DISABLED",
    "Reset is disabled for the shared production database. Restore or reseed it through an audited migration instead.",
    403,
  );
}
