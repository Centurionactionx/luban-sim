import { randomUUID } from "node:crypto";

import type {
  AdminTradingCashResult,
  ResetAdminTradingAccountInput,
  SetAdminTradingCashInput,
} from "../contracts";
import { AppError } from "../errors";
import {
  ADVISORY_LOCK_ACCOUNTS,
  acquireAdvisoryLock,
  type DbExecutor,
} from "./database";
import { assertTeamLedgerReconciles, getDb } from "./db";

/** Same monetary ceiling as a competition team, expressed in integer cents. */
export const MAX_ADMIN_TRADING_CASH_CENTS = 100_000_000_000_000;

interface AdminActorRow {
  id: string;
  name: string;
  role: string;
  status: string;
}

interface AdminSandboxRow {
  id: string;
  competition_id: string;
  cash_cents: number;
  version: number;
}

async function requirePlatformAdminActor(
  executor: DbExecutor,
  actorUserId: string,
): Promise<AdminActorRow> {
  const normalizedId = actorUserId?.trim();
  if (!normalizedId) {
    throw new AppError("UNAUTHORIZED", "Sign in to continue.", 401);
  }

  const actor = await executor.get<AdminActorRow>(
    "SELECT id, name, role, status FROM users WHERE id = ?",
    [normalizedId],
  );
  if (!actor) {
    throw new AppError("UNAUTHORIZED", "Sign in to continue.", 401);
  }
  if (actor.status !== "active") {
    throw new AppError("ACCOUNT_SUSPENDED", "This account is suspended.", 403);
  }
  if (actor.role !== "platform_admin") {
    throw new AppError(
      "ADMIN_ONLY",
      "Only a platform administrator has a private test portfolio.",
      403,
    );
  }

  return actor;
}

