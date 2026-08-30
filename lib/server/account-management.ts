import { randomUUID } from "node:crypto";

import type { AccountView, SessionUser, UserRole, UserStatus } from "../contracts";
import { canHostCompetitions } from "../contracts";
import { AppError } from "../errors";
import { recordAuthAuditEvent } from "./audit";
import { getSessionUser } from "./auth";
import { getDb } from "./db";

/**
 * Admin user management. Rules that hold everywhere:
 * - Hosts see and manage students only; platform administrators manage all.
 * - Nobody acts on their own account.
 * - The last active platform administrator can never be suspended, demoted,
 *   or deleted — the deployment must always have a working admin.
 * - Deleting a user with trading history anonymizes instead: the team's
 *   ledger and order attribution stay intact while every personal
 *   identifier (name, email, sign-in link) is removed.
 */

interface AccountRow {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  status: UserStatus;
  auth_subject: string | null;
  created_at: string;
  last_login_at: string | null;
  team_id: string | null;
  team_name: string | null;
  order_count: number;
}

const ACCOUNT_SELECT = `
  SELECT
    u.id, u.name, u.email, u.role, u.status, u.auth_subject,
    u.created_at, u.last_login_at,
    tm.team_id, t.name AS team_name,
    (SELECT COUNT(*) FROM orders o WHERE o.actor_user_id = u.id) AS order_count
  FROM users u
  LEFT JOIN team_members tm ON tm.user_id = u.id
  LEFT JOIN teams t ON t.id = tm.team_id
`;

function rowToAccountView(row: AccountRow): AccountView {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    status: row.status as AccountView["status"],
    teamId: row.team_id,
    teamName: row.team_name,
    isManaged: row.auth_subject !== null,
    createdAt: row.created_at,
    lastLoginAt: row.last_login_at,
    orderCount: Number(row.order_count),
  };
}

async function requireAccountManager(actorUserId: string): Promise<SessionUser> {
  const actor = await getSessionUser(actorUserId);

  if (!actor) {
    throw new AppError("UNAUTHORIZED", "Sign in to continue.", 401);
  }

  if (actor.status !== "active") {
    throw new AppError("ACCOUNT_SUSPENDED", "This account is suspended.", 403);
  }

  if (!canHostCompetitions(actor.role)) {
    throw new AppError(
      "HOST_REQUIRED",
      "Only hosts and platform administrators manage accounts.",
      403,
    );
  }

  return actor;
}

function assertActorMayTouch(actor: SessionUser, target: AccountRow): void {
  if (target.id === actor.id) {
    throw new AppError(
      "SELF_ACTION_FORBIDDEN",
      "You cannot change your own account from here.",
      400,
    );
  }

  if (actor.role !== "platform_admin" && target.role !== "student") {
    throw new AppError(
      "ADMIN_REQUIRED",
      "Only a platform administrator can manage host or administrator accounts.",
      403,
    );
  }
}

async function loadTarget(
  tx: { get: <T>(sql: string, params?: unknown[]) => Promise<T | undefined> },
  userId: string,
): Promise<AccountRow> {
  const row = await tx.get<AccountRow>(`${ACCOUNT_SELECT} WHERE u.id = ?`, [
    userId,
  ]);

  if (!row || row.status === "deleted") {
    throw new AppError("USER_NOT_FOUND", "That account does not exist.", 404);
  }

  return row;
}

/**
 * Throws unless at least one OTHER active platform administrator remains
 * after removing `target` from the pool.
 */
async function assertNotLastAdmin(
  tx: { get: <T>(sql: string, params?: unknown[]) => Promise<T | undefined> },
  target: AccountRow,
): Promise<void> {
  if (target.role !== "platform_admin" || target.status !== "active") {
    return;
  }

  const others = await tx.get<{ count: number }>(
    `SELECT COUNT(*) AS count
     FROM users
     WHERE role = 'platform_admin' AND status = 'active' AND id != ?`,
    [target.id],
  );

  if (Number(others?.count ?? 0) === 0) {
    throw new AppError(
      "LAST_ADMIN_PROTECTED",
      "This is the only active platform administrator. Add another administrator first.",
      409,
    );
  }
}

