import { z } from "zod";

import { assertRequestAllowed, updateDisplayName } from "@/lib";

import {
  handleRouteError,
  json,
  parseJson,
  requireAuthenticatedUser,
  requireTrustedOrigin,
} from "../../_lib/http";

export const dynamic = "force-dynamic";

const nameSchema = z.object({ name: z.string().max(500) }).strict();

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
