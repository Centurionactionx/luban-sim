import { createHash, randomBytes, randomUUID } from "node:crypto";

import type {
  CreateInvitationInput,
  CreatedInvitation,
  InvitationPreview,
  InvitationState,
  InvitationSummary,
  SessionUser,
  UserRole,
} from "../contracts";
import { canHostCompetitions } from "../contracts";
import { AppError } from "../errors";
import { recordAuthAuditEvent } from "./audit";
import { getSessionUser } from "./auth";
import { getDatabase } from "./db";

export const DEFAULT_INVITATION_TTL_HOURS = 72;
export const MIN_INVITATION_TTL_HOURS = 1;
export const MAX_INVITATION_TTL_HOURS = 24 * 14;
const MAX_ACTIVE_INVITATIONS = 500;
const INVITATION_ROLES: readonly UserRole[] = ["student", "host", "platform_admin"];

/** Identity attributes asserted by the managed identity provider. */
export interface ManagedIdentity {
  subject: string;
  email: string;
  emailVerified: boolean;
  name: string | null;
}

interface InvitationRow {
  id: string;
  role: UserRole;
  email: string | null;
  invited_name: string | null;
  team_id: string | null;
  team_name: string | null;
  competition_id: string | null;
  created_by: string | null;
  created_by_name: string | null;
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
  used_at: string | null;
  used_by: string | null;
  used_by_name: string | null;
}

const INVITATION_SELECT = `
  SELECT
    i.id,
    i.role,
    i.email,
    i.invited_name,
    i.team_id,
    t.name AS team_name,
    i.competition_id,
    i.created_by,
    creator.name AS created_by_name,
    i.created_at,
    i.expires_at,
    i.revoked_at,
    i.used_at,
    i.used_by,
    redeemer.name AS used_by_name
  FROM account_invitations i
  LEFT JOIN teams t ON t.id = i.team_id
  LEFT JOIN users creator ON creator.id = i.created_by
  LEFT JOIN users redeemer ON redeemer.id = i.used_by
`;

function hashInvitationToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function invitationStateFor(
  row: Pick<InvitationRow, "used_at" | "revoked_at" | "expires_at">,
  nowIso: string,
): InvitationState {
  if (row.used_at) return "used";
  if (row.revoked_at) return "revoked";
  if (row.expires_at <= nowIso) return "expired";
  return "active";
}

function rowToSummary(row: InvitationRow, nowIso: string): InvitationSummary {
  return {
    id: row.id,
    role: row.role,
    state: invitationStateFor(row, nowIso),
    email: row.email,
    invitedName: row.invited_name,
    teamId: row.team_id,
    teamName: row.team_name,
    competitionId: row.competition_id,
    createdByName: row.created_by_name,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    usedAt: row.used_at,
    usedByName: row.used_by_name,
  };
}

function normalizeEmail(value: string | null | undefined): string | null {
  const trimmed = value?.trim().toLowerCase() ?? "";

  if (!trimmed) {
    return null;
  }

  if (
    trimmed.length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)
  ) {
    throw new AppError(
      "INVALID_INVITATION_EMAIL",
      "Enter a valid email address for the invitation.",
      400,
      { field: "email" },
    );
  }

  return trimmed;
}

function normalizeInvitedName(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";

  if (!trimmed) {
    return null;
  }

  if (trimmed.length > 80) {
    throw new AppError(
      "INVALID_INVITED_NAME",
      "Invited names are limited to 80 characters.",
      400,
      { field: "invitedName" },
    );
  }

  return trimmed;
}

function normalizeTtlHours(value: number | undefined): number {
  if (value === undefined) {
    return DEFAULT_INVITATION_TTL_HOURS;
  }

  if (
    !Number.isSafeInteger(value) ||
    value < MIN_INVITATION_TTL_HOURS ||
    value > MAX_INVITATION_TTL_HOURS
  ) {
    throw new AppError(
      "INVALID_INVITATION_TTL",
      `Invitation lifetimes must be between ${MIN_INVITATION_TTL_HOURS} and ${MAX_INVITATION_TTL_HOURS} hours.`,
      400,
      { field: "expiresInHours" },
    );
  }

  return value;
}