export async function listAccounts(actorUserId: string): Promise<AccountView[]> {
  const actor = await requireAccountManager(actorUserId);
  const db = await getDb();
  const studentFilter =
    actor.role !== "platform_admin" ? "AND u.role = 'student'" : "";

  const rows = await db.all<AccountRow>(`
    ${ACCOUNT_SELECT}
    WHERE u.status != 'deleted' ${studentFilter}
    ORDER BY
      CASE u.role WHEN 'platform_admin' THEN 0 WHEN 'host' THEN 1 ELSE 2 END,
      u.name ASC
  `);

  return rows.map(rowToAccountView);
}

export async function setAccountStatus(
  actorUserId: string,
  userId: string,
  status: "active" | "suspended",
): Promise<AccountView> {
  const actor = await requireAccountManager(actorUserId);
  const db = await getDb();

  await db.transaction(async (tx) => {
    const target = await loadTarget(tx, userId);
    assertActorMayTouch(actor, target);

    if (target.status === status) {
      return;
    }

    if (status === "suspended") {
      await assertNotLastAdmin(tx, target);
    }

    await tx.run("UPDATE users SET status = ? WHERE id = ?", [status, userId]);

    await recordAuthAuditEvent({
      type: status === "suspended" ? "ACCOUNT_SUSPENDED" : "ACCOUNT_RESTORED",
      actorUserId: actor.id,
      subjectUserId: userId,
      detail: `${actor.name} ${status === "suspended" ? "suspended" : "restored"} ${target.name}'s account.`,
    });
  });

  
  const row = await db.get<AccountRow>(`${ACCOUNT_SELECT} WHERE u.id = ?`, [
    userId,
  ]);
  return rowToAccountView(row as AccountRow);
}

export async function setAccountRole(
  actorUserId: string,
  userId: string,
  role: UserRole,
): Promise<AccountView> {
  const actor = await requireAccountManager(actorUserId);

  if (actor.role !== "platform_admin") {
    throw new AppError(
      "ADMIN_REQUIRED",
      "Only a platform administrator can change roles.",
      403,
    );
  }

  if (!["student", "host", "platform_admin"].includes(role)) {
    throw new AppError("INVALID_ROLE", "Unknown role.", 400, { field: "role" });
  }

  const db = await getDb();

  await db.transaction(async (tx) => {
    const target = await loadTarget(tx, userId);
    assertActorMayTouch(actor, target);

    if (target.role === role) {
      return;
    }

    if (target.role === "platform_admin") {
      await assertNotLastAdmin(tx, target);
    }

    await tx.run("UPDATE users SET role = ? WHERE id = ?", [role, userId]);

    // Hosts and administrators do not sit on trading teams.
    if (role !== "student" && target.team_id) {
      await tx.run("DELETE FROM team_members WHERE user_id = ?", [userId]);
    }

    await recordAuthAuditEvent({
      type: "ACCOUNT_ROLE_CHANGED",
      actorUserId: actor.id,
      subjectUserId: userId,
      detail: `${actor.name} changed ${target.name}'s role from ${target.role} to ${role}.`,
      metadata: { from: target.role, to: role },
    });
  });

  
  const row = await db.get<AccountRow>(`${ACCOUNT_SELECT} WHERE u.id = ?`, [
    userId,
  ]);
  return rowToAccountView(row as AccountRow);
}

