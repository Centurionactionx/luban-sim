import { randomUUID } from "node:crypto";

import type {
  Announcement,
  AnnouncementTone,
  AdminOverview,
  AdminTeamSummary,
  CompetitionStatus,
  CreateCompetitionTeamInput,
  RemoveCompetitionTeamInput,
  RenameCompetitionTeamInput,
  SetTeamCashInput,
  TeamStatus,
  UpdateCompetitionScheduleInput,
  UpdateCompetitionStatusInput,
  UpdateTeamStatusInput,
} from "../contracts";
import { canHostCompetitions } from "../contracts";
import { AppError } from "../errors";
import { formatDisplayDateTime } from "../time";
import { getSessionUser } from "./auth";
import {
  ADVISORY_LOCK_ACCOUNTS,
  acquireAdvisoryLock,
  type DbExecutor,
} from "./database";
import {
  assertTeamLedgerReconciles,
  getDb,
  resetPrototypeDatabase,
  withReadTransaction,
} from "./db";
import {
  calculatePortfolio,
  getAnnouncement,
  getCompetitionSummary,
  getTeamSummary,
  listActivity,
} from "./queries";

export const COMPETITION_STATUSES = ["draft", "active", "paused", "ended"] as const;
export const TEAM_STATUSES = ["active", "frozen", "disqualified"] as const;
export const MAX_TEAM_NAME_LENGTH = 80;
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

interface MutableTeamRow {
  id: string;
  competition_id: string;
  name: string;
  version: number;
}

