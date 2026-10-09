import { randomUUID } from "node:crypto";

import { AppError } from "../errors";
import { createCompetitionTeam, normalizeTeamName } from "./admin";
import { setAccountTeam } from "./account-management";
import { recordAuthAuditEvent } from "./audit";
import { ADVISORY_LOCK_ACCOUNTS, acquireAdvisoryLock } from "./database";
import { getDb } from "./db";
import { getCompetitionSummary } from "./queries";

/** One participant from a sign-up roster. */
export interface RosterEntry {
  team: string;
  email: string;
  /** Other addresses they might sign in with (a school email, say). */
  altEmails?: string[];
}

export type RosterAction =
  | { kind: "create-team"; team: string }
  | { kind: "create-account"; team: string; email: string; name: string; claimEmails: string[] }
  | { kind: "move-account"; team: string; email: string; name: string; fromTeam: string | null }
  | { kind: "keep-account"; team: string; email: string; name: string };

export interface RosterPlan {
  actions: RosterAction[];
  /** Problems that stop the import; nothing is written while any exist. */
  problems: string[];
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function cleanEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

/**
 * Works out what importing a roster would do, without writing anything.
 * Teams are matched by name (ignoring case) and people by email, so running
 * the same roster again plans nothing new.
 */
export async function planRosterImport(entries: RosterEntry[]): Promise<RosterPlan> {
  const db = await getDb();
  const competition = await getCompetitionSummary();
  const problems: string[] = [];
  const actions: RosterAction[] = [];
  const seenEmails = new Map<string, string>();

  const teams = new Map<string, { name: string; people: { email: string; alts: string[] }[] }>();
  for (const [index, entry] of entries.entries()) {
    const line = `Row ${index + 1}`;
    let teamName: string;
    try {
      teamName = normalizeTeamName(entry.team);
    } catch (error) {
      problems.push(`${line}: ${error instanceof AppError ? error.message : "bad team name"}`);
      continue;
    }
    const email = cleanEmail(entry.email);
    const alts = (entry.altEmails ?? []).map(cleanEmail).filter((alt) => alt && alt !== email);
    for (const address of [email, ...alts]) {
      if (!EMAIL_PATTERN.test(address)) {
        problems.push(`${line}: "${address}" is not an email address.`);
      }
      const other = seenEmails.get(address);
      if (other) problems.push(`${line}: ${address} is also listed in ${other}.`);
      seenEmails.set(address, line);
    }
    const key = teamName.toLowerCase();
    const team = teams.get(key) ?? { name: teamName, people: [] };
    team.people.push({ email, alts });
    teams.set(key, team);
  }

  for (const team of teams.values()) {
    const existingTeam = await db.get<{ id: string; name: string }>(
      `SELECT id, name FROM teams
       WHERE competition_id = ? AND sandbox_owner_user_id IS NULL AND LOWER(name) = LOWER(?)`,
      [competition.id, team.name],
    );
    const teamName = existingTeam?.name ?? team.name;
    if (!existingTeam) actions.push({ kind: "create-team", team: teamName });

    let placeholder = 0;
    for (const person of team.people) {
      placeholder += 1;
      const addresses = [person.email, ...person.alts];
      const placeholders = addresses.map(() => "?").join(", ");
      const existing = await db.get<{
        id: string;
        name: string;
        email: string;
        role: string;
        status: string;
        team_name: string | null;
      }>(
        `SELECT u.id, u.name, u.email, u.role, u.status, t.name AS team_name
         FROM users u
         LEFT JOIN team_members m ON m.user_id = u.id
         LEFT JOIN teams t ON t.id = m.team_id
         WHERE LOWER(u.email) IN (${placeholders})
            OR u.id IN (SELECT user_id FROM account_claims WHERE email IN (${placeholders}))
         LIMIT 1`,
        [...addresses, ...addresses],
      );

      if (!existing) {
        actions.push({
          kind: "create-account",
          team: teamName,
          email: person.email,
          name: `User ${placeholder}`,
          claimEmails: addresses,
        });
        continue;
      }
      if (existing.role !== "student" || existing.status !== "active") {
        problems.push(
          `${existing.email} already has a ${existing.status} ${existing.role} account; place it by hand.`,
        );
        continue;
      }
      actions.push(
        existing.team_name?.toLowerCase() === teamName.toLowerCase()
          ? { kind: "keep-account", team: teamName, email: existing.email, name: existing.name }
          : {
              kind: "move-account",
              team: teamName,
              email: existing.email,
              name: existing.name,
              fromTeam: existing.team_name,
            },
      );
    }
  }

  return { actions, problems };
}

/**
 * Loads a roster: creates any missing teams (funded like a host-created
 * team), pre-loads an account for each new person with a placeholder name
 * and the emails that may claim it on first sign-in, and moves existing
 * student accounts onto their roster team. Refuses to write anything while
 * the plan has problems.
 */
export async function applyRosterImport(
  actorUserId: string,
  entries: RosterEntry[],
): Promise<RosterPlan> {
  const plan = await planRosterImport(entries);
  if (plan.problems.length > 0) return plan;

  for (const action of plan.actions) {
    if (action.kind === "create-team") {
      await createCompetitionTeam({ actorUserId, name: action.team });
    }
  }

  const db = await getDb();
  const competition = await getCompetitionSummary();
  const teamIdFor = async (name: string): Promise<string> => {
    const team = await db.get<{ id: string }>(
      `SELECT id FROM teams
       WHERE competition_id = ? AND sandbox_owner_user_id IS NULL AND LOWER(name) = LOWER(?)`,
      [competition.id, name],
    );
    if (!team) throw new AppError("TEAM_NOT_FOUND", `Team ${name} was not created.`, 500);
    return team.id;
  };

  for (const action of plan.actions) {
    if (action.kind === "move-account") {
      const user = await db.get<{ id: string }>("SELECT id FROM users WHERE email = ?", [
        action.email,
      ]);
      if (user) await setAccountTeam(actorUserId, user.id, await teamIdFor(action.team));
    }
  }

  const creations = plan.actions.filter(
    (action): action is Extract<RosterAction, { kind: "create-account" }> =>
      action.kind === "create-account",
  );
  const teamIds = new Map<string, string>();
  for (const action of creations) {
    if (!teamIds.has(action.team)) teamIds.set(action.team, await teamIdFor(action.team));
  }

  await db.transaction(async (tx) => {
    await acquireAdvisoryLock(tx, ADVISORY_LOCK_ACCOUNTS);
    const nowIso = new Date().toISOString();

    for (const action of creations) {
      const userId = randomUUID();
      await tx.run(
        `INSERT INTO users (
           id, name, email, role, status, auth_subject,
           email_verified_at, created_at, last_login_at
         ) VALUES (?, ?, ?, 'student', 'active', NULL, NULL, ?, NULL)`,
        [userId, action.name, action.email, nowIso],
      );
      await tx.run(
        `INSERT INTO team_members (team_id, user_id, is_captain, joined_at)
         VALUES (?, ?, 0, ?)`,
        [teamIds.get(action.team), userId, nowIso],
      );
      await tx.run(
        "INSERT INTO pending_display_names (user_id, created_at) VALUES (?, ?)",
        [userId, nowIso],
      );
      for (const email of action.claimEmails) {
        await tx.run(
          "INSERT INTO account_claims (email, user_id, created_at) VALUES (?, ?, ?)",
          [email, userId, nowIso],
        );
      }
      await recordAuthAuditEvent({
        type: "ACCOUNT_CREATED",
        actorUserId,
        subjectUserId: userId,
        detail: `A student account on ${action.team} was pre-loaded from the competition roster.`,
      });
    }
  });

  return plan;
}