function requireInvitationManager(actorUserId: string): SessionUser {
  const actor = getSessionUser(actorUserId);

  if (!actor) {
    throw new AppError("UNAUTHORIZED", "Sign in to continue.", 401);
  }

  if (actor.status !== "active") {
    throw new AppError(
      "ACCOUNT_SUSPENDED",
      "This account is suspended.",
      403,
    );
  }

  if (!canHostCompetitions(actor.role)) {
    throw new AppError(
      "HOST_REQUIRED",
      "Only hosts and platform administrators manage invitations.",
      403,
    );
  }

  return actor;
}

function assertActorMayIssueRole(actorRole: UserRole, inviteRole: UserRole): void {
  if (!INVITATION_ROLES.includes(inviteRole)) {
    throw new AppError(
      "INVALID_INVITATION_ROLE",
      "Invitations must be for a student, host, or platform administrator.",
      400,
      { field: "role" },
    );
  }

  if (actorRole !== "platform_admin" && inviteRole !== "student") {
    throw new AppError(
      "ADMIN_REQUIRED",
      "Only a platform administrator can invite hosts or administrators.",
      403,
      { field: "role" },
    );
  }
}

interface InsertInvitationParams {
  role: UserRole;
  email: string | null;
  invitedName: string | null;
  teamId: string | null;
  createdBy: string | null;
  createdByLabel: string;
  ttlHours: number;
}

function insertInvitation(params: InsertInvitationParams): CreatedInvitation {
  const database = getDatabase();
  const now = new Date();
  const nowIso = now.toISOString();
  const expiresAt = new Date(
    now.getTime() + params.ttlHours * 3_600_000,
  ).toISOString();
  const token = randomBytes(32).toString("base64url");
  const id = randomUUID();

  database.exec("BEGIN IMMEDIATE;");

  try {
    let competitionId: string | null = null;

    if (params.role === "student") {
      if (!params.teamId) {
        throw new AppError(
          "INVITATION_TEAM_REQUIRED",
          "Student invitations must name the team the student will join.",
          400,
          { field: "teamId" },
        );
      }

      const team = database
        .prepare("SELECT id, competition_id, status FROM teams WHERE id = ?")
        .get(params.teamId) as
        | { id: string; competition_id: string; status: string }
        | undefined;

      if (!team) {
        throw new AppError("TEAM_NOT_FOUND", "That team does not exist.", 404, {
          field: "teamId",
        });
      }

      competitionId = team.competition_id;
    } else if (params.teamId) {
      throw new AppError(
        "INVITATION_TEAM_FORBIDDEN",
        "Only student invitations are tied to a team.",
        400,
        { field: "teamId" },
      );
    }

    const activeCount = database
      .prepare(`
        SELECT COUNT(*) AS count
        FROM account_invitations
        WHERE used_at IS NULL AND revoked_at IS NULL AND expires_at > ?
      `)
      .get(nowIso) as { count: number };

    if (Number(activeCount.count) >= MAX_ACTIVE_INVITATIONS) {
      throw new AppError(
        "TOO_MANY_INVITATIONS",
        "Revoke unused invitations before creating more.",
        429,
      );
    }

    database
      .prepare(`
        INSERT INTO account_invitations (
          id, token_hash, role, email, invited_name, team_id, competition_id,
          created_by, created_at, expires_at, revoked_at, used_at, used_by
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)
      `)
      .run(
        id,
        hashInvitationToken(token),
        params.role,
        params.email,
        params.invitedName,
        params.role === "student" ? params.teamId : null,
        competitionId,
        params.createdBy,
        nowIso,
        expiresAt,
      );

    recordAuthAuditEvent({
      type: "INVITATION_CREATED",
      actorUserId: params.createdBy,
      detail: `${params.createdByLabel} created a ${params.role} invitation${
        params.email ? ` locked to ${params.email}` : ""
      }.`,
      metadata: {
        invitationId: id,
        role: params.role,
        teamId: params.role === "student" ? params.teamId : null,
        expiresAt,
      },
    });

    database.exec("COMMIT;");
  } catch (error) {
    try {
      database.exec("ROLLBACK;");
    } catch {
      // Preserve the domain error that caused the rollback.
    }
    throw error;
  }

  const row = database
    .prepare(`${INVITATION_SELECT} WHERE i.id = ?`)
    .get(id) as InvitationRow | undefined;

  if (!row) {
    throw new AppError("INVITATION_NOT_FOUND", "The invitation vanished.", 500);
  }

  return {
    invitation: rowToSummary(row, nowIso),
    token,
    joinPath: `/join/${token}`,
  };
}