export async function setAccountTeam(
  actorUserId: string,
  userId: string,
  teamId: string | null,
): Promise<AccountView> {
  const actor = await requireAccountManager(actorUserId);
  const db = await getDb();

  await db.transaction(async (tx) => {
    const target = await loadTarget(tx, userId);
    assertActorMayTouch(actor, target);

    if (target.role !== "student") {
      throw new AppError(
        "STUDENTS_ONLY",
        "Only student accounts belong to teams.",
        400,
      );
    }

    if (target.team_id === teamId) {
      return;
    }

    let teamName: string | null = null;
    let competitionId: string | null = null;

    if (teamId) {
      const team = await tx.get<{
        id: string;
        name: string;
        competition_id: string;
      }>("SELECT id, name, competition_id FROM teams WHERE id = ?", [teamId]);

      if (!team) {
        throw new AppError("TEAM_NOT_FOUND", "That team does not exist.", 404, {
          field: "teamId",
        });
      }

      teamName = team.name;
      competitionId = team.competition_id;
    }

    await tx.run("DELETE FROM team_members WHERE user_id = ?", [userId]);

    const nowIso = new Date().toISOString();

    if (teamId) {
      await tx.run(
        `INSERT INTO team_members (team_id, user_id, is_captain, joined_at)
         VALUES (?, ?, 0, ?)`,
        [teamId, userId, nowIso],
      );

      if (competitionId) {
        await tx.run(
          `INSERT INTO activity_events (
             id, competition_id, team_id, actor_user_id, type,
             title, detail, created_at
           ) VALUES (?, ?, ?, ?, 'MEMBER_JOINED', ?, ?, ?)`,
          [
            randomUUID(),
            competitionId,
            teamId,
            userId,
            `${target.name} joined ${teamName}`,
            `${actor.name} placed ${target.name} on ${teamName}.`,
            nowIso,
          ],
        );
      }
    }

    await recordAuthAuditEvent({
      type: "ACCOUNT_TEAM_CHANGED",
      actorUserId: actor.id,
      subjectUserId: userId,
      detail: teamId
        ? `${actor.name} moved ${target.name} to ${teamName}.`
        : `${actor.name} removed ${target.name} from their team.`,
      metadata: { from: target.team_id, to: teamId },
    });
  });

  
  const row = await db.get<AccountRow>(`${ACCOUNT_SELECT} WHERE u.id = ?`, [
    userId,
  ]);
  return rowToAccountView(row as AccountRow);
}

export interface DeleteAccountResult {
  id: string;
  mode: "deleted" | "anonymized";
}

export async function deleteAccount(
  actorUserId: string,
  userId: string,
): Promise<DeleteAccountResult> {
  const actor = await requireAccountManager(actorUserId);

  if (actor.role !== "platform_admin") {
    throw new AppError(
      "ADMIN_REQUIRED",
      "Only a platform administrator can delete accounts.",
      403,
    );
  }

  const db = await getDb();

  return db.transaction(async (tx) => {
    const target = await loadTarget(tx, userId);
    assertActorMayTouch(actor, target);
    await assertNotLastAdmin(tx, target);

    if (Number(target.order_count) === 0) {
      // No trading history: the row can go entirely. The audit entry is
      // written first; its subject reference becomes NULL on delete while
      // the detail keeps the human-readable record.
      await recordAuthAuditEvent({
        type: "ACCOUNT_DELETED",
        actorUserId: actor.id,
        subjectUserId: null,
        detail: `${actor.name} deleted ${target.name}'s account (${target.email}).`,
        metadata: { mode: "deleted", role: target.role },
      });

      await tx.run("DELETE FROM users WHERE id = ?", [userId]);

      return { id: userId, mode: "deleted" as const };
    }

    // Trading history exists: the ledger and order attribution must stay
    // coherent, so the person is anonymized instead — identity gone,
    // sign-in unlinked, seat freed.
    await tx.run(
      `UPDATE users
       SET name = 'Deleted user',
           email = ?,
           status = 'deleted',
           auth_subject = NULL,
           email_verified_at = NULL,
           last_login_at = NULL
       WHERE id = ?`,
      [`deleted-${userId}@users.luban.invalid`, userId],
    );
    await tx.run("DELETE FROM team_members WHERE user_id = ?", [userId]);
    await tx.run("DELETE FROM sessions WHERE user_id = ?", [userId]);

    await recordAuthAuditEvent({
      type: "ACCOUNT_DELETED",
      actorUserId: actor.id,
      subjectUserId: userId,
      detail: `${actor.name} deleted ${target.name}'s account (anonymized; trading history retained).`,
      metadata: { mode: "anonymized", role: target.role },
    });

    return { id: userId, mode: "anonymized" as const };
  });
}
