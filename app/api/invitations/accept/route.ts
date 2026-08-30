import { z } from "zod";

import { consumeInvitation, isManagedAuthMode } from "@/lib";

import {
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
    if (!isManagedAuthMode()) {
      return errorResponse(
        404,
        "AUTH_MODE_DEMO",
        "Invitations can only be redeemed on the managed deployment.",
      );
    }

    const { token } = acceptSchema.parse(await parseJson(request));

    const { getManagedIdentity } = await import(
      "@/lib/server/managed-identity"
    );
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
