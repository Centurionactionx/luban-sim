import type { AuthMode } from "../contracts";

/**
 * demo    — seeded identities with the local identity switcher. The default,
 *           and the only mode exercised by the automated test suites.
 * managed — real registration and sign-in through the managed identity
 *           provider (Clerk). Requires provider keys; demo login is refused.
 */
export function getAuthMode(): AuthMode {
  return process.env.LUBAN_AUTH_MODE === "managed" ? "managed" : "demo";
}

export function isManagedAuthMode(): boolean {
  return getAuthMode() === "managed";
}

/**
 * Demo identity switching is never available in managed mode, and in a
 * production build it additionally requires the explicit LUBAN_DEMO_MODE
 * opt-in so a public deployment cannot expose the seeded host account.
 */
export function isDemoLoginAllowed(): boolean {
  if (isManagedAuthMode()) {
    return false;
  }

  return (
    process.env.NODE_ENV !== "production" ||
    process.env.LUBAN_DEMO_MODE === "true"
  );
}
