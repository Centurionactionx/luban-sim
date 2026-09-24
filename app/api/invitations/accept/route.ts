import { z } from "zod";

import { assertRequestAllowed, consumeInvitation, isManagedAuthMode } from "@/lib";

import {
  requireTrustedOrigin,
  errorResponse,
  handleRouteError,
  json,
  parseJson,
} from "../../_lib/http";

export const dynamic = "force-dynamic";

const acceptSchema = z
  .object({
    token: z.string().trim().min(20).max(256),
  })
  .strict();

export async function POST(request: Request): Promise<Response> {
  try {
    requireTrustedOrigin(request);
    if (!isManagedAuthMode()) {
      return errorResponse(
        404,
        "AUTH_MODE_DEMO",
        "Invitations can only be redeemed on the managed deployment.",
      );
    }

    const { token } = acceptSchema.parse(await parseJson(request));

    const { getManagedIdentity, getManagedUserId } = await import(
      "@/lib/server/managed-identity"
    );

    // Each attempt makes a Clerk Backend API call; throttle by the verified
    // session subject (no network) so a signed-in user cannot loop this into
    // a Clerk-quota drain. Anonymous callers share one small bucket.
    const subject = await getManagedUserId();
    assertRequestAllowed(`invite-accept:${subject ?? "anon"}`, subject ? 12 : 20);

    const identity = await getManagedIdentity();

    if (!identity) {
      return errorResponse(
        401,
        "UNAUTHENTICATED",
        "Sign in before accepting an invitation.",
      );
    }

    const user = await consumeInvitation(token, identity);

    return json({ ok: true, user }, { status: 201 });
  } catch (error) {
    return handleRouteError(error);
  }
}
