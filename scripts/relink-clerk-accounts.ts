/**
 * Re-links existing Luban accounts to a different Clerk instance (for
 * example after moving from a development instance to production, where
 * every person gets a new Clerk user id).
 *
 * Accounts are matched by email: a Luban account is pointed at the Clerk
 * user whose *verified primary* email is the same. Anyone who has not signed
 * up on the new instance yet is left alone, so the script is safe to re-run.
 *
 *   pnpm relink:clerk -- --env-file .env.relink.local          (dry run)
 *   pnpm relink:clerk -- --env-file .env.relink.local --apply  (writes)
 *
 * With --create-missing, active accounts that have no Clerk user yet get one
 * created first (email marked verified by Clerk, no password, no email sent),
 * so their next Google or email-code sign-in lands in the existing account.
 * --skip-email <address> (repeatable) leaves an account out of creation.
 *
 * The env file needs LUBAN_DATABASE_URL (or POSTGRES_URL) for the database,
 * LUBAN_DATABASE_CA_CERT if the database needs it, and the CLERK_SECRET_KEY
 * of the instance to link to. Only that file is read, so a local .env.local
 * can never point it at the wrong database.
 */
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";

import { Client } from "pg";

import { postgresConnectionOptions } from "../lib/server/postgres-config";

interface ClerkEmail {
  id: string;
  email_address: string;
  verification: { status: string } | null;
}

interface ClerkUser {
  id: string;
  primary_email_address_id: string | null;
  email_addresses: ClerkEmail[];
}

interface UserRow {
  id: string;
  name: string;
  email: string;
  role: string;
  status: string;
  auth_subject: string | null;
}

