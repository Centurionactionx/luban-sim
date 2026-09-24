import { auth, clerkClient, currentUser } from "@clerk/nextjs/server";

import type { SessionUser } from "../contracts";
import { canHostCompetitions } from "../contracts";
import { AppError } from "../errors";
import { resolveManagedSubject, resolveManagedUser } from "./accounts";
import { isManagedAuthMode } from "./auth-mode";
import type { ManagedIdentity } from "./invitations";
import { assertRequestAllowed } from "./request-throttle";

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
 * The signed-in visitor's provider subject, verified from the session token
 * alone (local cryptography, no Backend API call). Cheap enough to gate
 * endpoints before they reach the network-bound getManagedIdentity().
 */
export async function getManagedUserId(): Promise<string | null> {
  const { userId } = await auth();
  return userId ?? null;
}

/**
 * Signed-in visitors who are not linked to a Luban account can call any
 * authenticated route in a loop (sign-up is open so invitees can register),
 * and each unlinked request would otherwise reach the Clerk Backend API. The
 * lookup exists only for the admin-bootstrap rule, so its answer is cached
 * briefly per verified subject and the lookups themselves are throttled.
 * Per-process and best-effort, like request-throttle.ts.
 */
const UNLINKED_CACHE_TTL_MS = 30_000;
const MAX_UNLINKED_CACHE_ENTRIES = 5_000;
const UNLINKED_LOOKUPS_PER_SUBJECT_PER_MINUTE = 10;
const UNLINKED_LOOKUPS_GLOBAL_PER_MINUTE = 300;

/** Subject -> time it was last confirmed unlinked and not bootstrap-eligible. */
const unlinkedSubjectCache = new Map<string, number>();

function isCachedUnlinked(subject: string, now: number): boolean {
  const at = unlinkedSubjectCache.get(subject);

  if (at === undefined) {
    return false;
  }

  if (now - at < UNLINKED_CACHE_TTL_MS) {
    return true;
  }

  unlinkedSubjectCache.delete(subject);
  return false;
}

function rememberUnlinked(subject: string, now: number): void {
  unlinkedSubjectCache.delete(subject);

  while (unlinkedSubjectCache.size >= MAX_UNLINKED_CACHE_ENTRIES) {
    const oldest = unlinkedSubjectCache.keys().next().value;
    if (oldest === undefined) break;
    unlinkedSubjectCache.delete(oldest);
  }

  unlinkedSubjectCache.set(subject, now);
}

function isBootstrapConfigured(): boolean {
  return Boolean(process.env.LUBAN_BOOTSTRAP_ADMIN_EMAIL?.trim());
}

/** Test seam: forgets every cached unlinked subject. */
export function resetManagedSessionCache(): void {
  unlinkedSubjectCache.clear();
}

/**
 * The request-time session check. Verifying the Clerk session token is local
 * cryptography (no network); the Backend API is consulted only for visitors
 * who are signed in but not yet linked to a Luban account, because that is
 * the single moment the admin-bootstrap rule may apply. That lookup is skipped
 * entirely when no bootstrap email is configured, cached negatively per
 * subject, and throttled; a throttled or failed lookup degrades to "unlinked"
 * rather than an error.
 */
