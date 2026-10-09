import { createHash, randomBytes } from "node:crypto";

import type { DemoUser, SessionUser, UserRole, UserStatus } from "../contracts";
import { AppError } from "../errors";
import { getDb } from "./db";

export const SESSION_COOKIE_NAME = "luban_session";
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;

export interface SessionCookieOptions {
  httpOnly: true;
  sameSite: "lax";
  secure: boolean;
  path: "/";
  maxAge: number;
}

interface UserRow {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  status: UserStatus;
  team_id: string | null;
  team_name: string | null;
  name_pending?: boolean | number | null;
}

export const sessionCookieOptions: SessionCookieOptions = {
  httpOnly: true,
  sameSite: "lax",
  secure: process.env.NODE_ENV === "production",
  path: "/",
  maxAge: SESSION_TTL_SECONDS,
};

function initialsFor(name: string): string {
  return name
    .replace(/\([^)]*\)/g, "")
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}

function rowToSessionUser(row: UserRow): SessionUser {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    status: row.status,
    teamId: row.team_id,
    teamName: row.team_name,
    initials: initialsFor(row.name),
    ...(row.name_pending ? { needsDisplayName: true } : {}),
  };
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function getSessionUser(userId: string): Promise<SessionUser | null> {
  const db = await getDb();
  const row = await db.get<UserRow>(
    `
      SELECT
        u.id,
        u.name,
        u.email,
        u.role,
        u.status,
        tm.team_id,
        t.name AS team_name,
        EXISTS (
          SELECT 1 FROM pending_display_names p WHERE p.user_id = u.id
        ) AS name_pending
      FROM users u
      LEFT JOIN team_members tm ON tm.user_id = u.id
      LEFT JOIN teams t ON t.id = tm.team_id
      WHERE u.id = ?
    `,
    [userId],
  );

  return row ? rowToSessionUser(row) : null;
}

export async function listDemoUsers(): Promise<DemoUser[]> {
  // Only seeded demo identities are switchable. Accounts created through
  // managed sign-in carry an auth_subject and must never be listed or
  // assumable through the demo identity switcher, even if the same database
  // is later reopened in demo mode.
  const db = await getDb();
  const rows = await db.all<UserRow>(`
      SELECT
        u.id,
        u.name,
        u.email,
        u.role,
        u.status,
        tm.team_id,
        t.name AS team_name
      FROM users u
      LEFT JOIN team_members tm ON tm.user_id = u.id
      LEFT JOIN teams t ON t.id = tm.team_id
      WHERE u.auth_subject IS NULL AND u.status = 'active'
      ORDER BY CASE u.role WHEN 'student' THEN 0 ELSE 1 END, u.name ASC
    `);

  return rows.map((row) => {
    const user = rowToSessionUser(row);
    return {
      id: user.id,
      name: user.name,
      role: user.role,
      teamId: user.teamId,
      teamName: user.teamName,
      initials: user.initials,
    };
  });
}

export async function createSessionToken(
  userId: string,
  ttlSeconds = SESSION_TTL_SECONDS,
): Promise<string> {
  const user = await getSessionUser(userId);

  if (!user) {
    throw new AppError("USER_NOT_FOUND", "That demo user does not exist.", 404);
  }

  if (user.status !== "active") {
    throw new AppError("ACCOUNT_SUSPENDED", "This account is suspended.", 403);
  }

  const db = await getDb();
  const subjectRow = await db.get<{ auth_subject: string | null }>(
    "SELECT auth_subject FROM users WHERE id = ?",
    [userId],
  );

  if (subjectRow?.auth_subject) {
    throw new AppError(
      "DEMO_IDENTITY_REQUIRED",
      "Managed accounts sign in through the identity provider, not the demo switcher.",
      403,
    );
  }

  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 60) {
    throw new AppError(
      "INVALID_SESSION_TTL",
      "Session lifetime must be at least 60 seconds.",
      400,
    );
  }

  const token = randomBytes(32).toString("base64url");
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlSeconds * 1_000);

  await db.transaction(async (tx) => {
    await tx.run(
      "DELETE FROM sessions WHERE expires_at <= ? OR revoked_at IS NOT NULL",
      [now.toISOString()],
    );
    await tx.run(
      `
      INSERT INTO sessions (token_hash, user_id, expires_at, created_at, revoked_at)
      VALUES (?, ?, ?, ?, NULL)
    `,
      [hashToken(token), userId, expiresAt.toISOString(), now.toISOString()],
    );
  });

  return token;
}

export async function getSessionFromToken(
  token: string | null | undefined,
): Promise<SessionUser | null> {
  if (!token || token.length < 32 || token.length > 256) {
    return null;
  }

  const now = new Date().toISOString();
  const db = await getDb();
  const row = await db.get<UserRow>(
    `
      SELECT
        u.id,
        u.name,
        u.email,
        u.role,
        u.status,
        tm.team_id,
        t.name AS team_name
      FROM sessions s
      JOIN users u ON u.id = s.user_id
      LEFT JOIN team_members tm ON tm.user_id = u.id
      LEFT JOIN teams t ON t.id = tm.team_id
      WHERE s.token_hash = ?
        AND s.revoked_at IS NULL
        AND s.expires_at > ?
        AND u.status = 'active'
    `,
    [hashToken(token), now],
  );

  return row ? rowToSessionUser(row) : null;
}

export async function verifySessionToken(
  token: string | null | undefined,
): Promise<SessionUser | null> {
  return getSessionFromToken(token);
}

export async function invalidateSessionToken(
  token: string | null | undefined,
): Promise<void> {
  if (!token) {
    return;
  }

  const db = await getDb();
  await db.run("UPDATE sessions SET revoked_at = ? WHERE token_hash = ?", [
    new Date().toISOString(),
    hashToken(token),
  ]);
}

export function readSessionTokenFromCookieHeader(
  cookieHeader: string | null | undefined,
): string | null {
  if (!cookieHeader) {
    return null;
  }

  for (const segment of cookieHeader.split(";")) {
    const [rawName, ...rawValue] = segment.trim().split("=");

    if (rawName === SESSION_COOKIE_NAME) {
      try {
        return decodeURIComponent(rawValue.join("="));
      } catch {
        return null;
      }
    }
  }

  return null;
}

export function serializeSessionCookie(token: string): string {
  const secure = sessionCookieOptions.secure ? "; Secure" : "";
  return `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_SECONDS}${secure}`;
}

export function serializeClearedSessionCookie(): string {
  const secure = sessionCookieOptions.secure ? "; Secure" : "";
  return `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
}
