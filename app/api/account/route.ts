import { z } from "zod";

import {
  AppError,
  assertRequestAllowed,
  deleteOwnAccount,
  isManagedAuthMode,
} from "@/lib";

import {
  ApiError,
  handleRouteError,
  json,
  parseJson,
  requireAuthenticatedUser,
  requireTrustedOrigin,
} from "../_lib/http";

export const dynamic = "force-dynamic";

/** The word the person types to confirm, exactly as shown to them. */
const DELETE_CONFIRMATION_WORD = "DELETE";

const deleteSchema = z
  .object({
    confirmation: z.literal(DELETE_CONFIRMATION_WORD, {
      error: `Type ${DELETE_CONFIRMATION_WORD} to confirm.`,
    }),
  })
  .strict();

/**
 * Deletes the caller's own account.
 *
 * Managed mode runs two steps, in this order:
 * 1. One database transaction removes the Luban account, or anonymizes it
 *    when it has trades on a team ledger (deleteOwnAccount).
 * 2. The Clerk user is deleted, which also ends every session.
 * If step 2 fails, the person is still signed in to Clerk but no longer
 * linked to an account, so their retry arrives "unlinked" and repeats only
 * step 2. The reverse order would be worse: a failed step 1 after step 2
 * would leave a Luban account nobody can sign in to, and so nobody can
 * delete.
 *
 * Demo mode refuses: demo identities are seeded samples shared by everyone.
 */
export async function DELETE(request: Request): Promise<Response> {
  try {
    requireTrustedOrigin(request);

    if (!isManagedAuthMode()) {
      await requireAuthenticatedUser();
      deleteSchema.parse(await parseJson(request));
      throw new ApiError(
        403,
        "DEMO_IDENTITY",
        "Demo identities are shared sample accounts and can't be deleted.",
      );
    }

    const { deleteManagedIdentity, getManagedSessionState } = await import(
      "@/lib/server/managed-identity"
    );
    const state = await getManagedSessionState();

    if (state.kind === "signed-out") {
      throw new ApiError(401, "UNAUTHENTICATED", "Sign in to continue.");
    }

    if (state.kind === "suspended") {
      throw new ApiError(
        403,
        "ACCOUNT_SUSPENDED",
        "This account is suspended. Ask your competition host to delete it.",
      );
    }

    assertRequestAllowed(`account-delete:${state.subject}`, 5);
    deleteSchema.parse(await parseJson(request));

    // Unlinked: a sign-in that never joined (or no longer has) a Luban
    // account, including a retry after step 2 failed. Only step 2 remains.
    const mode =
      state.kind === "linked"
        ? (await deleteOwnAccount(state.user.id)).mode
        : ("sign-in-only" as const);

    try {
      await deleteManagedIdentity(state.subject);
    } catch (error) {
      console.error("Deleting the Clerk user failed", error);
      throw new AppError(
        "SIGN_IN_DELETE_FAILED",
        mode === "sign-in-only"
          ? "Your sign-in couldn't be removed. Try again in a moment."
          : "Your Market Lab account was deleted, but your sign-in couldn't be removed. Try again in a moment to finish.",
        502,
        { retryAfterSeconds: 5 },
      );
    }

    return json({ ok: true, mode });
  } catch (error) {
    return handleRouteError(error);
  }
}