function normalizeCashCents(value: unknown): number {
  if (
    !Number.isSafeInteger(value) ||
    Number(value) < 0 ||
    Number(value) > MAX_ADMIN_TRADING_CASH_CENTS
  ) {
    throw new AppError(
      "INVALID_CASH_BALANCE",
      "Cash must be a non-negative amount within the supported CAD limit.",
      400,
      { field: "cashCents", maximumCents: MAX_ADMIN_TRADING_CASH_CENTS },
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

/**
 * Resolves the caller's private simulator row without ever accepting a team
 * id from the browser. This deliberately returns null until the administrator
 * funds the account for the first time.
 */
export async function getAdminTradingTeamId(
  actorUserId: string,
  executor?: DbExecutor,
): Promise<string | null> {
  const db = executor ?? (await getDb());
  const actor = await requirePlatformAdminActor(db, actorUserId);
  const row = await db.get<{ id: string }>(
    `SELECT id
     FROM teams
     WHERE sandbox_owner_user_id = ?`,
    [actor.id],
  );
  return row?.id ?? null;
}

/**
 * Sets the authenticated administrator's exact private cash balance. First
 * funding creates an internal ledger account; later changes are adjustments.
 * The owner id always comes from the authenticated actor, never request data.
 */
export async function setAdminTradingCash(
  input: SetAdminTradingCashInput,
): Promise<AdminTradingCashResult> {
  const cashCents = normalizeCashCents(input.cashCents);
  const db = await getDb();

  return db.transaction(async (tx) => {
    // SQLite already serializes writers. PostgreSQL uses the same rare-account
    // lock as provisioning so two first-funding requests cannot create twins.
    await acquireAdvisoryLock(tx, ADVISORY_LOCK_ACCOUNTS);
    const actor = await requirePlatformAdminActor(tx, input.actorUserId);

    let sandbox = await tx.get<AdminSandboxRow>(
      `SELECT id, competition_id, cash_cents, version
       FROM teams
       WHERE sandbox_owner_user_id = ?`,
      [actor.id],
    );
    const createdAt = new Date().toISOString();
    let created = false;
    let cashChanged = false;

    if (!sandbox) {
      const competition = await tx.get<{ id: string }>(
        `SELECT id
         FROM competitions
         ORDER BY created_at DESC
         LIMIT 1`,
      );
      if (!competition) {
        throw new AppError(
          "COMPETITION_NOT_FOUND",
          "No simulator competition is configured.",
          404,
        );
      }

      const teamId = randomUUID();
      await tx.run(
        `INSERT INTO teams (
           id, competition_id, sandbox_owner_user_id, name, status,
           cash_cents, version, created_at
         ) VALUES (?, ?, ?, ?, 'active', ?, 0, ?)`,
        [
          teamId,
          competition.id,
          actor.id,
          `Admin test portfolio (${teamId.slice(0, 8)})`,
          cashCents,
          createdAt,
        ],
      );
      await tx.run(
        `INSERT INTO ledger_entries (
           id, team_id, order_id, entry_type, amount_cents,
           symbol, quantity, note, created_at
         ) VALUES (?, ?, NULL, 'STARTING_CASH', ?, NULL, NULL, ?, ?)`,
        [
          randomUUID(),
          teamId,
          cashCents,
          "Admin test portfolio starting cash",
          createdAt,
        ],
      );
      sandbox = {
        id: teamId,
        competition_id: competition.id,
        cash_cents: cashCents,
        version: 0,
      };
      created = true;
      cashChanged = true;
    } else if (Number(sandbox.cash_cents) !== cashCents) {
      const previousCashCents = Number(sandbox.cash_cents);
      const changed = await tx.run(
        `UPDATE teams
         SET cash_cents = ?, version = version + 1
         WHERE id = ? AND sandbox_owner_user_id = ? AND version = ?`,
        [cashCents, sandbox.id, actor.id, sandbox.version],
      );
      if (changed.changes !== 1) {
        throw new AppError(
          "PORTFOLIO_CONFLICT",
          "The test portfolio changed while its cash was being updated. Retry the request.",
          409,
        );
      }

      await tx.run(
        `INSERT INTO ledger_entries (
           id, team_id, order_id, entry_type, amount_cents,
           symbol, quantity, note, created_at
         ) VALUES (?, ?, NULL, 'ADJUSTMENT', ?, NULL, NULL, ?, ?)`,
        [
          randomUUID(),
          sandbox.id,
          cashCents - previousCashCents,
          `Admin cash adjustment from ${formatCad(previousCashCents)} to ${formatCad(cashCents)}`,
          createdAt,
        ],
      );
      sandbox = {
        ...sandbox,
        cash_cents: cashCents,
        version: Number(sandbox.version) + 1,
      };
      cashChanged = true;
    }

    if (cashChanged) {
      // Cash changes are private portfolio activity. Competition feeds filter
      // owner-marked teams, while the administrator's dashboard can show it.
      await tx.run(
        `INSERT INTO activity_events (
           id, competition_id, team_id, actor_user_id, type,
           title, detail, created_at
         ) VALUES (?, ?, ?, ?, 'TEAM_CASH_ADJUSTED', ?, ?, ?)`,
        [
          randomUUID(),
          sandbox.competition_id,
          sandbox.id,
          actor.id,
          "Admin test cash updated",
          `${actor.name} set private test cash to ${formatCad(cashCents)}.`,
          createdAt,
        ],
      );
    }

    await assertTeamLedgerReconciles([sandbox.id], tx);
    return {
      teamId: sandbox.id,
      cashCents: Number(sandbox.cash_cents),
      portfolioVersion: Number(sandbox.version),
      created,
    };
  });
}

/**
 * Empties the authenticated administrator's private test portfolio: every
 * holding, waiting order, fill, ledger row, value snapshot, and activity
 * entry goes, and it starts again with one starting-cash row. The cash is
 * the amount it was funded with unless a new amount is given. The watchlist
 * is kept. Competition teams can never be reset this way: the row is found
 * by its owner, the authenticated actor.
 */
export async function resetAdminTradingAccount(
  input: ResetAdminTradingAccountInput,
): Promise<AdminTradingCashResult> {
  const requestedCashCents =
    input.cashCents === undefined ? null : normalizeCashCents(input.cashCents);
  const db = await getDb();

  return db.transaction(async (tx) => {
    await acquireAdvisoryLock(tx, ADVISORY_LOCK_ACCOUNTS);
    const actor = await requirePlatformAdminActor(tx, input.actorUserId);
    const sandbox = await tx.get<AdminSandboxRow>(
      `SELECT id, competition_id, cash_cents, version
       FROM teams
       WHERE sandbox_owner_user_id = ?`,
      [actor.id],
    );
    if (!sandbox) {
      throw new AppError(
        "NO_TEST_PORTFOLIO",
        "Set your test cash first; there is no test portfolio to reset yet.",
        404,
      );
    }

    const funding = await tx.get<{ amount_cents: number }>(
      `SELECT COALESCE(SUM(amount_cents), 0) AS amount_cents
       FROM ledger_entries
       WHERE team_id = ? AND entry_type IN ('STARTING_CASH', 'ADJUSTMENT')`,
      [sandbox.id],
    );
    const cashCents =
      requestedCashCents ??
      Math.min(
        MAX_ADMIN_TRADING_CASH_CENTS,
        Math.max(0, Number(funding?.amount_cents ?? 0)),
      );

    // Bumping the version first makes any fill racing this reset fail its
    // own version check instead of landing on the emptied portfolio.
    const changed = await tx.run(
      `UPDATE teams
       SET cash_cents = ?, version = version + 1
       WHERE id = ? AND sandbox_owner_user_id = ? AND version = ?`,
      [cashCents, sandbox.id, actor.id, sandbox.version],
    );
    if (changed.changes !== 1) {
      throw new AppError(
        "PORTFOLIO_CONFLICT",
        "The test portfolio changed while it was being reset. Retry the request.",
        409,
      );
    }

    for (const table of [
      "working_orders",
      "ledger_entries",
      "orders",
      "holdings",
      "portfolio_snapshots",
      "activity_events",
    ]) {
      await tx.run(`DELETE FROM ${table} WHERE team_id = ?`, [sandbox.id]);
    }

    const createdAt = new Date().toISOString();
    await tx.run(
      `INSERT INTO ledger_entries (
         id, team_id, order_id, entry_type, amount_cents,
         symbol, quantity, note, created_at
       ) VALUES (?, ?, NULL, 'STARTING_CASH', ?, NULL, NULL, ?, ?)`,
      [
        randomUUID(),
        sandbox.id,
        cashCents,
        "Admin test portfolio reset",
        createdAt,
      ],
    );
    await tx.run(
      `INSERT INTO activity_events (
         id, competition_id, team_id, actor_user_id, type,
         title, detail, created_at
       ) VALUES (?, ?, ?, ?, 'TEAM_CASH_ADJUSTED', ?, ?, ?)`,
      [
        randomUUID(),
        sandbox.competition_id,
        sandbox.id,
        actor.id,
        "Admin test portfolio reset",
        `${actor.name} reset the private test portfolio to ${formatCad(cashCents)} cash.`,
        createdAt,
      ],
    );

    await assertTeamLedgerReconciles([sandbox.id], tx);
    return {
      teamId: sandbox.id,
      cashCents,
      portfolioVersion: Number(sandbox.version) + 1,
      created: false,
    };
  });
}