export async function getManagedSessionState(): Promise<ManagedSessionState> {
  const { isAuthenticated, userId } = await auth();

  if (!isAuthenticated || !userId) {
    return { kind: "signed-out" };
  }

  // Always consult the local database first so a subject linked since the
  // last lookup (invitation redeemed, admin bootstrapped elsewhere) is seen
  // immediately, regardless of the negative cache below.
  const local = await resolveManagedSubject(userId);

  if (local.kind === "linked") {
    unlinkedSubjectCache.delete(userId);
    return { kind: "linked", user: local.user, subject: userId };
  }

  if (local.kind === "suspended") {
    unlinkedSubjectCache.delete(userId);
    return { kind: "suspended", subject: userId };
  }

  const unlinked: ManagedSessionState = { kind: "unlinked", subject: userId };

  if (!isBootstrapConfigured()) {
    return unlinked;
  }

  if (isCachedUnlinked(userId, Date.now())) {
    return unlinked;
  }

  try {
    assertRequestAllowed(
      `managed-identity:${userId}`,
      UNLINKED_LOOKUPS_PER_SUBJECT_PER_MINUTE,
    );
    assertRequestAllowed(
      "managed-identity:*",
      UNLINKED_LOOKUPS_GLOBAL_PER_MINUTE,
    );
  } catch {
    return unlinked;
  }

  let identity: ManagedIdentity | null;

  try {
    identity = await getManagedIdentity();
  } catch {
    // Provider failure: do not cache, so the bootstrap path is retried once
    // the provider recovers (the throttle above still bounds the retries).
    return unlinked;
  }

  if (identity) {
    const bootstrapped = await resolveManagedUser(identity);

    if (bootstrapped.kind === "linked") {
      return { kind: "linked", user: bootstrapped.user, subject: userId };
    }

    if (bootstrapped.kind === "suspended") {
      return { kind: "suspended", subject: userId };
    }
  }

  rememberUnlinked(userId, Date.now());
  return unlinked;
}

export async function getManagedSessionUser(): Promise<SessionUser | null> {
  const state = await getManagedSessionState();
  return state.kind === "linked" ? state.user : null;
}

const MFA_CACHE_TTL_MS = 60_000;
/** Provider failures are denied but retried soon, not pinned for a minute. */
const MFA_ERROR_CACHE_TTL_MS = 3_000;
const MAX_MFA_CACHE_ENTRIES = 1_000;
const mfaEnrollmentCache = new Map<
  string,
  { enrolled: boolean; at: number; ttl: number }
>();

function rememberMfaEnrollment(
  subject: string,
  entry: { enrolled: boolean; at: number; ttl: number },
): void {
  if (
    mfaEnrollmentCache.size >= MAX_MFA_CACHE_ENTRIES &&
    !mfaEnrollmentCache.has(subject)
  ) {
    mfaEnrollmentCache.clear();
  }

  mfaEnrollmentCache.set(subject, entry);
}

export function isAdminMfaRequired(): boolean {
  return (
    isManagedAuthMode() && process.env.LUBAN_REQUIRE_ADMIN_MFA !== "false"
  );
}

/**
 * Whether the managed account has any second factor enrolled, per the
 * provider. Cached briefly per subject so admin polling does not turn into a
 * Backend API call per request. A provider failure counts as NOT enrolled:
 * the gate must fail closed. That failure is cached only for a few seconds so
 * a transient provider error cannot lock every host out for the full TTL.
 */
export async function hasManagedMfaEnrolled(subject: string): Promise<boolean> {
  const cached = mfaEnrollmentCache.get(subject);
  const now = Date.now();

  if (cached && now - cached.at < cached.ttl) {
    return cached.enrolled;
  }

  let enrolled = false;
  let ttl = MFA_CACHE_TTL_MS;

  try {
    const client = await clerkClient();
    const user = await client.users.getUser(subject);
    enrolled = user.twoFactorEnabled === true;
  } catch {
    enrolled = false;
    ttl = MFA_ERROR_CACHE_TTL_MS;
  }

  rememberMfaEnrollment(subject, { enrolled, at: now, ttl });
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

  rememberMfaEnrollment(subject, {
    enrolled: enrolled === true,
    at: Date.now(),
    ttl: MFA_CACHE_TTL_MS,
  });
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

  const { userId, sessionClaims } = await auth();
  const secondFactorAge = sessionClaims?.fva?.[1];

  if (
    !userId ||
    typeof secondFactorAge !== "number" ||
    !Number.isFinite(secondFactorAge) ||
    secondFactorAge < 0 ||
    !(await hasManagedMfaEnrolled(userId))
  ) {
    throw new AppError(
      "MFA_REQUIRED",
      "Host accounts must enable multi-factor authentication and sign in with a second factor. Open Account security to enroll, then sign in again.",
      403,
    );
  }
}