export function createInvitation(input: CreateInvitationInput): CreatedInvitation {
  const actor = requireInvitationManager(input.actorUserId);
  assertActorMayIssueRole(actor.role, input.role);

  return insertInvitation({
    role: input.role,
    email: normalizeEmail(input.email),
    invitedName: normalizeInvitedName(input.invitedName),
    teamId: input.teamId?.trim() || null,
    createdBy: actor.id,
    createdByLabel: actor.name,
    ttlHours: normalizeTtlHours(input.expiresInHours),
  });
}

/**
 * Out-of-band bootstrap path used by the deployment operator, not by any HTTP
 * route: mints the first platform_admin invitation without an acting user.
 */
export function createSystemAdminInvitation(options: {
  email?: string | null;
  invitedName?: string | null;
  expiresInHours?: number;
} = {}): CreatedInvitation {
  return insertInvitation({
    role: "platform_admin",
    email: normalizeEmail(options.email),
    invitedName: normalizeInvitedName(options.invitedName),
    teamId: null,
    createdBy: null,
    createdByLabel: "The deployment operator",
    ttlHours: normalizeTtlHours(options.expiresInHours),
  });
}

export function listInvitations(actorUserId: string): InvitationSummary[] {
  const actor = requireInvitationManager(actorUserId);
  const nowIso = new Date().toISOString();
  const roleFilter =
    actor.role !== "platform_admin" ? "AND i.role = 'student'" : "";

  // Every still-active invitation must be listed — the list is the only
  // place its id (and therefore the revoke control) is exposed, so a cap
  // here would make older active invitations effectively irrevocable.
  // Consumed history is capped instead.
  const activeRows = getDatabase()
    .prepare(`
      ${INVITATION_SELECT}
      WHERE i.used_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > ?
        ${roleFilter}
      ORDER BY i.created_at DESC, i.id DESC
    `)
    .all(nowIso) as unknown as InvitationRow[];

  const historyRows = getDatabase()
    .prepare(`
      ${INVITATION_SELECT}
      WHERE (i.used_at IS NOT NULL OR i.revoked_at IS NOT NULL OR i.expires_at <= ?)
        ${roleFilter}
      ORDER BY i.created_at DESC, i.id DESC
      LIMIT 200
    `)
    .all(nowIso) as unknown as InvitationRow[];

  return [...activeRows, ...historyRows]
    .sort((a, b) =>
      a.created_at === b.created_at
        ? a.id < b.id
          ? 1
          : -1
        : a.created_at < b.created_at
          ? 1
          : -1,
    )
    .map((row) => rowToSummary(row, nowIso));
}

