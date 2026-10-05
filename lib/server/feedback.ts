import { randomUUID } from "node:crypto";

import type {
  FeedbackItem,
  FeedbackSource,
  FeedbackTopic,
  SessionUser,
} from "../contracts";
import {
  FEEDBACK_MAX_LENGTH,
  FEEDBACK_MIN_LENGTH,
  FEEDBACK_SOURCES,
  isFeedbackTopic,
} from "../contracts";
import { AppError } from "../errors";
import { getSessionUser } from "./auth";
import { getDb } from "./db";
import { assertRequestAllowed } from "./request-throttle";

/**
 * Feedback from signed-in people about the public website or the simulator.
 * Anyone with an account may send it; only platform administrators read it.
 */

/** Sends per person per minute. Enough to correct a typo, not to flood. */
export const FEEDBACK_SUBMISSIONS_PER_MINUTE = 5;
export const MAX_FEEDBACK_LIST_LIMIT = 500;

export interface SubmitFeedbackInput {
  userId: string;
  topic: FeedbackTopic;
  message: string;
  source: FeedbackSource;
}

export interface ListFeedbackOptions {
  topic?: FeedbackTopic;
  limit?: number;
}

interface FeedbackRow {
  id: string;
  topic: FeedbackTopic;
  message: string;
  source: FeedbackSource;
  created_at: string;
  user_id: string;
  user_name: string;
  user_email: string;
  team_id: string | null;
  team_name: string | null;
}

async function requireActiveUser(userId: string): Promise<SessionUser> {
  const user = await getSessionUser(userId);

  if (!user || user.status === "deleted") {
    throw new AppError("UNAUTHORIZED", "Sign in to continue.", 401);
  }

  if (user.status !== "active") {
    throw new AppError("ACCOUNT_SUSPENDED", "This account is suspended.", 403);
  }

  return user;
}

/**
 * Trims the message and checks it fits. Length is counted in characters
 * (code points), the same way the database counts it, so an emoji is one.
 */
function normalizeMessage(raw: unknown): string {
  if (typeof raw !== "string") {
    throw new AppError("INVALID_FEEDBACK_MESSAGE", "Write your feedback.", 400, {
      field: "message",
    });
  }

  // PostgreSQL text cannot hold NUL; nobody types one on purpose.
  const message = raw.replace(/\u0000/g, "").trim();
  const length = [...message].length;

  if (length < FEEDBACK_MIN_LENGTH) {
    throw new AppError(
      "FEEDBACK_TOO_SHORT",
      `Write at least ${FEEDBACK_MIN_LENGTH} characters.`,
      400,
      { field: "message", minimum: FEEDBACK_MIN_LENGTH },
    );
  }

  if (length > FEEDBACK_MAX_LENGTH) {
    throw new AppError(
      "FEEDBACK_TOO_LONG",
      `Feedback can be at most ${FEEDBACK_MAX_LENGTH} characters.`,
      400,
      { field: "message", maximum: FEEDBACK_MAX_LENGTH },
    );
  }

  return message;
}

function rowToFeedbackItem(row: FeedbackRow): FeedbackItem {
  return {
    id: row.id,
    topic: row.topic,
    message: row.message,
    source: row.source,
    createdAt: row.created_at,
    userId: row.user_id,
    userName: row.user_name,
    userEmail: row.user_email,
    teamId: row.team_id,
    teamName: row.team_name,
  };
}

const FEEDBACK_SELECT = `
  SELECT
    f.id, f.topic, f.message, f.source, f.created_at,
    f.user_id, u.name AS user_name, u.email AS user_email,
    f.team_id, t.name AS team_name
  FROM feedback f
  JOIN users u ON u.id = f.user_id
  LEFT JOIN teams t ON t.id = f.team_id
`;

/**
 * Stores one submission against the sender's account and current team.
 * Invalid input is refused before it counts toward the rate limit.
 */
export async function submitFeedback(input: SubmitFeedbackInput): Promise<FeedbackItem> {
  if (!isFeedbackTopic(input.topic)) {
    throw new AppError(
      "INVALID_FEEDBACK_TOPIC",
      "Choose whether this is about the website or the simulator.",
      400,
      { field: "topic" },
    );
  }

  if (!FEEDBACK_SOURCES.includes(input.source)) {
    throw new AppError("INVALID_FEEDBACK_SOURCE", "Unknown feedback source.", 400, {
      field: "source",
    });
  }

  const message = normalizeMessage(input.message);
  const user = await requireActiveUser(input.userId);
  assertRequestAllowed(`feedback:${user.id}`, FEEDBACK_SUBMISSIONS_PER_MINUTE);

  const id = randomUUID();
  const db = await getDb();
  await db.run(
    `INSERT INTO feedback (id, user_id, team_id, topic, message, source, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [id, user.id, user.teamId, input.topic, message, input.source, new Date().toISOString()],
  );

  const row = await db.get<FeedbackRow>(`${FEEDBACK_SELECT} WHERE f.id = ?`, [id]);
  return rowToFeedbackItem(row!);
}

/** Newest first. Platform administrators only. */
export async function listFeedback(
  actorUserId: string,
  { topic, limit = 200 }: ListFeedbackOptions = {},
): Promise<FeedbackItem[]> {
  const actor = await requireActiveUser(actorUserId);

  if (actor.role !== "platform_admin") {
    throw new AppError(
      "ADMIN_ONLY",
      "Only a platform administrator can read feedback.",
      403,
    );
  }

  if (topic !== undefined && !isFeedbackTopic(topic)) {
    throw new AppError("INVALID_FEEDBACK_TOPIC", "Unknown feedback topic.", 400, {
      field: "topic",
    });
  }

  const db = await getDb();
  const rows = await db.all<FeedbackRow>(
    `${FEEDBACK_SELECT}
     ${topic ? "WHERE f.topic = ?" : ""}
     ORDER BY f.created_at DESC, f.id DESC
     LIMIT ?`,
    [
      ...(topic ? [topic] : []),
      Math.min(Math.max(Math.trunc(limit), 1), MAX_FEEDBACK_LIST_LIMIT),
    ],
  );

  return rows.map(rowToFeedbackItem);
}
