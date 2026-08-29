import { randomUUID } from "node:crypto";

import type {
  AdminOverview,
  AdminTeamSummary,
  CompetitionStatus,
  SetTeamCashInput,
  TeamStatus,
  UpdateCompetitionStatusInput,
  UpdateTeamStatusInput,
} from "../contracts";
import { AppError } from "../errors";
import { getSessionUser } from "./auth";
import {
  assertLedgerReconciles,
  getDatabase,
  resetPrototypeDatabase,
  withReadTransaction,
} from "./db";
import {
  calculatePortfolio,
  getCompetitionSummary,
  getTeamSummary,
  listActivity,
} from "./queries";

export const COMPETITION_STATUSES = ["draft", "active", "paused", "ended"] as const;
export const TEAM_STATUSES = ["active", "frozen", "disqualified"] as const;
export const MAX_TEAM_CASH_CENTS = 100_000_000_000_000;

interface AdminTeamRow {
  id: string;
  name: string;
  status: TeamStatus;
  cash_cents: number;
  version: number;
  trade_count: number;
}

interface CashTeamRow {
  id: string;
  competition_id: string;
  name: string;
  cash_cents: number;
  version: number;
}

function requireHost(actorUserId: string): void {
  const user = getSessionUser(actorUserId);

  if (!user) {
    throw new AppError("UNAUTHORIZED", "Sign in to continue.", 401);
  }

  if (user.role !== "host") {
    throw new AppError("HOST_REQUIRED", "This action is restricted to hosts.", 403);
  }
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

export function listAdminTeams(actorUserId: string): AdminTeamSummary[] {
  requireHost(actorUserId);
  const now = new Date();
  const competition = getCompetitionSummary();
  const rows = getDatabase()
    .prepare(`
      SELECT
        t.id, t.name, t.status, t.cash_cents, t.version,
        COUNT(o.id) AS trade_count
      FROM teams t
      LEFT JOIN orders o ON o.team_id = t.id AND o.status = 'FILLED'
      WHERE t.competition_id = ?
      GROUP BY t.id
      ORDER BY t.name ASC
    `)
    .all(competition.id) as unknown as AdminTeamRow[];

  return rows.map((row) => {
    const team = getTeamSummary(row.id);
    const portfolio = calculatePortfolio(row.id, now).summary;

    return {
      id: row.id,
      name: row.name,
      status: row.status,
      memberNames: team.memberNames,
      cashCents: Number(row.cash_cents),
      totalValueCents: portfolio.totalValueCents,
      returnCents: portfolio.totalReturnCents,
      returnPercent: portfolio.totalReturnPercent,
      tradeCount: Number(row.trade_count),
      version: Number(row.version),
    };
  });
}

export function getAdminOverview(actorUserId: string): AdminOverview {
  return withReadTransaction(() => {
    requireHost(actorUserId);
    return {
      competition: getCompetitionSummary(),
      teams: listAdminTeams(actorUserId),
      recentActivity: listActivity(actorUserId, 30),
      generatedAt: new Date().toISOString(),
    };
  });
}

export function updateCompetitionStatus(
  input: UpdateCompetitionStatusInput,
): AdminOverview {
  requireHost(input.actorUserId);
  const status = normalizeCompetitionStatus(input.status);
  const database = getDatabase();
  const competition = getCompetitionSummary();

  if (competition.status === status) {
    return getAdminOverview(input.actorUserId);
  }

  database.exec("BEGIN IMMEDIATE;");

  try {
    const changed = database
      .prepare("UPDATE competitions SET status = ? WHERE id = ? AND status = ?")
      .run(status, competition.id, competition.status);

    if (Number(changed.changes) !== 1) {
      throw new AppError(
        "ADMIN_CONFLICT",
        "The competition changed while the update was being applied.",
        409,
      );
    }

    const actor = getSessionUser(input.actorUserId);
    const createdAt = new Date().toISOString();
    database
      .prepare(`
        INSERT INTO activity_events (
          id, competition_id, team_id, actor_user_id, type,
          title, detail, created_at
        ) VALUES (?, ?, NULL, ?, 'COMPETITION_STATUS_CHANGED', ?, ?, ?)
      `)
      .run(
        randomUUID(),
        competition.id,
        input.actorUserId,
        `Competition ${status}`,
        `${actor?.name ?? "Host"} changed the competition from ${competition.status} to ${status}.`,
        createdAt,
      );
    database.exec("COMMIT;");
  } catch (error) {
    try {
      database.exec("ROLLBACK;");
    } catch {
      // Preserve the domain or database error that caused the rollback.
    }
    throw error;
  }

  return getAdminOverview(input.actorUserId);
}

export function updateTeamStatus(input: UpdateTeamStatusInput): AdminOverview {
  requireHost(input.actorUserId);
  const status = normalizeTeamStatus(input.status);
  const database = getDatabase();
  const competition = getCompetitionSummary();
  const team = getTeamSummary(input.teamId);

  if (team.status === status) {
    return getAdminOverview(input.actorUserId);
  }

  database.exec("BEGIN IMMEDIATE;");

  try {
    const changed = database
      .prepare("UPDATE teams SET status = ?, version = version + 1 WHERE id = ? AND status = ?")
      .run(status, input.teamId, team.status);

    if (Number(changed.changes) !== 1) {
      throw new AppError(
        "ADMIN_CONFLICT",
        "The team changed while the update was being applied.",
        409,
      );
    }

    const actor = getSessionUser(input.actorUserId);
    const createdAt = new Date().toISOString();
    database
      .prepare(`
        INSERT INTO activity_events (
          id, competition_id, team_id, actor_user_id, type,
          title, detail, created_at
        ) VALUES (?, ?, ?, ?, 'TEAM_STATUS_CHANGED', ?, ?, ?)
      `)
      .run(
        randomUUID(),
        competition.id,
        input.teamId,
        input.actorUserId,
        `${team.name} ${status}`,
        `${actor?.name ?? "Host"} changed ${team.name} from ${team.status} to ${status}.`,
        createdAt,
      );
    database.exec("COMMIT;");
  } catch (error) {
    try {
      database.exec("ROLLBACK;");
    } catch {
      // Preserve the domain or database error that caused the rollback.
    }
    throw error;
  }

  return getAdminOverview(input.actorUserId);
}

export function setTeamCash(input: SetTeamCashInput): AdminOverview {
  requireHost(input.actorUserId);
  const cashCents = normalizeCashCents(input.cashCents);
  const database = getDatabase();
  let transactionOpen = false;

  database.exec("BEGIN IMMEDIATE;");
  transactionOpen = true;

  try {
    const team = database
      .prepare(`
        SELECT id, competition_id, name, cash_cents, version
        FROM teams
        WHERE id = ?
      `)
      .get(input.teamId) as CashTeamRow | undefined;

    if (!team) {
      throw new AppError("TEAM_NOT_FOUND", "That team does not exist.", 404);
    }

    const previousCashCents = Number(team.cash_cents);
    if (previousCashCents === cashCents) {
      database.exec("COMMIT;");
      transactionOpen = false;
      return getAdminOverview(input.actorUserId);
    }

    const changed = database
      .prepare(`
        UPDATE teams
        SET cash_cents = ?, version = version + 1
        WHERE id = ? AND version = ?
      `)
      .run(cashCents, team.id, team.version);

    if (Number(changed.changes) !== 1) {
      throw new AppError(
        "ADMIN_CONFLICT",
        "The team changed while its cash balance was being updated.",
        409,
      );
    }

    const actor = getSessionUser(input.actorUserId);
    const createdAt = new Date().toISOString();
    const adjustmentCents = cashCents - previousCashCents;
    database
      .prepare(`
        INSERT INTO ledger_entries (
          id, team_id, order_id, entry_type, amount_cents,
          symbol, quantity, note, created_at
        ) VALUES (?, ?, NULL, 'ADJUSTMENT', ?, NULL, NULL, ?, ?)
      `)
      .run(
        randomUUID(),
        team.id,
        adjustmentCents,
        `Host cash adjustment from ${formatCad(previousCashCents)} to ${formatCad(cashCents)}`,
        createdAt,
      );
    database
      .prepare(`
        INSERT INTO activity_events (
          id, competition_id, team_id, actor_user_id, type,
          title, detail, created_at
        ) VALUES (?, ?, ?, ?, 'TEAM_CASH_ADJUSTED', ?, ?, ?)
      `)
      .run(
        randomUUID(),
        team.competition_id,
        team.id,
        input.actorUserId,
        `${team.name} cash adjusted`,
        `${actor?.name ?? "Host"} changed ${team.name}'s cash from ${formatCad(previousCashCents)} to ${formatCad(cashCents)}.`,
        createdAt,
      );

    assertLedgerReconciles();
    database.exec("COMMIT;");
    transactionOpen = false;
  } catch (error) {
    if (transactionOpen) {
      try {
        database.exec("ROLLBACK;");
      } catch {
        // Preserve the original domain or database error.
      }
    }
    throw error;
  }

  return getAdminOverview(input.actorUserId);
}

export function setCompetitionStatus(
  input: UpdateCompetitionStatusInput,
): AdminOverview {
  return updateCompetitionStatus(input);
}

export function setTeamStatus(input: UpdateTeamStatusInput): AdminOverview {
  return updateTeamStatus(input);
}

export function resetPrototype(actorUserId: string): AdminOverview {
  requireHost(actorUserId);
  resetPrototypeDatabase();
  return getAdminOverview(actorUserId);
}
