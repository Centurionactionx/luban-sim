import type { SessionUser } from "../contracts";
import { AppError } from "../errors";
import { recordAuthAuditEvent } from "./audit";
import { getSessionUser } from "./auth";
import { getDb } from "./db";

/** The longest name the header, team list, and leaderboard lay out cleanly. */
export const DISPLAY_NAME_MAX_LENGTH = 60;

/**
 * Tidies a name someone typed: Unicode-normalized, spaces collapsed, ends
 * trimmed. Control and invisible formatting characters are refused rather
 * than stripped, so what is saved is exactly what was shown.
 */
export function normalizeDisplayName(raw: unknown): string {
  if (typeof raw !== "string") {
    throw new AppError("INVALID_NAME", "Enter a name.", 400, { field: "name" });
  }
  const name = raw.normalize("NFC").replace(/[ \t]+/g, " ").trim();
  if (/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(name)) {
    throw new AppError(
      "INVALID_NAME",
      "Names can't contain line breaks or hidden characters.",
      400,
      { field: "name" },
    );
  }
  if (name.length === 0) {
    throw new AppError("INVALID_NAME", "Enter a name.", 400, { field: "name" });
  }
  if (name.length > DISPLAY_NAME_MAX_LENGTH) {
    throw new AppError(
      "INVALID_NAME",
      `Keep your name to ${DISPLAY_NAME_MAX_LENGTH} characters or fewer.`,
      400,
      { field: "name", maximum: DISPLAY_NAME_MAX_LENGTH },
    );
  }
  return name;
}

/**
 * Changes the name an active person goes by everywhere in the simulator:
 * the header, their team's member list, and every order and activity entry
 * attributed to them. Only their own name; the id comes from the session.
 */
export async function updateDisplayName(input: {
  userId: string;
  name: unknown;
}): Promise<SessionUser> {
  const name = normalizeDisplayName(input.name);
  const db = await getDb();
  const current = await db.get<{ name: string; status: string }>(
    "SELECT name, status FROM users WHERE id = ?",
    [input.userId],
  );
  if (!current || current.status !== "active") {
    throw new AppError("UNAUTHORIZED", "Sign in to continue.", 401);
  }

  if (current.name !== name) {
    await db.run("UPDATE users SET name = ? WHERE id = ? AND status = 'active'", [
      name,
      input.userId,
    ]);
    await recordAuthAuditEvent({
      type: "ACCOUNT_RENAMED",
      actorUserId: input.userId,
      subjectUserId: input.userId,
      detail: `Changed their display name from "${current.name}" to "${name}".`,
    });
  }

  // Saving any name, even the placeholder unchanged, settles the prompt.
  await db.run("DELETE FROM pending_display_names WHERE user_id = ?", [input.userId]);

  const user = await getSessionUser(input.userId);
  if (!user) {
    throw new AppError("UNAUTHORIZED", "Sign in to continue.", 401);
  }
  return user;
}