export function revokeInvitation(
  actorUserId: string,
  invitationId: string,
): InvitationSummary {
  const actor = requireInvitationManager(actorUserId);
  const database = getDatabase();
  const nowIso = new Date().toISOString();

  database.exec("BEGIN IMMEDIATE;");

  try {
    const row = database
      .prepare(`${INVITATION_SELECT} WHERE i.id = ?`)
      .get(invitationId) as InvitationRow | undefined;

    if (!row) {
      throw new AppError(
        "INVITATION_NOT_FOUND",
        "That invitation does not exist.",
        404,
      );
    }

    if (actor.role !== "platform_admin" && row.role !== "student") {
      throw new AppError(
        "ADMIN_REQUIRED",
        "Only a platform administrator can revoke host or administrator invitations.",
        403,
      );
    }

    const state = invitationStateFor(row, nowIso);

    if (state === "used") {
      throw new AppError(
        "INVITATION_ALREADY_USED",
        "That invitation has already been accepted; suspend the account instead.",
        409,
      );
    }

    if (state !== "revoked") {
      database
        .prepare(
          "UPDATE account_invitations SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL AND used_at IS NULL",
        )
        .run(nowIso, invitationId);

      recordAuthAuditEvent({
        type: "INVITATION_REVOKED",
        actorUserId: actor.id,
        detail: `${actor.name} revoked a ${row.role} invitation.`,
        metadata: { invitationId, role: row.role },
      });
    }

    database.exec("COMMIT;");
  } catch (error) {
    try {
      database.exec("ROLLBACK;");
    } catch {
      // Preserve the domain error that caused the rollback.
    }
    throw error;
  }

  const updated = getDatabase()
    .prepare(`${INVITATION_SELECT} WHERE i.id = ?`)
    .get(invitationId) as InvitationRow | undefined;

  if (!updated) {
    throw new AppError(
      "INVITATION_NOT_FOUND",
      "That invitation does not exist.",
      404,
    );
  }

  return rowToSummary(updated, nowIso);
}

function maskEmail(email: string | null): string | null {
  if (!email) {
    return null;
  }

  const [localPart, domain] = email.split("@");
  const safeLocal = localPart.slice(0, 2);
  return `${safeLocal}${"•".repeat(Math.max(localPart.length - 2, 1))}@${domain}`;
}

/**
 * Read-only lookup for the public /join page. Reveals only what the visitor
 * needs to decide whether to register; the token itself proves possession.
 */
export function previewInvitation(token: string): InvitationPreview | null {
  if (!token || token.length < 20 || token.length > 256) {
    return null;
  }

  const nowIso = new Date().toISOString();
  const row = getDatabase()
    .prepare(`${INVITATION_SELECT} WHERE i.token_hash = ?`)
    .get(hashInvitationToken(token)) as InvitationRow | undefined;

  if (!row) {
    return null;
  }

  const competition = row.competition_id
    ? (getDatabase()
        .prepare("SELECT name FROM competitions WHERE id = ?")
        .get(row.competition_id) as { name: string } | undefined)
    : undefined;

  return {
    state: invitationStateFor(row, nowIso),
    role: row.role,
    invitedName: row.invited_name,
    maskedEmail: maskEmail(row.email),
    teamName: row.team_name,
    competitionName: competition?.name ?? null,
    expiresAt: row.expires_at,
  };
}

/**
 * Registers a managed-identity user through a single-use invitation. The
 * entire check-create-consume sequence runs in one immediate transaction, so
 * two concurrent redemptions of the same token cannot both succeed.
 */