/** Backend-created email addresses are verified; no password is set. */
async function createClerkUser(secretKey: string, row: UserRow): Promise<string> {
  const [firstName, ...rest] = row.name.trim().split(/\s+/);
  const response = await fetch("https://api.clerk.com/v1/users", {
    method: "POST",
    headers: { Authorization: `Bearer ${secretKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      email_address: [row.email.trim()],
      first_name: firstName || undefined,
      last_name: rest.join(" ") || undefined,
      skip_password_requirement: true,
    }),
  });
  if (!response.ok) {
    throw new Error(
      `Clerk returned ${response.status} creating ${row.email}: ${await response.text()}`,
    );
  }
  return ((await response.json()) as ClerkUser).id;
}

async function listClerkUsers(secretKey: string): Promise<ClerkUser[]> {
  const users: ClerkUser[] = [];
  const pageSize = 500;

  for (let offset = 0; ; offset += pageSize) {
    const response = await fetch(
      `https://api.clerk.com/v1/users?limit=${pageSize}&offset=${offset}&order_by=created_at`,
      { headers: { Authorization: `Bearer ${secretKey}` } },
    );
    if (!response.ok) {
      throw new Error(`Clerk returned ${response.status} listing users.`);
    }
    const page = (await response.json()) as ClerkUser[];
    users.push(...page);
    if (page.length < pageSize) return users;
  }
}

/** The verified primary email, the same one the app trusts at sign-in. */
function verifiedPrimaryEmail(user: ClerkUser): string | null {
  const primary =
    user.email_addresses.find((address) => address.id === user.primary_email_address_id) ??
    user.email_addresses[0];
  if (!primary || primary.verification?.status !== "verified") return null;
  return primary.email_address.trim().toLowerCase();
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2).filter((argument) => argument !== "--"),
    options: {
      "env-file": { type: "string" },
      apply: { type: "boolean", default: false },
      "create-missing": { type: "boolean", default: false },
      "skip-email": { type: "string", multiple: true, default: [] },
    },
  });

  if (!values["env-file"]) {
    console.error("Pass --env-file <path> with the database URL and the Clerk secret key.");
    process.exitCode = 1;
    return;
  }
  process.loadEnvFile(values["env-file"]);

  const secretKey = process.env.CLERK_SECRET_KEY?.trim();
  if (!secretKey?.startsWith("sk_live_")) {
    console.error("CLERK_SECRET_KEY must be a production key (sk_live_…).");
    process.exitCode = 1;
    return;
  }

  const url = (process.env.LUBAN_DATABASE_URL || process.env.POSTGRES_URL)?.trim();
  if (!url || !/^postgres(?:ql)?:\/\//.test(url)) {
    console.error("Set LUBAN_DATABASE_URL (or POSTGRES_URL) to a postgres:// connection string.");
    process.exitCode = 1;
    return;
  }

  const clerkUsers = await listClerkUsers(secretKey);
  const subjectByEmail = new Map<string, string>();
  for (const user of clerkUsers) {
    const email = verifiedPrimaryEmail(user);
    if (email) subjectByEmail.set(email, user.id);
  }
  console.log(
    `Clerk: ${clerkUsers.length} user(s), ${subjectByEmail.size} with a verified primary email.`,
  );

  const client = new Client({ ...postgresConnectionOptions(url), connectionTimeoutMillis: 10_000 });
  await client.connect();

  try {
    if (values["create-missing"]) {
      const { rows: active } = await client.query<UserRow>(
        "SELECT id, name, email, role, status, auth_subject FROM users WHERE status = 'active' ORDER BY created_at",
      );
      const skipped = new Set(values["skip-email"].map((email) => email.trim().toLowerCase()));
      const missing = active.filter((row) => {
        const email = row.email.trim().toLowerCase();
        return !subjectByEmail.has(email) && !skipped.has(email);
      });
      for (const row of missing) {
        console.log(`  create Clerk user for ${row.email} (${row.name}, ${row.role})`);
        if (values.apply) {
          subjectByEmail.set(row.email.trim().toLowerCase(), await createClerkUser(secretKey, row));
        }
      }
      console.log(
        `${missing.length} Clerk user(s) to create` +
          (values.apply ? ", created." : " (dry run lists relinks for existing Clerk users only)."),
      );
    }

    await client.query("BEGIN");
    const { rows } = await client.query<UserRow>(
      "SELECT id, name, email, role, status, auth_subject FROM users ORDER BY created_at FOR UPDATE",
    );
    const linkedSubjects = new Set(rows.map((row) => row.auth_subject).filter(Boolean));

    const changes: { row: UserRow; subject: string }[] = [];
    let alreadyLinked = 0;
    let notSignedUp = 0;

    for (const row of rows) {
      const subject = subjectByEmail.get(row.email.trim().toLowerCase());
      if (!subject) {
        notSignedUp += 1;
        continue;
      }
      if (row.auth_subject === subject) {
        alreadyLinked += 1;
        continue;
      }
      if (linkedSubjects.has(subject)) {
        console.warn(`  skip ${row.email}: that Clerk user is already linked to another account.`);
        continue;
      }
      changes.push({ row, subject });
    }

    for (const { row, subject } of changes) {
      console.log(`  relink ${row.email} (${row.name}, ${row.role}, ${row.status}) -> ${subject}`);
    }
    console.log(
      `${changes.length} to relink, ${alreadyLinked} already linked, ` +
        `${notSignedUp} with no Clerk user on this instance.`,
    );

    if (!values.apply) {
      await client.query("ROLLBACK");
      console.log("Dry run: nothing was written. Re-run with --apply to save.");
      return;
    }

    const nowIso = new Date().toISOString();
    for (const { row, subject } of changes) {
      await client.query("UPDATE users SET auth_subject = $1 WHERE id = $2", [subject, row.id]);
      await client.query(
        `INSERT INTO auth_audit_events (
           id, type, actor_user_id, subject_user_id, detail, metadata_json, created_at
         ) VALUES ($1, 'ACCOUNT_RELINKED', NULL, $2, $3, NULL, $4)`,
        [
          randomUUID(),
          row.id,
          `${row.name} was re-linked to a new sign-in by email during a Clerk instance move.`,
          nowIso,
        ],
      );
    }
    await client.query("COMMIT");
    console.log(`Saved: ${changes.length} account(s) relinked.`);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    await client.end();
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
