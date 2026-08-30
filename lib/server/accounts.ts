import { randomUUID } from "node:crypto";

import type { SessionUser } from "../contracts";
import { recordAuthAuditEvent } from "./audit";
import { getSessionUser } from "./auth";
import { ADVISORY_LOCK_ACCOUNTS, acquireAdvisoryLock } from "./database";
import { getDb } from "./db";
import type { ManagedIdentity } from "./invitations";

const LAST_LOGIN_WRITE_INTERVAL_MS = 15 * 60 * 1_000;

export type ManagedResolution =
  | { kind: "linked"; user: SessionUser }
  | { kind: "suspended" }
  | { kind: "unlinked" };

async function findUserIdByAuthSubject(subject: string): Promise<string | null> {
  const db = await getDb();
  const row = await db.get<{ id: string }>(
    "SELECT id FROM users WHERE auth_subject = ?",
    [subject],
  );

  return row?.id ?? null;
}

async function touchLastLogin(userId: string): Promise<void> {
  const db = await getDb();
  const row = await db.get<{ last_login_at: string | null }>(
    "SELECT last_login_at FROM users WHERE id = ?",
    [userId],
  );

  const now = Date.now();
  const last = row?.last_login_at ? Date.parse(row.last_login_at) : 0;

  if (!Number.isFinite(last) || now - last >= LAST_LOGIN_WRITE_INTERVAL_MS) {
    await db.run("UPDATE users SET last_login_at = ? WHERE id = ?", [
      new Date(now).toISOString(),
      userId,
    ]);
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
async function maybeBootstrapAdmin(
  identity: ManagedIdentity,
): Promise<SessionUser | null> {
  const bootstrapEmail = normalizedBootstrapEmail();
  const email = identity.email?.trim().toLowerCase();

  if (!bootstrapEmail || !email || email !== bootstrapEmail) {
    return null;
  }

  if (!identity.emailVerified) {
    return null;
  }

  const db = await getDb();

  const userId = await db.transaction(async (tx) => {
    await acquireAdvisoryLock(tx, ADVISORY_LOCK_ACCOUNTS);

    const existingAdmin = await tx.get<{ id: string }>(
      "SELECT id FROM users WHERE role = 'platform_admin' AND status = 'active' LIMIT 1",
    );

    const emailTaken = await tx.get<{ id: string }>(
      "SELECT id FROM users WHERE lower(email) = ?",
      [email],
    );

    if (existingAdmin || emailTaken) {
      return null;
    }

    const createdUserId = randomUUID();
    const nowIso = new Date().toISOString();
    const displayName = identity.name?.trim() || email.split("@")[0];

    await tx.run(
      `
        INSERT INTO users (
          id, name, email, role, status, auth_subject,
          email_verified_at, created_at, last_login_at
        ) VALUES (?, ?, ?, 'platform_admin', 'active', ?, ?, ?, ?)
      `,
      [createdUserId, displayName, email, identity.subject, nowIso, nowIso, nowIso],
    );

    await recordAuthAuditEvent({
      type: "ADMIN_BOOTSTRAPPED",
      actorUserId: createdUserId,
      subjectUserId: createdUserId,
      detail: `${displayName} was bootstrapped as the first platform administrator via LUBAN_BOOTSTRAP_ADMIN_EMAIL.`,
    });
    await recordAuthAuditEvent({
      type: "ACCOUNT_CREATED",
      actorUserId: createdUserId,
      subjectUserId: createdUserId,
      detail: `A platform_admin account was created for ${displayName} during bootstrap.`,
    });

    return createdUserId;
  });

  return userId ? getSessionUser(userId) : null;
}

/**
 * Local-database-only resolution of a provider subject. No provider calls,
 * no bootstrap: the fast path for every authenticated request.
 */
export async function resolveManagedSubject(
  subject: string,
): Promise<ManagedResolution> {
  const trimmed = subject?.trim();

  if (!trimmed) {
    return { kind: "unlinked" };
  }

  const userId = await findUserIdByAuthSubject(trimmed);

  if (!userId) {
    return { kind: "unlinked" };
  }

  const user = await getSessionUser(userId);

  if (!user) {
    return { kind: "unlinked" };
  }

  if (user.status !== "active") {
    return { kind: "suspended" };
  }

  await touchLastLogin(userId);
  return { kind: "linked", user };
}

/**
 * Maps a verified managed identity onto the local account system, applying
 * the one-time admin-bootstrap rule for unlinked identities. Roles, teams,
 * and status always come from the local database — never from any
 * client-supplied value.
 */
export async function resolveManagedUser(
  identity: ManagedIdentity,
): Promise<ManagedResolution> {
  const resolved = await resolveManagedSubject(identity.subject);

  if (resolved.kind !== "unlinked") {
    return resolved;
  }

  const bootstrapped = await maybeBootstrapAdmin(identity);

  if (bootstrapped) {
    return { kind: "linked", user: bootstrapped };
  }

  return { kind: "unlinked" };
}
