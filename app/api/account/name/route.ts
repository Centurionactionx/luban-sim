import { z } from "zod";

import { assertRequestAllowed, isManagedAuthMode, updateDisplayName } from "@/lib";

import {
  handleRouteError,
  json,
  parseJson,
  requireAuthenticatedUser,
  requireTrustedOrigin,
} from "../../_lib/http";

export const dynamic = "force-dynamic";

const nameSchema = z.object({ name: z.string().max(500) }).strict();

/**
 * A name to pre-fill the "Set your name" prompt with: the one on the
 * caller's sign-in provider profile (for example their Google name).
 */
export async function GET(): Promise<Response> {
  try {
    const user = await requireAuthenticatedUser();
    assertRequestAllowed(`display-name-suggestion:${user.id}`, 10);
    let suggestedName: string | null = null;
    if (isManagedAuthMode()) {
      const { getManagedIdentity } = await import("@/lib/server/managed-identity");
      suggestedName = (await getManagedIdentity())?.name ?? null;
    }
    return json({ ok: true, suggestedName });
  } catch (error) {
    return handleRouteError(error);
  }
}

/** Changes the caller's own display name. */
export async function PATCH(request: Request): Promise<Response> {
  try {
    requireTrustedOrigin(request);
    const user = await requireAuthenticatedUser();
    assertRequestAllowed(`display-name:${user.id}`, 10);
    const { name } = nameSchema.parse(await parseJson(request));
    const updated = await updateDisplayName({ userId: user.id, name });

    return json({ ok: true, user: { name: updated.name, initials: updated.initials } });
  } catch (error) {
    return handleRouteError(error);
  }
}
