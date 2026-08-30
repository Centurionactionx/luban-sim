import { randomUUID } from "node:crypto";

import type { SessionUser } from "../contracts";
import { recordAuthAuditEvent } from "./audit";
import { getSessionUser } from "./auth";
import { getDatabase } from "./db";
import type { ManagedIdentity } from "./invitations";

const LAST_LOGIN_WRITE_INTERVAL_MS = 15 * 60 * 1_000;

export type ManagedResolution =
  | { kind: "linked"; user: SessionUser }
  | { kind: "suspended" }
  | { kind: "unlinked" };

function findUserIdByAuthSubject(subject: string): string | null {
  const row = getDatabase()
    .prepare("SELECT id FROM users WHERE auth_subject = ?")
    .get(subject) as { id: string } | undefined;

  return row?.id ?? null;
}

function touchLastLogin(userId: string): void {
  const database = getDatabase();
  const row = database
    .prepare("SELECT last_login_at FROM users WHERE id = ?")
    .get(userId) as { last_login_at: string | null } | undefined;

  const now = Date.now();
  const last = row?.last_login_at ? Date.parse(row.last_login_at) : 0;

  if (!Number.isFinite(last) || now - last >= LAST_LOGIN_WRITE_INTERVAL_MS) {
    database
      .prepare("UPDATE users SET last_login_at = ? WHERE id = ?")
      .run(new Date(now).toISOString(), userId);
  }
}

function normalizedBootstrapEmail(): string | null {
  const raw = process.env.LUBAN_BOOTSTRAP_ADMIN_EMAIL?.trim().toLowerCase();
  return raw || null;
}

/**
 * Deployment escape hatch for environments where the operator cannot run the
 * local bootstrap script: the account whose *verified* email matches
 * LUBAN_BOOTSTRAP_ADMIN_EMAIL becomes the first platform administrator — but
 * only while no other platform administrator exists, so the variable cannot
 * later be abused to mint a second admin.
 */
function maybeBootstrapAdmin(identity: ManagedIdentity): SessionUser | null {
  const bootstrapEmail = normalizedBootstrapEmail();
  const email = identity.email?.trim().toLowerCase();

  if (!bootstrapEmail || !email || email !== bootstrapEmail) {
    return null;
  }

  if (!identity.emailVerified) {
    return null;
  }

  const database = getDatabase();
  let userId: string | null = null;

  database.exec("BEGIN IMMEDIATE;");

  try {
    const existingAdmin = database
      .prepare(
        "SELECT id FROM users WHERE role = 'platform_admin' AND status = 'active' LIMIT 1",
      )
      .get() as { id: string } | undefined;

    const emailTaken = database
      .prepare("SELECT id FROM users WHERE lower(email) = ?")
      .get(email) as { id: string } | undefined;

    if (!existingAdmin && !emailTaken) {
      userId = randomUUID();
      const nowIso = new Date().toISOString();
      const displayName = identity.name?.trim() || email.split("@")[0];

      database
        .prepare(`
          INSERT INTO users (
            id, name, email, role, status, auth_subject,
            email_verified_at, created_at, last_login_at
          ) VALUES (?, ?, ?, 'platform_admin', 'active', ?, ?, ?, ?)
        `)
        .run(userId, displayName, email, identity.subject, nowIso, nowIso, nowIso);

      recordAuthAuditEvent({
        type: "ADMIN_BOOTSTRAPPED",
        actorUserId: userId,
        subjectUserId: userId,
        detail: `${displayName} was bootstrapped as the first platform administrator via LUBAN_BOOTSTRAP_ADMIN_EMAIL.`,
      });
      recordAuthAuditEvent({
        type: "ACCOUNT_CREATED",
        actorUserId: userId,
        subjectUserId: userId,
        detail: `A platform_admin account was created for ${displayName} during bootstrap.`,
      });
    }

    database.exec("COMMIT;");
  } catch (error) {
    try {
      database.exec("ROLLBACK;");
    } catch {
      // Preserve the original error.
    }
    throw error;
  }

  return userId ? getSessionUser(userId) : null;
}

/**
 * Local-database-only resolution of a provider subject. No provider calls,
 * no bootstrap: the fast path for every authenticated request.
 */
export function resolveManagedSubject(subject: string): ManagedResolution {
  const trimmed = subject?.trim();

  if (!trimmed) {
    return { kind: "unlinked" };
  }

  const userId = findUserIdByAuthSubject(trimmed);

  if (!userId) {
    return { kind: "unlinked" };
  }

  const user = getSessionUser(userId);

  if (!user) {
    return { kind: "unlinked" };
  }

  if (user.status !== "active") {
    return { kind: "suspended" };
  }

  touchLastLogin(userId);
  return { kind: "linked", user };
}

/**
 * Maps a verified managed identity onto the local account system, applying
 * the one-time admin-bootstrap rule for unlinked identities. Roles, teams,
 * and status always come from the local database — never from any
 * client-supplied value.
 */
export function resolveManagedUser(identity: ManagedIdentity): ManagedResolution {
  const resolved = resolveManagedSubject(identity.subject);

  if (resolved.kind !== "unlinked") {
    return resolved;
  }

  const bootstrapped = maybeBootstrapAdmin(identity);

  if (bootstrapped) {
    return { kind: "linked", user: bootstrapped };
  }

  return { kind: "unlinked" };
}
