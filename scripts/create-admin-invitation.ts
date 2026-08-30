/**
 * Out-of-band bootstrap for the first platform administrator.
 *
 * Run on the machine that owns the database (never exposed over HTTP):
 *
 *   pnpm bootstrap:admin -- --email you@example.ca --name "Your Name"
 *
 * Prints a single-use platform_admin invitation link. Open it on the managed
 * deployment while signed in with the matching verified email. Locking the
 * invitation to an email (--email) is strongly recommended.
 */
import { parseArgs } from "node:util";

import { loadEnvConfig } from "@next/env";

async function main(): Promise<void> {
  loadEnvConfig(process.cwd());

  // `pnpm bootstrap:admin -- --email x` forwards the literal "--" separator,
  // which parseArgs would treat as end-of-options and reject the rest as
  // positionals. Drop it so both invocation styles work.
  const { values } = parseArgs({
    args: process.argv.slice(2).filter((argument) => argument !== "--"),
    options: {
      email: { type: "string" },
      name: { type: "string" },
      hours: { type: "string" },
    },
  });

  const hours = values.hours ? Number(values.hours) : undefined;

  if (values.hours && (!Number.isSafeInteger(hours) || hours! < 1)) {
    console.error("--hours must be a whole number of hours (default 72).");
    process.exitCode = 1;
    return;
  }

  // Imported after env loading so LUBAN_DATABASE_PATH is respected.
  const { createSystemAdminInvitation } = await import(
    "../lib/server/invitations"
  );

  const created = await createSystemAdminInvitation({
    email: values.email ?? null,
    invitedName: values.name ?? null,
    expiresInHours: hours,
  });

  const baseUrl = process.env.LUBAN_APP_URL ?? "http://localhost:3000";
  const joinUrl = new URL(created.joinPath, baseUrl).toString();

  console.log("Platform administrator invitation created.");
  console.log(`  Role:       platform_admin`);
  console.log(
    `  Locked to:  ${created.invitation.email ?? "any email (consider --email)"}`,
  );
  console.log(`  Expires:    ${created.invitation.expiresAt}`);
  console.log("");
  console.log("Single-use invitation link (shown once, never stored):");
  console.log(`  ${joinUrl}`);
  console.log("");
  console.log(
    "Open it on the managed deployment (LUBAN_AUTH_MODE=managed) while signed in with a verified email.",
  );
}

void main();