async function requireHost(actorUserId: string): Promise<void> {
  const user = await getSessionUser(actorUserId);

  if (!user) {
    throw new AppError("UNAUTHORIZED", "Sign in to continue.", 401);
  }

  if (user.status !== "active") {
    throw new AppError("ACCOUNT_SUSPENDED", "This account is suspended.", 403);
  }

  if (!canHostCompetitions(user.role)) {
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

export function normalizeTeamName(value: unknown): string {
  const normalized = String(value ?? "").trim().replace(/\s+/g, " ");

  if (!normalized) {
    throw new AppError("TEAM_NAME_REQUIRED", "Enter a team name.", 400, {
      field: "name",
    });
  }
  if (normalized.length > MAX_TEAM_NAME_LENGTH) {
    throw new AppError(
      "TEAM_NAME_TOO_LONG",
      `Team names can be at most ${MAX_TEAM_NAME_LENGTH} characters.`,
      400,
      { field: "name", maximum: MAX_TEAM_NAME_LENGTH },
    );
  }

  return normalized;
}

async function assertTeamNameAvailable(
  executor: DbExecutor,
  competitionId: string,
  name: string,
  excludedTeamId?: string,
): Promise<void> {
  const existing = await executor.get<{ id: string }>(
    `SELECT id FROM teams
     WHERE competition_id = ?
       AND sandbox_owner_user_id IS NULL
       AND LOWER(name) = LOWER(?)
       ${excludedTeamId ? "AND id <> ?" : ""}
     LIMIT 1`,
    excludedTeamId
      ? [competitionId, name, excludedTeamId]
      : [competitionId, name],
  );

  if (existing) {
    throw new AppError(
      "TEAM_NAME_TAKEN",
      "Another competition team already uses that name.",
      409,
      { field: "name" },
    );
  }
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

export async function listAdminTeams(
  actorUserId: string,
): Promise<AdminTeamSummary[]> {
  await requireHost(actorUserId);
  const now = new Date();
  const competition = await getCompetitionSummary();
  const db = await getDb();
  const rows = await db.all<AdminTeamRow>(
    `
      SELECT
        t.id, t.name, t.status, t.cash_cents, t.version,
        COUNT(o.id) AS trade_count
      FROM teams t
      LEFT JOIN orders o ON o.team_id = t.id AND o.status = 'FILLED'
      WHERE t.competition_id = ? AND t.sandbox_owner_user_id IS NULL
      GROUP BY t.id
      ORDER BY t.name ASC
    `,
    [competition.id],
  );

  const summaries: AdminTeamSummary[] = [];

  for (const row of rows) {
    const team = await getTeamSummary(row.id);
    const portfolio = (await calculatePortfolio(row.id, now)).summary;

    summaries.push({
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
    });
  }

  return summaries;
}

export async function getAdminOverview(
  actorUserId: string,
): Promise<AdminOverview> {
  return withReadTransaction(async () => {
    await requireHost(actorUserId);
    return {
      competition: await getCompetitionSummary(),
      teams: await listAdminTeams(actorUserId),
      recentActivity: await listActivity(actorUserId, 30, "competition"),
      generatedAt: new Date().toISOString(),
    };
  });
}

export async function updateCompetitionStatus(
  input: UpdateCompetitionStatusInput,
): Promise<AdminOverview> {
  await requireHost(input.actorUserId);
  const status = normalizeCompetitionStatus(input.status);
  const db = await getDb();
  const competition = await getCompetitionSummary();

  if (competition.status === status) {
    return getAdminOverview(input.actorUserId);
  }

  await db.transaction(async (tx) => {
    await acquireAdvisoryLock(tx, ADVISORY_LOCK_ACCOUNTS);
    await requireHost(input.actorUserId);
    const changed = await tx.run(
      "UPDATE competitions SET status = ? WHERE id = ? AND status = ?",
      [status, competition.id, competition.status],
    );

    if (changed.changes !== 1) {
      throw new AppError(
        "ADMIN_CONFLICT",
        "The competition changed while the update was being applied.",
        409,
      );
    }

    const actor = await getSessionUser(input.actorUserId);
    const createdAt = new Date().toISOString();
    await tx.run(
      `
        INSERT INTO activity_events (
          id, competition_id, team_id, actor_user_id, type,
          title, detail, created_at
        ) VALUES (?, ?, NULL, ?, 'COMPETITION_STATUS_CHANGED', ?, ?, ?)
      `,
      [
        randomUUID(),
        competition.id,
        input.actorUserId,
        `Competition ${status}`,
        `${actor?.name ?? "Host"} changed the competition from ${competition.status} to ${status}.`,
        createdAt,
      ],
    );
  });

  return getAdminOverview(input.actorUserId);
}

const MAX_COMPETITION_LENGTH_MS = 366 * 24 * 3_600_000;

function normalizeScheduleInstant(
  value: string | undefined,
  fallback: string,
  field: string,
): string {
  if (value === undefined) {
    return fallback;
  }

  const parsed = Date.parse(value);

  if (typeof value !== "string" || !Number.isFinite(parsed)) {
    throw new AppError(
      "INVALID_SCHEDULE_TIME",
      "Schedule times must be valid dates with a time.",
      400,
      { field },
    );
  }

  return new Date(parsed).toISOString();
}

/**
 * Sets the competition window and, while nothing has traded yet, the teams'
 * starting cash. The window itself is what opens and closes trading: an
 * "active" competition accepts orders only between startsAt and endsAt, so
 * scheduling a start or end needs no timer — it takes effect by clock.
 */
export async function updateCompetitionSchedule(
  input: UpdateCompetitionScheduleInput,
): Promise<AdminOverview> {
  await requireHost(input.actorUserId);

  if (
    input.startsAt === undefined &&
    input.endsAt === undefined &&
    input.startingCashCents === undefined
  ) {
    throw new AppError(
      "EMPTY_SCHEDULE_UPDATE",
      "Provide a start, an end, or a starting cash amount to update.",
      400,
    );
  }

  const db = await getDb();

  await db.transaction(async (tx) => {
    await acquireAdvisoryLock(tx, ADVISORY_LOCK_ACCOUNTS);
    await requireHost(input.actorUserId);

    const competition = await tx.get<{
      id: string;
      name: string;
      status: CompetitionStatus;
      starting_cash_cents: number;
      starts_at: string;
      ends_at: string;
    }>(`
      SELECT id, name, status, starting_cash_cents, starts_at, ends_at
      FROM competitions
      ORDER BY created_at DESC
      LIMIT 1
    `);

    if (!competition) {
      throw new AppError(
        "COMPETITION_NOT_FOUND",
        "No competition is configured.",
        404,
      );
    }

    const startsAt = normalizeScheduleInstant(
      input.startsAt,
      competition.starts_at,
      "startsAt",
    );
    const endsAt = normalizeScheduleInstant(
      input.endsAt,
      competition.ends_at,
      "endsAt",
    );

    if (endsAt <= startsAt) {
      throw new AppError(
        "INVALID_SCHEDULE_WINDOW",
        "The competition must end after it starts.",
        400,
        { field: "endsAt" },
      );
    }

    if (Date.parse(endsAt) - Date.parse(startsAt) > MAX_COMPETITION_LENGTH_MS) {
      throw new AppError(
        "INVALID_SCHEDULE_WINDOW",
        "Competitions are limited to one year.",
        400,
        { field: "endsAt" },
      );
    }

    const scheduleChanged =
      startsAt !== competition.starts_at || endsAt !== competition.ends_at;

    if (scheduleChanged) {
      await tx.run(
        "UPDATE competitions SET starts_at = ?, ends_at = ? WHERE id = ?",
        [startsAt, endsAt, competition.id],
      );
    }

    let cashChanged = false;
    const rebuiltTeamIds: string[] = [];

    if (
      input.startingCashCents !== undefined &&
      Number(input.startingCashCents) !== Number(competition.starting_cash_cents)
    ) {
      const cashCents = input.startingCashCents;

      if (
        !Number.isSafeInteger(cashCents) ||
        cashCents < 0 ||
        cashCents > MAX_TEAM_CASH_CENTS
      ) {
        throw new AppError(
          "INVALID_CASH_BALANCE",
          "Starting cash must be a non-negative amount within the supported CAD limit.",
          400,
          { field: "startingCashCents", maximumCents: MAX_TEAM_CASH_CENTS },
        );
      }

      // Lock every team row before the traded-count gate. On PostgreSQL a
      // concurrent order's version-CAS UPDATE blocks on these locks until
      // this transaction ends, and an order that committed first is visible
      // to the count below — so the rebuild can never erase a trade that
      // slipped in around the gate. SQLite's single-writer transactions
      // already serialize this; FOR UPDATE is not valid syntax there.
      if (tx.engine === "postgres") {
        await tx.all(
          `SELECT id FROM teams
           WHERE competition_id = ? AND sandbox_owner_user_id IS NULL
           FOR UPDATE`,
          [competition.id],
        );
      }

      const traded = await tx.get<{ count: number }>(
        `
          SELECT COUNT(*) AS count
          FROM orders o
          JOIN teams t ON t.id = o.team_id
          WHERE t.competition_id = ? AND t.sandbox_owner_user_id IS NULL
        `,
        [competition.id],
      );

      if (Number(traded?.count ?? 0) > 0) {
        throw new AppError(
          "STARTING_CASH_LOCKED",
          "Starting cash cannot change once trading has begun. Reset the demo data or adjust individual team balances instead.",
          409,
          { field: "startingCashCents" },
        );
      }

      await tx.run(
        "UPDATE competitions SET starting_cash_cents = ? WHERE id = ?",
        [cashCents, competition.id],
      );

      // No orders exist, so each team's ledger holds only its starting-cash
      // entry (plus any pre-start host adjustments). Rebuild it as a single
      // fresh STARTING_CASH line so cash and ledger reconcile exactly.
      const teams = await tx.all<{ id: string }>(
        `SELECT id FROM teams
         WHERE competition_id = ? AND sandbox_owner_user_id IS NULL`,
        [competition.id],
      );
      const nowIso = new Date().toISOString();

      for (const team of teams) {
        await tx.run(
          "UPDATE teams SET cash_cents = ?, version = version + 1 WHERE id = ?",
          [cashCents, team.id],
        );
        await tx.run("DELETE FROM ledger_entries WHERE team_id = ?", [team.id]);
        rebuiltTeamIds.push(team.id);
        await tx.run(
          `
            INSERT INTO ledger_entries (
              id, team_id, order_id, entry_type, amount_cents,
              symbol, quantity, note, created_at
            ) VALUES (?, ?, NULL, 'STARTING_CASH', ?, NULL, NULL, ?, ?)
          `,
          [
            randomUUID(),
            team.id,
            cashCents,
            "Competition starting balance",
            nowIso,
          ],
        );
      }

      cashChanged = true;
    }

    if (scheduleChanged || cashChanged) {
      const actor = await getSessionUser(input.actorUserId);
      const changes: string[] = [];

      if (scheduleChanged) {
        changes.push(
          `the window to ${formatDisplayDateTime(startsAt)} through ${formatDisplayDateTime(endsAt)}`,
        );
      }
      if (cashChanged) {
        changes.push(
          `starting cash to ${formatCad(Number(input.startingCashCents))}`,
        );
      }

      await tx.run(
        `
          INSERT INTO activity_events (
            id, competition_id, team_id, actor_user_id, type,
            title, detail, created_at
          ) VALUES (?, ?, NULL, ?, 'COMPETITION_SCHEDULE_CHANGED', ?, ?, ?)
        `,
        [
          randomUUID(),
          competition.id,
          input.actorUserId,
          "Competition schedule updated",
          `${actor?.name ?? "Host"} set ${changes.join(" and ")}.`,
          new Date().toISOString(),
        ],
      );

      // Only a starting-cash change rewrites ledgers; a schedule-only change
      // leaves every ledger untouched and has nothing to reconcile.
      await assertTeamLedgerReconciles(rebuiltTeamIds);
    }
  });

  return getAdminOverview(input.actorUserId);
}

export async function createCompetitionTeam(
  input: CreateCompetitionTeamInput,
): Promise<AdminOverview> {
  await requireHost(input.actorUserId);
  const name = normalizeTeamName(input.name);
  const db = await getDb();

  await db.transaction(async (tx) => {
    await acquireAdvisoryLock(tx, ADVISORY_LOCK_ACCOUNTS);
    await requireHost(input.actorUserId);
    const competition = await getCompetitionSummary();
    await assertTeamNameAvailable(tx, competition.id, name);

    const teamId = randomUUID();
    const createdAt = new Date().toISOString();
    await tx.run(
      `INSERT INTO teams (
         id, competition_id, name, status, cash_cents, version, created_at
       ) VALUES (?, ?, ?, 'active', ?, 0, ?)`,
      [teamId, competition.id, name, competition.startingCashCents, createdAt],
    );
    await tx.run(
      `INSERT INTO ledger_entries (
         id, team_id, order_id, entry_type, amount_cents,
         symbol, quantity, note, created_at
       ) VALUES (?, ?, NULL, 'STARTING_CASH', ?, NULL, NULL, ?, ?)`,
      [
        randomUUID(),
        teamId,
        competition.startingCashCents,
        "Competition starting balance",
        createdAt,
      ],
    );

    const actor = await getSessionUser(input.actorUserId);
    await tx.run(
      `INSERT INTO activity_events (
         id, competition_id, team_id, actor_user_id, type,
         title, detail, created_at
       ) VALUES (?, ?, ?, ?, 'TEAM_CREATED', ?, ?, ?)`,
      [
        randomUUID(),
        competition.id,
        teamId,
        input.actorUserId,
        `${name} added`,
        `${actor?.name ?? "Host"} added ${name} to the competition.`,
        createdAt,
      ],
    );

    await assertTeamLedgerReconciles([teamId]);
  });

  return getAdminOverview(input.actorUserId);
}

export async function renameCompetitionTeam(
  input: RenameCompetitionTeamInput,
): Promise<AdminOverview> {
  await requireHost(input.actorUserId);
  const name = normalizeTeamName(input.name);
  const db = await getDb();

  await db.transaction(async (tx) => {
    await acquireAdvisoryLock(tx, ADVISORY_LOCK_ACCOUNTS);
    await requireHost(input.actorUserId);
    const team = await tx.get<MutableTeamRow>(
      `SELECT id, competition_id, name, version
       FROM teams
       WHERE id = ? AND sandbox_owner_user_id IS NULL`,
      [input.teamId],
    );

    if (!team) {
      throw new AppError("TEAM_NOT_FOUND", "That team does not exist.", 404);
    }
    if (team.name === name) return;

    await assertTeamNameAvailable(tx, team.competition_id, name, team.id);
    const changed = await tx.run(
      `UPDATE teams SET name = ?, version = version + 1
       WHERE id = ? AND version = ? AND sandbox_owner_user_id IS NULL`,
      [name, team.id, team.version],
    );
    if (changed.changes !== 1) {
      throw new AppError(
        "ADMIN_CONFLICT",
        "The team changed while it was being renamed.",
        409,
      );
    }

    const actor = await getSessionUser(input.actorUserId);
    await tx.run(
      `INSERT INTO activity_events (
         id, competition_id, team_id, actor_user_id, type,
         title, detail, created_at
       ) VALUES (?, ?, ?, ?, 'TEAM_RENAMED', 'Team renamed', ?, ?)`,
      [
        randomUUID(),
        team.competition_id,
        team.id,
        input.actorUserId,
        `${actor?.name ?? "Host"} renamed ${team.name} to ${name}.`,
        new Date().toISOString(),
      ],
    );
  });

  return getAdminOverview(input.actorUserId);
}

export async function removeCompetitionTeam(
  input: RemoveCompetitionTeamInput,
): Promise<AdminOverview> {
  await requireHost(input.actorUserId);
  const db = await getDb();

  await db.transaction(async (tx) => {
    await acquireAdvisoryLock(tx, ADVISORY_LOCK_ACCOUNTS);
    await requireHost(input.actorUserId);
    const team = await tx.get<MutableTeamRow>(
      `SELECT id, competition_id, name, version
       FROM teams
       WHERE id = ? AND sandbox_owner_user_id IS NULL`,
      [input.teamId],
    );

    if (!team) {
      throw new AppError("TEAM_NOT_FOUND", "That team does not exist.", 404);
    }

    const memberCountRow = await tx.get<{ count: number }>(
      "SELECT COUNT(*) AS count FROM team_members WHERE team_id = ?",
      [team.id],
    );
    const memberCount = Number(memberCountRow?.count ?? 0);

    // Keep the immutable activity text for host audit, but detach it before
    // the team row is deleted so the foreign-key cascade cannot erase it.
    await tx.run("UPDATE activity_events SET team_id = NULL WHERE team_id = ?", [
      team.id,
    ]);
    // A team membership row is the assignment. Removing these rows leaves the
    // users intact and immediately blocks their team-scoped reads and trades.
    await tx.run("DELETE FROM team_members WHERE team_id = ?", [team.id]);
    const removed = await tx.run(
      `DELETE FROM teams
       WHERE id = ? AND version = ? AND sandbox_owner_user_id IS NULL`,
      [team.id, team.version],
    );
    if (removed.changes !== 1) {
      throw new AppError(
        "ADMIN_CONFLICT",
        "The team changed while it was being removed.",
        409,
      );
    }

    const actor = await getSessionUser(input.actorUserId);
    const memberSummary =
      memberCount === 0
        ? "no members were assigned"
        : memberCount === 1
          ? "1 member is now unassigned"
          : `${memberCount} members are now unassigned`;
    await tx.run(
      `INSERT INTO activity_events (
         id, competition_id, team_id, actor_user_id, type,
         title, detail, created_at
       ) VALUES (?, ?, NULL, ?, 'TEAM_REMOVED', 'Team removed', ?, ?)`,
      [
        randomUUID(),
        team.competition_id,
        input.actorUserId,
        `${actor?.name ?? "Host"} removed ${team.name}; ${memberSummary}.`,
        new Date().toISOString(),
      ],
    );

    // No ledger check: the team's ledger rows cascade-delete with the team
    // and no other team's cash or ledger is touched here.
  });

  return getAdminOverview(input.actorUserId);
}

export async function updateTeamStatus(
  input: UpdateTeamStatusInput,
): Promise<AdminOverview> {
  await requireHost(input.actorUserId);
  const status = normalizeTeamStatus(input.status);
  const db = await getDb();
  const competition = await getCompetitionSummary();
  const team = await getTeamSummary(input.teamId);

  if (team.status === status) {
    return getAdminOverview(input.actorUserId);
  }

  await db.transaction(async (tx) => {
    await acquireAdvisoryLock(tx, ADVISORY_LOCK_ACCOUNTS);
    await requireHost(input.actorUserId);
    const changed = await tx.run(
      `UPDATE teams SET status = ?, version = version + 1
       WHERE id = ? AND status = ? AND sandbox_owner_user_id IS NULL`,
      [status, input.teamId, team.status],
    );

    if (changed.changes !== 1) {
      throw new AppError(
        "ADMIN_CONFLICT",
        "The team changed while the update was being applied.",
        409,
      );
    }

    const actor = await getSessionUser(input.actorUserId);
    const createdAt = new Date().toISOString();
    await tx.run(
      `
        INSERT INTO activity_events (
          id, competition_id, team_id, actor_user_id, type,
          title, detail, created_at
        ) VALUES (?, ?, ?, ?, 'TEAM_STATUS_CHANGED', ?, ?, ?)
      `,
      [
        randomUUID(),
        competition.id,
        input.teamId,
        input.actorUserId,
        `${team.name} ${status}`,
        `${actor?.name ?? "Host"} changed ${team.name} from ${team.status} to ${status}.`,
        createdAt,
      ],
    );
  });

  return getAdminOverview(input.actorUserId);
}

export async function setTeamCash(input: SetTeamCashInput): Promise<AdminOverview> {
  await requireHost(input.actorUserId);
  const cashCents = normalizeCashCents(input.cashCents);
  const db = await getDb();

  await db.transaction(async (tx) => {
    await acquireAdvisoryLock(tx, ADVISORY_LOCK_ACCOUNTS);
    await requireHost(input.actorUserId);
    const team = await tx.get<CashTeamRow>(
      `
        SELECT id, competition_id, name, cash_cents, version
        FROM teams
        WHERE id = ? AND sandbox_owner_user_id IS NULL
      `,
      [input.teamId],
    );

    if (!team) {
      throw new AppError("TEAM_NOT_FOUND", "That team does not exist.", 404);
    }

    const previousCashCents = Number(team.cash_cents);
    if (previousCashCents === cashCents) {
      // No-op: commit without writing and fall through to the overview.
      return;
    }

    const changed = await tx.run(
      `
        UPDATE teams
        SET cash_cents = ?, version = version + 1
        WHERE id = ? AND version = ?
      `,
      [cashCents, team.id, team.version],
    );

    if (changed.changes !== 1) {
      throw new AppError(
        "ADMIN_CONFLICT",
        "The team changed while its cash balance was being updated.",
        409,
      );
    }

    const actor = await getSessionUser(input.actorUserId);
    const createdAt = new Date().toISOString();
    const adjustmentCents = cashCents - previousCashCents;
    await tx.run(
      `
        INSERT INTO ledger_entries (
          id, team_id, order_id, entry_type, amount_cents,
          symbol, quantity, note, created_at
        ) VALUES (?, ?, NULL, 'ADJUSTMENT', ?, NULL, NULL, ?, ?)
      `,
      [
        randomUUID(),
        team.id,
        adjustmentCents,
        `Host cash adjustment from ${formatCad(previousCashCents)} to ${formatCad(cashCents)}`,
        createdAt,
      ],
    );
    await tx.run(
      `
        INSERT INTO activity_events (
          id, competition_id, team_id, actor_user_id, type,
          title, detail, created_at
        ) VALUES (?, ?, ?, ?, 'TEAM_CASH_ADJUSTED', ?, ?, ?)
      `,
      [
        randomUUID(),
        team.competition_id,
        team.id,
        input.actorUserId,
        `${team.name} cash adjusted`,
        `${actor?.name ?? "Host"} changed ${team.name}'s cash from ${formatCad(previousCashCents)} to ${formatCad(cashCents)}.`,
        createdAt,
      ],
    );

    await assertTeamLedgerReconciles([team.id]);
  });

  return getAdminOverview(input.actorUserId);
}

/**
 * Sets how many shares (lots) of one symbol a team holds; 0 removes the
 * holding. Cash is untouched, so this is a grant or removal, not a trade.
 * An existing holding keeps its average cost; a new one starts at
 * `priceCadCents` so its gain begins at zero.
 */
export async function setTeamHolding(input: {
  actorUserId: string;
  teamId: string;
  symbol: string;
  quantity: number;
  priceCadCents: number;
}): Promise<void> {
  await requireHost(input.actorUserId);
  const db = await getDb();

  await db.transaction(async (tx) => {
    await acquireAdvisoryLock(tx, ADVISORY_LOCK_ACCOUNTS);
    await requireHost(input.actorUserId);
    const team = await tx.get<CashTeamRow>(
      `SELECT id, competition_id, name, cash_cents, version
       FROM teams WHERE id = ? AND sandbox_owner_user_id IS NULL`,
      [input.teamId],
    );
    if (!team) {
      throw new AppError("TEAM_NOT_FOUND", "That team does not exist.", 404);
    }

    const holding = await tx.get<{ quantity: number }>(
      "SELECT quantity FROM holdings WHERE team_id = ? AND symbol = ?",
      [team.id, input.symbol],
    );
    const previousQuantity = Number(holding?.quantity ?? 0);
    if (previousQuantity === input.quantity) return;

    const now = new Date().toISOString();
    if (input.quantity === 0) {
      await tx.run("DELETE FROM holdings WHERE team_id = ? AND symbol = ?", [
        team.id,
        input.symbol,
      ]);
    } else if (holding) {
      await tx.run(
        "UPDATE holdings SET quantity = ?, updated_at = ? WHERE team_id = ? AND symbol = ?",
        [input.quantity, now, team.id, input.symbol],
      );
    } else {
      await tx.run(
        `INSERT INTO holdings (team_id, symbol, quantity, average_cost_cents, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
        [team.id, input.symbol, input.quantity, input.priceCadCents, now],
      );
    }

    // Bumping the version makes any order racing this edit retry.
    const changed = await tx.run(
      "UPDATE teams SET version = version + 1 WHERE id = ? AND version = ?",
      [team.id, team.version],
    );
    if (changed.changes !== 1) {
      throw new AppError(
        "ADMIN_CONFLICT",
        "The team changed while its holdings were being updated.",
        409,
      );
    }

    const actor = await getSessionUser(input.actorUserId);
    await tx.run(
      `
        INSERT INTO activity_events (
          id, competition_id, team_id, actor_user_id, type,
          title, detail, created_at
        ) VALUES (?, ?, ?, ?, 'TEAM_HOLDING_ADJUSTED', ?, ?, ?)
      `,
      [
        randomUUID(),
        team.competition_id,
        team.id,
        input.actorUserId,
        `${team.name} ${input.symbol} adjusted`,
        `${actor?.name ?? "Host"} changed ${team.name}'s ${input.symbol} holding from ${previousQuantity} to ${input.quantity}.`,
        now,
      ],
    );
  });
}

export const ANNOUNCEMENT_TITLE_MAX_LENGTH = 80;
export const ANNOUNCEMENT_BODY_MAX_LENGTH = 500;

/** Posts (or replaces) the notice everyone sees above the trading room. */
export async function setAnnouncement(input: {
  actorUserId: string;
  title: string;
  body: string;
  tone: AnnouncementTone;
}): Promise<Announcement> {
  await requireHost(input.actorUserId);
  const title = input.title.replace(/\s+/g, " ").trim();
  const body = input.body.trim();
  if (!title || title.length > ANNOUNCEMENT_TITLE_MAX_LENGTH) {
    throw new AppError(
      "INVALID_ANNOUNCEMENT",
      `Give the announcement a title of up to ${ANNOUNCEMENT_TITLE_MAX_LENGTH} characters.`,
      400,
      { field: "title" },
    );
  }
  if (body.length > ANNOUNCEMENT_BODY_MAX_LENGTH) {
    throw new AppError(
      "INVALID_ANNOUNCEMENT",
      `Keep the message to ${ANNOUNCEMENT_BODY_MAX_LENGTH} characters or fewer.`,
      400,
      { field: "body" },
    );
  }
  if (input.tone !== "normal" && input.tone !== "urgent") {
    throw new AppError("INVALID_ANNOUNCEMENT", "Unknown tone.", 400, { field: "tone" });
  }

  const competition = await getCompetitionSummary();
  const db = await getDb();
  const createdAt = new Date().toISOString();
  await db.transaction(async (tx) => {
    await tx.run("DELETE FROM announcements WHERE competition_id = ?", [competition.id]);
    await tx.run(
      `INSERT INTO announcements (competition_id, title, body, tone, author_user_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [competition.id, title, body, input.tone, input.actorUserId, createdAt],
    );
    await tx.run(
      `
        INSERT INTO activity_events (
          id, competition_id, team_id, actor_user_id, type,
          title, detail, created_at
        ) VALUES (?, ?, NULL, ?, 'ANNOUNCEMENT_POSTED', ?, ?, ?)
      `,
      [randomUUID(), competition.id, input.actorUserId, title, body || title, createdAt],
    );
  });

  return (await getAnnouncement(competition.id))!;
}

export async function clearAnnouncement(actorUserId: string): Promise<void> {
  await requireHost(actorUserId);
  const competition = await getCompetitionSummary();
  const db = await getDb();
  await db.run("DELETE FROM announcements WHERE competition_id = ?", [competition.id]);
}

export async function setCompetitionStatus(
  input: UpdateCompetitionStatusInput,
): Promise<AdminOverview> {
  return updateCompetitionStatus(input);
}

/**
 * Applies a schedule/starting-cash change and a status change as one unit:
 * either both commit or neither does, so a failed status change can never
 * leave a half-applied update behind an error response.
 */
export async function updateCompetition(
  input: Omit<UpdateCompetitionScheduleInput, "actorUserId"> & {
    actorUserId: string;
    status?: CompetitionStatus;
  },
): Promise<AdminOverview> {
  const hasSchedule =
    input.startsAt !== undefined ||
    input.endsAt !== undefined ||
    input.startingCashCents !== undefined;

  if (!hasSchedule && input.status === undefined) {
    throw new AppError(
      "EMPTY_COMPETITION_UPDATE",
      "Provide a status or schedule change.",
      400,
    );
  }

  const db = await getDb();
  await db.transaction(async () => {
    if (hasSchedule) {
      await updateCompetitionSchedule({
        actorUserId: input.actorUserId,
        startsAt: input.startsAt,
        endsAt: input.endsAt,
        startingCashCents: input.startingCashCents,
      });
    }
    if (input.status !== undefined) {
      await updateCompetitionStatus({
        actorUserId: input.actorUserId,
        status: input.status,
      });
    }
  });
  return getAdminOverview(input.actorUserId);
}

export async function setTeamStatus(
  input: UpdateTeamStatusInput,
): Promise<AdminOverview> {
  return updateTeamStatus(input);
}

export async function resetPrototype(actorUserId: string): Promise<AdminOverview> {
  await requireHost(actorUserId);
  await resetPrototypeDatabase();
  return getAdminOverview(actorUserId);
}
