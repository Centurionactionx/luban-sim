import { auth, clerkClient, currentUser } from "@clerk/nextjs/server";

import type { SessionUser } from "../contracts";
import { canHostCompetitions } from "../contracts";
import { AppError } from "../errors";
import { resolveManagedSubject, resolveManagedUser } from "./accounts";
import { isManagedAuthMode } from "./auth-mode";
import type { ManagedIdentity } from "./invitations";

/**
 * Clerk adapter. This module is only imported on demand from managed-mode
 * code paths so a demo-mode process never touches the Clerk SDK, which since
 * v7.8 refuses to run without provider keys.
 */

export type ManagedSessionState =
  | { kind: "signed-out" }
  | { kind: "linked"; user: SessionUser; subject: string }
  | { kind: "suspended"; subject: string }
  | { kind: "unlinked"; subject: string };

/**
 * Reads the provider-verified identity of the signed-in visitor, including
 * whether the provider has verified their primary email address. Uses the
 * Clerk Backend API, so reserve it for registration-time flows.
 */
export async function getManagedIdentity(): Promise<ManagedIdentity | null> {
  const user = await currentUser();

  if (!user) {
    return null;
  }

  const primaryEmail =
    user.emailAddresses.find(
      (address) => address.id === user.primaryEmailAddressId,
    ) ?? user.emailAddresses[0];

  if (!primaryEmail) {
    return null;
  }

  const name =
    [user.firstName, user.lastName]
      .filter((part): part is string => Boolean(part && part.trim()))
      .join(" ")
      .trim() ||
    user.username ||
    null;

  return {
    subject: user.id,
    email: primaryEmail.emailAddress,
    emailVerified: primaryEmail.verification?.status === "verified",
    name,
  };
}

/**
 * The request-time session check. Verifying the Clerk session token is local
 * cryptography (no network); the Backend API is consulted only for visitors
 * who are signed in but not yet linked to a Luban account, because that is
 * the single moment the admin-bootstrap rule may apply.
 */
export async function getManagedSessionState(): Promise<ManagedSessionState> {
  const { isAuthenticated, userId } = await auth();

  if (!isAuthenticated || !userId) {
    return { kind: "signed-out" };
  }

  const local = await resolveManagedSubject(userId);

  if (local.kind === "linked") {
    return { kind: "linked", user: local.user, subject: userId };
  }

  if (local.kind === "suspended") {
    return { kind: "suspended", subject: userId };
  }

  const identity = await getManagedIdentity();

  if (identity) {
    const bootstrapped = await resolveManagedUser(identity);

    if (bootstrapped.kind === "linked") {
      return { kind: "linked", user: bootstrapped.user, subject: userId };
    }

    if (bootstrapped.kind === "suspended") {
      return { kind: "suspended", subject: userId };
    }
  }

  return { kind: "unlinked", subject: userId };
}

export async function getManagedSessionUser(): Promise<SessionUser | null> {
  const state = await getManagedSessionState();
  return state.kind === "linked" ? state.user : null;
}

const MFA_CACHE_TTL_MS = 60_000;
const mfaEnrollmentCache = new Map<string, { enrolled: boolean; at: number }>();

export function isAdminMfaRequired(): boolean {
  return (
    isManagedAuthMode() && process.env.LUBAN_REQUIRE_ADMIN_MFA !== "false"
  );
}

/**
 * Whether the managed account has any second factor enrolled, per the
 * provider. Cached briefly per subject so admin polling does not turn into a
 * Backend API call per request. A provider failure counts as NOT enrolled:
 * the gate must fail closed.
 */
export async function hasManagedMfaEnrolled(subject: string): Promise<boolean> {
  const cached = mfaEnrollmentCache.get(subject);
  const now = Date.now();

  if (cached && now - cached.at < MFA_CACHE_TTL_MS) {
    return cached.enrolled;
  }

  let enrolled = false;

  try {
    const client = await clerkClient();
    const user = await client.users.getUser(subject);
    enrolled = user.twoFactorEnabled === true;
  } catch {
    enrolled = false;
  }

  mfaEnrollmentCache.set(subject, { enrolled, at: now });
  return enrolled;
}

/** Test seam: primes or clears the MFA enrollment cache. */
export function primeMfaEnrollmentCache(
  subject: string | null,
  enrolled?: boolean,
): void {
  if (subject === null) {
    mfaEnrollmentCache.clear();
    return;
  }

  mfaEnrollmentCache.set(subject, { enrolled: enrolled === true, at: Date.now() });
}

/**
 * Hosts and platform administrators must have multi-factor authentication
 * enrolled before any host-level operation is allowed in managed mode.
 * Set LUBAN_REQUIRE_ADMIN_MFA=false only while the Clerk instance cannot yet
 * offer MFA strategies (they require a paid Clerk plan).
 */
export async function assertAdminMfaSatisfied(user: SessionUser): Promise<void> {
  if (!canHostCompetitions(user.role) || !isAdminMfaRequired()) {
    return;
  }

  const { userId } = await auth();

  if (!userId || !(await hasManagedMfaEnrolled(userId))) {
    throw new AppError(
      "MFA_REQUIRED",
      "Host accounts must enable multi-factor authentication. Open Account security to enroll.",
      403,
    );
  }
}
