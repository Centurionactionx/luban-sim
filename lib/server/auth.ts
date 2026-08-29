import { createHash, randomBytes } from "node:crypto";

import type { DemoUser, SessionUser, UserRole } from "../contracts";
import { AppError } from "../errors";
import { getDatabase } from "./db";

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
  team_id: string | null;
  team_name: string | null;
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
    teamId: row.team_id,
    teamName: row.team_name,
    initials: initialsFor(row.name),
  };
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function getSessionUser(userId: string): SessionUser | null {
  const row = getDatabase()
    .prepare(`
      SELECT
        u.id,
        u.name,
        u.email,
        u.role,
        tm.team_id,
        t.name AS team_name
      FROM users u
      LEFT JOIN team_members tm ON tm.user_id = u.id
      LEFT JOIN teams t ON t.id = tm.team_id
      WHERE u.id = ?
    `)
    .get(userId) as UserRow | undefined;

  return row ? rowToSessionUser(row) : null;
}

export function listDemoUsers(): DemoUser[] {
  const rows = getDatabase()
    .prepare(`
      SELECT
        u.id,
        u.name,
        u.email,
        u.role,
        tm.team_id,
        t.name AS team_name
      FROM users u
      LEFT JOIN team_members tm ON tm.user_id = u.id
      LEFT JOIN teams t ON t.id = tm.team_id
      ORDER BY CASE u.role WHEN 'student' THEN 0 ELSE 1 END, u.name ASC
    `)
    .all() as unknown as UserRow[];

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

export function createSessionToken(
  userId: string,
  ttlSeconds = SESSION_TTL_SECONDS,
): string {
  const user = getSessionUser(userId);

  if (!user) {
    throw new AppError("USER_NOT_FOUND", "That demo user does not exist.", 404);
  }

  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 60) {
    throw new AppError(
      "INVALID_SESSION_TTL",
      "Session lifetime must be at least 60 seconds.",
      400,
    );
  }

  const database = getDatabase();
  const token = randomBytes(32).toString("base64url");
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlSeconds * 1_000);

  database
    .prepare("DELETE FROM sessions WHERE expires_at <= ? OR revoked_at IS NOT NULL")
    .run(now.toISOString());
  database
    .prepare(`
      INSERT INTO sessions (token_hash, user_id, expires_at, created_at, revoked_at)
      VALUES (?, ?, ?, ?, NULL)
    `)
    .run(hashToken(token), userId, expiresAt.toISOString(), now.toISOString());

  return token;
}

export function getSessionFromToken(token: string | null | undefined): SessionUser | null {
  if (!token || token.length < 32 || token.length > 256) {
    return null;
  }

  const now = new Date().toISOString();
  const row = getDatabase()
    .prepare(`
      SELECT
        u.id,
        u.name,
        u.email,
        u.role,
        tm.team_id,
        t.name AS team_name
      FROM sessions s
      JOIN users u ON u.id = s.user_id
      LEFT JOIN team_members tm ON tm.user_id = u.id
      LEFT JOIN teams t ON t.id = tm.team_id
      WHERE s.token_hash = ?
        AND s.revoked_at IS NULL
        AND s.expires_at > ?
    `)
    .get(hashToken(token), now) as UserRow | undefined;

  return row ? rowToSessionUser(row) : null;
}

export function verifySessionToken(token: string | null | undefined): SessionUser | null {
  return getSessionFromToken(token);
}

export function invalidateSessionToken(token: string | null | undefined): void {
  if (!token) {
    return;
  }

  getDatabase()
    .prepare("UPDATE sessions SET revoked_at = ? WHERE token_hash = ?")
    .run(new Date().toISOString(), hashToken(token));
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
      return decodeURIComponent(rawValue.join("="));
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
