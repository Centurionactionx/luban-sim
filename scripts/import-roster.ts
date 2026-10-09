/**
 * Pre-loads competition participants from a roster CSV so each person lands
 * in their account, already on their team, the first time they sign in with
 * a matching verified email. New accounts go by "User 1", "User 2", … until
 * the person picks a name.
 *
 *   pnpm import:roster -- --env-file .env.roster.local --file private/roster.csv --actor-email you@example.ca
 *   (add --apply to write; without it this is a dry run)
 *
 * The CSV needs `team` and `email` columns, and optionally `alt_email` (one
 * or more addresses separated by ";"). Other columns are ignored. The env
 * file names the database (LUBAN_DATABASE_PROVIDER=postgres plus
 * LUBAN_DATABASE_URL or POSTGRES_URL, and LUBAN_DATABASE_CA_CERT if needed);
 * only that file is read. The actor must be a host or platform admin, who
 * is recorded as creating the teams and accounts.
 */
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

/** Minimal RFC 4180 reader: quoted fields, doubled quotes, CRLF. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[i + 1] === "\n") i += 1;
      row.push(field);
      if (row.some((cell) => cell.trim())) rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }
  row.push(field);
  if (row.some((cell) => cell.trim())) rows.push(row);
  return rows;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2).filter((argument) => argument !== "--"),
    options: {
      "env-file": { type: "string" },
      file: { type: "string" },
      "actor-email": { type: "string" },
      apply: { type: "boolean", default: false },
    },
  });

  if (!values["env-file"] || !values.file || !values["actor-email"]) {
    console.error("Pass --env-file, --file, and --actor-email.");
    process.exitCode = 1;
    return;
  }
  process.loadEnvFile(values["env-file"]);

  const [header, ...body] = parseCsv(readFileSync(values.file, "utf8").replace(/^﻿/, ""));
  const column = (name: string) => header.findIndex((cell) => cell.trim().toLowerCase() === name);
  const teamColumn = column("team");
  const emailColumn = column("email");
  const altColumn = column("alt_email");
  if (teamColumn < 0 || emailColumn < 0) {
    console.error("The CSV needs `team` and `email` columns.");
    process.exitCode = 1;
    return;
  }
  const entries = body.map((cells) => ({
    team: cells[teamColumn] ?? "",
    email: cells[emailColumn] ?? "",
    altEmails:
      altColumn >= 0
        ? (cells[altColumn] ?? "").split(";").map((alt) => alt.trim()).filter(Boolean)
        : [],
  }));

  // Imported after the env file so the database settings are in place.
  const { getDb } = await import("../lib/server/db");
  const { applyRosterImport, planRosterImport } = await import("../lib/server/roster-import");

  const db = await getDb();
  const actor = await db.get<{ id: string; role: string }>(
    "SELECT id, role FROM users WHERE LOWER(email) = ? AND status = 'active'",
    [values["actor-email"].trim().toLowerCase()],
  );
  if (!actor || actor.role === "student") {
    console.error("--actor-email must belong to an active host or platform admin.");
    process.exitCode = 1;
    return;
  }

  const plan = values.apply
    ? await applyRosterImport(actor.id, entries)
    : await planRosterImport(entries);

  const count = (kind: string) => plan.actions.filter((action) => action.kind === kind).length;
  for (const action of plan.actions) {
    if (action.kind === "create-team") console.log(`  new team      ${action.team}`);
  }
  for (const action of plan.actions) {
    if (action.kind === "create-account") {
      const alts = action.claimEmails.slice(1);
      console.log(
        `  new account   ${action.team} · ${action.name} · ${action.email}` +
          (alts.length ? ` (also ${alts.join(", ")})` : ""),
      );
    } else if (action.kind === "move-account") {
      console.log(
        `  move          ${action.name} <${action.email}>: ${action.fromTeam ?? "no team"} -> ${action.team}`,
      );
    }
  }
  for (const problem of plan.problems) console.log(`  PROBLEM       ${problem}`);
  console.log(
    `${count("create-team")} team(s) to create, ${count("create-account")} account(s) to pre-load, ` +
      `${count("move-account")} to move, ${count("keep-account")} already in place.`,
  );

  if (plan.problems.length > 0) {
    console.log("Nothing was written: fix the problems above first.");
    process.exitCode = 1;
  } else {
    console.log(values.apply ? "Saved." : "Dry run: nothing was written. Re-run with --apply to save.");
  }
  process.exit();
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
