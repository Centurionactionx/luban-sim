import { randomUUID } from "node:crypto";

import type { AuthAuditEventView } from "../contracts";
import { getDb } from "./db";

export type AuthAuditType =
  | "INVITATION_CREATED"
  | "INVITATION_REVOKED"
  | "INVITATION_ACCEPTED"
  | "ACCOUNT_CREATED"
  | "ACCOUNT_SUSPENDED"
  | "ACCOUNT_RESTORED"
  | "ACCOUNT_ROLE_CHANGED"
  | "ACCOUNT_TEAM_CHANGED"
  | "ACCOUNT_DELETED"
  | "ACCOUNT_RENAMED"
  | "ADMIN_BOOTSTRAPPED"
  | "ACCESS_DENIED";

export interface RecordAuthAuditInput {
  type: AuthAuditType;
  actorUserId?: string | null;
  subjectUserId?: string | null;
  detail: string;
  metadata?: Record<string, unknown>;
}

interface AuditRow {
  id: string;
  type: string;
  actor_name: string | null;
  subject_name: string | null;
  detail: string;
  created_at: string;
}

/**
 * Appends one account-security event. Never store tokens, passwords, or
 * session identifiers in `detail` or `metadata`. Safe to call inside an open
 * transaction; it uses the same connection.
 */
export async function recordAuthAuditEvent(
  input: RecordAuthAuditInput,
): Promise<void> {
  const db = await getDb();
  await db.run(
    `
      INSERT INTO auth_audit_events (
        id, type, actor_user_id, subject_user_id, detail, metadata_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
    [
      randomUUID(),
      input.type,
      input.actorUserId ?? null,
      input.subjectUserId ?? null,
      input.detail,
      input.metadata ? JSON.stringify(input.metadata) : null,
      new Date().toISOString(),
    ],
  );
}

export async function listAuthAuditEvents(
  limit = 50,
): Promise<AuthAuditEventView[]> {
  const db = await getDb();
  const rows = await db.all<AuditRow>(
    `
      SELECT
        e.id,
        e.type,
        actor.name AS actor_name,
        subject.name AS subject_name,
        e.detail,
        e.created_at
      FROM auth_audit_events e
      LEFT JOIN users actor ON actor.id = e.actor_user_id
      LEFT JOIN users subject ON subject.id = e.subject_user_id
      ORDER BY e.created_at DESC, e.id DESC
      LIMIT ?
    `,
    [Math.min(Math.max(Math.trunc(limit), 1), 200)],
  );

  return rows.map((row) => ({
    id: row.id,
    type: row.type,
    actorName: row.actor_name,
    subjectName: row.subject_name,
    detail: row.detail,
    createdAt: row.created_at,
  }));
}