export function consumeInvitation(
  token: string,
  identity: ManagedIdentity,
): SessionUser {
  const subject = identity.subject?.trim();
  const email = normalizeEmail(identity.email);

  if (!subject) {
    throw new AppError(
      "INVALID_IDENTITY",
      "The identity provider did not supply a subject identifier.",
      400,
    );
  }

  if (!email) {
    throw new AppError(
      "INVALID_IDENTITY",
      "The identity provider did not supply an email address.",
      400,
    );
  }

  if (!identity.emailVerified) {
    throw new AppError(
      "EMAIL_NOT_VERIFIED",
      "Verify your email address before accepting an invitation.",
      403,
    );
  }

  if (!token || token.length < 20 || token.length > 256) {
    throw new AppError(
      "INVITATION_INVALID",
      "This invitation link is not valid.",
      404,
    );
  }

  const database = getDatabase();
  const nowIso = new Date().toISOString();
  let userId: string;

  database.exec("BEGIN IMMEDIATE;");

  try {
    const row = database
      .prepare(`${INVITATION_SELECT} WHERE i.token_hash = ?`)
      .get(hashInvitationToken(token)) as InvitationRow | undefined;

    if (!row) {
      throw new AppError(
        "INVITATION_INVALID",
        "This invitation link is not valid.",
        404,
      );
    }

    const state = invitationStateFor(row, nowIso);

    if (state === "used") {
      throw new AppError(
        "INVITATION_ALREADY_USED",
        "This invitation has already been used.",
        409,
      );
    }

    if (state === "revoked") {
      throw new AppError(
        "INVITATION_REVOKED",
        "This invitation was revoked. Ask your host for a new one.",
        410,
      );
    }

    if (state === "expired") {
      throw new AppError(
        "INVITATION_EXPIRED",
        "This invitation expired. Ask your host for a new one.",
        410,
      );
    }

    if (row.email && row.email !== email) {
      throw new AppError(
        "INVITATION_EMAIL_MISMATCH",
        "This invitation was issued to a different email address.",
        403,
      );
    }

    const existingBySubject = database
      .prepare("SELECT id FROM users WHERE auth_subject = ?")
      .get(subject) as { id: string } | undefined;

    if (existingBySubject) {
      throw new AppError(
        "ALREADY_REGISTERED",
        "This sign-in is already linked to a Luban account.",
        409,
      );
    }

    const existingByEmail = database
      .prepare("SELECT id FROM users WHERE lower(email) = ?")
      .get(email) as { id: string } | undefined;

    if (existingByEmail) {
      throw new AppError(
        "EMAIL_IN_USE",
        "An account with this email address already exists.",
        409,
      );
    }

    if (row.role === "student" && !row.team_id) {
      throw new AppError(
        "INVITATION_TEAM_MISSING",
        "The team for this invitation no longer exists. Ask your host for a new invitation.",
        409,
      );
    }

    userId = randomUUID();
    const displayName =
      identity.name?.trim() || row.invited_name || email.split("@")[0];

    database
      .prepare(`
        INSERT INTO users (
          id, name, email, role, status, auth_subject,
          email_verified_at, created_at, last_login_at
        ) VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?)
      `)
      .run(userId, displayName, email, row.role, subject, nowIso, nowIso, nowIso);

    if (row.role === "student" && row.team_id) {
      database
        .prepare(`
          INSERT INTO team_members (team_id, user_id, is_captain, joined_at)
          VALUES (?, ?, 0, ?)
        `)
        .run(row.team_id, userId, nowIso);

      if (row.competition_id) {
        database
          .prepare(`
            INSERT INTO activity_events (
              id, competition_id, team_id, actor_user_id, type,
              title, detail, created_at
            ) VALUES (?, ?, ?, ?, 'MEMBER_JOINED', ?, ?, ?)
          `)
          .run(
            randomUUID(),
            row.competition_id,
            row.team_id,
            userId,
            `${displayName} joined ${row.team_name ?? "the team"}`,
            `${displayName} accepted an invitation and joined ${row.team_name ?? "the team"}.`,
            nowIso,
          );
      }
    }

    const consumed = database
      .prepare(
        "UPDATE account_invitations SET used_at = ?, used_by = ? WHERE id = ? AND used_at IS NULL AND revoked_at IS NULL",
      )
      .run(nowIso, userId, row.id);

    if (Number(consumed.changes) !== 1) {
      throw new AppError(
        "INVITATION_ALREADY_USED",
        "This invitation has already been used.",
        409,
      );
    }

    recordAuthAuditEvent({
      type: "INVITATION_ACCEPTED",
      actorUserId: userId,
      subjectUserId: userId,
      detail: `${displayName} accepted a ${row.role} invitation.`,
      metadata: { invitationId: row.id, role: row.role, teamId: row.team_id },
    });
    recordAuthAuditEvent({
      type: "ACCOUNT_CREATED",
      actorUserId: userId,
      subjectUserId: userId,
      detail: `A ${row.role} account was created for ${displayName} through an invitation.`,
      metadata: { invitationId: row.id, role: row.role },
    });

    database.exec("COMMIT;");
  } catch (error) {
    try {
      database.exec("ROLLBACK;");
    } catch {
      // Preserve the domain error that caused the rollback.
    }
    throw error;
  }

  const user = getSessionUser(userId);

  if (!user) {
    throw new AppError(
      "ACCOUNT_CREATION_FAILED",
      "The new account could not be read back.",
      500,
    );
  }

  return user;
}
